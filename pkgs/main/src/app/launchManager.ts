import * as maa from '@maaxyz/maa-node'
import {
    Interface,
    LaunchId,
    LaunchInfo,
    LaunchStatus,
    ProfileId,
    StageInfo,
    TaskInfo
} from '@mfg/types'
import * as child_process from 'child_process'
import * as path from 'path'

import { generateId } from '../utils/uuid'
import { mfgApp } from './app'

export class MfgLaunchManager {
    launchIndex: Record<ProfileId, LaunchId> = {}
    launchInfo: Record<LaunchId, LaunchInfo> = {}

    async init() {
        main.launch.new = async id => {
            const profile = mfgApp.config.profiles?.find(x => x.id === id)
            if (!profile) {
                return
            }
            if (this.launchIndex[id]) {
                return
            }
            const lid = generateId() as LaunchId
            this.launchIndex[id] = lid
            this.launchInfo[lid] = {
                id: lid,
                status: {
                    profile: id,

                    stages: {},
                    tasks: {}
                },
                instance: {}
            }
            await renderer.launch.updateIndex(this.launchIndex)
            await renderer.launch.updateStatus(lid, this.launchInfo[lid].status)
            this.launch(id)
        }
        main.launch.stop = async id => {
            const launch = this.launchInfo[id]
            if (!launch) {
                return
            }
            launch.instance.postStop = launch.instance.tasker?.post_stop().wait().done

            launch.status.stopped = true
            await renderer.launch.updateStatus(id, launch.status)
        }
        main.launch.del = async id => {
            const launch = this.launchInfo[id]
            if (!launch) {
                return
            }
            if (!launch.status.stopped) {
                return
            }
            delete this.launchIndex[launch.status.profile]
            delete this.launchInfo[id]

            await renderer.launch.updateIndex(this.launchIndex)
            await renderer.launch.updateStatus(id)
        }
        main.launch.syncIndex = () => {
            return this.launchIndex
        }
        main.launch.syncStatus = () => {
            return Object.fromEntries(
                Object.entries(this.launchInfo).map(
                    ([lid, info]) => [lid, info.status] as [LaunchId, LaunchStatus]
                )
            )
        }
    }

    async launch(pid: ProfileId) {
        const profile = mfgApp.config.profiles?.find(x => x.id === pid)
        if (!profile) {
            console.log('no profile')
            return
        }
        const lid = this.launchIndex[pid]
        if (!lid) {
            console.log('no launch')
            return
        }
        const launch = this.launchInfo[lid]
        for (const stage of profile.stages) {
            if (launch.status.stopped) {
                break
            }

            if (!(await this.launchStage(launch, stage))) {
                break
            }
        }

        launch.status.stopped = true
        await renderer.launch.updateStatus(lid, launch.status)
    }

    async launchStage(launch: LaunchInfo, stage: StageInfo) {
        launch.status.stages[stage.id] = 'running'
        await renderer.launch.updateStatus(launch.id, launch.status)

        const result = await this.launchStageImpl(launch, stage)
        launch.status.stages[stage.id] = result ? 'succeeded' : 'failed'
        await renderer.launch.updateStatus(launch.id, launch.status)

        await this.resetInstance(launch)

        return result
    }

    async launchStageImpl(launch: LaunchInfo, stage: StageInfo) {
        if (!stage.project) {
            console.log('no project')
            return false
        }

        const interfaceData = await mfgApp.projectManager.loadInterface(stage.project)
        if (!interfaceData) {
            console.log('no interface')
            return false
        }

        launch.status.tasks[stage.id] = 'running'
        await renderer.launch.updateStatus(launch.id, launch.status)

        if (!(await this.prepareInstance(launch, stage, interfaceData))) {
            launch.status.tasks[stage.id] = 'failed'
            console.log('build instance failed')
            return false
        }

        launch.status.tasks[stage.id] = 'succeeded'
        await renderer.launch.updateStatus(launch.id, launch.status)

        for (const task of stage.tasks ?? []) {
            if (launch.status.stopped) {
                return false
            }

            launch.status.tasks[task.id] = 'running'
            await renderer.launch.updateStatus(launch.id, launch.status)

            const result = await this.launchTask(launch, stage, task, interfaceData)

            launch.status.tasks[task.id] = result ? 'succeeded' : 'failed'
            await renderer.launch.updateStatus(launch.id, launch.status)

            if (!result) {
                return false
            }
        }

        return true
    }

    async resetInstance(launch: LaunchInfo) {
        // 必须等待由于post_stop产生的任务完成，否则其回调会和这里的destroy死锁
        await launch.instance.postStop

        launch.instance.agent?.kill()
        launch.instance.agent = undefined

        launch.instance.tasker?.destroy()
        launch.instance.tasker = undefined
        launch.instance.controller?.destroy()
        launch.instance.controller = undefined

        launch.instance.client?.destroy()
        launch.instance.client = undefined

        launch.instance.resource?.destroy()
        launch.instance.resource = undefined
    }

    async prepareInstance(launch: LaunchInfo, stage: StageInfo, interfaceData: Interface) {
        const result = await this.prepareInstanceImpl(launch, stage, interfaceData)
        if (!result) {
            await this.resetInstance(launch)
        }
        return result
    }

    async prepareInstanceImpl(launch: LaunchInfo, stage: StageInfo, interfaceData: Interface) {
        const controllerMeta = interfaceData.controller.find(x => x.name === stage.controller)
        if (!controllerMeta) {
            return false
        }

        if (controllerMeta.type === 'Adb') {
            const dev = mfgApp.config.devices?.find(x => x.id === stage.adb)
            if (!dev) {
                return false
            }
            launch.instance.controller = new maa.AdbController(
                dev.adb_path,
                dev.address,
                controllerMeta.adb?.screencap ?? maa.api.AdbScreencapMethod.Default,
                controllerMeta.adb?.input ?? maa.api.AdbInputMethod.Default,
                JSON.stringify(controllerMeta.adb?.config ?? {})
            )

            if (!(await launch.instance.controller.post_connection().wait().succeeded)) {
                return false
            }
            if (!launch.instance.controller.connected) {
                return false
            }
        } else {
            return false
        }

        const resourceMeta = interfaceData.resource.find(x => x.name === stage.resource)
        if (!resourceMeta) {
            return false
        }

        const proj = mfgApp.config.projects?.find(x => x.id === stage.project)
        if (!proj) {
            return false
        }
        const projectDir = path.dirname(proj.path)

        launch.instance.resource = new maa.Resource()
        let resPaths = resourceMeta.path
        if (typeof resPaths === 'string') {
            resPaths = [resPaths]
        }
        resPaths = resPaths.map(p => p.replaceAll('{PROJECT_DIR}', projectDir))

        for (const resp of resPaths) {
            if (!(await launch.instance.resource.post_bundle(resp).wait().succeeded)) {
                return false
            }
        }

        if (interfaceData.agent && interfaceData.agent.child_exec) {
            launch.instance.client = new maa.AgentClient()
            const identifier = launch.instance.client.identifier ?? 'vsc-no-identifier'

            try {
                launch.instance.agent = child_process.spawn(
                    interfaceData.agent.child_exec.replaceAll('{PROJECT_DIR}', projectDir),
                    (interfaceData.agent.child_args ?? [])
                        .map(arg => arg.replaceAll('{PROJECT_DIR}', projectDir))
                        .concat([identifier]),
                    {
                        stdio: 'pipe',
                        shell: true,
                        cwd: projectDir,
                        env: {
                            MFG_AGENT: '1',
                            MFG_AGENT_ROOT: projectDir,
                            MFG_AGENT_RESOURCE: resPaths.join(path.delimiter)
                        }
                    }
                )
            } catch {
                return false
            }

            launch.instance.client.bind_resource(launch.instance.resource)

            if (
                !(await launch.instance.client.connect().then(
                    () => true,
                    () => false
                ))
            ) {
                return false
            }
        }

        launch.instance.tasker = new maa.Tasker()
        launch.instance.tasker.notify = (msg, detail) => {
            console.log(msg, detail)
        }
        launch.instance.tasker.bind(launch.instance.controller)
        launch.instance.tasker.bind(launch.instance.resource)

        if (!launch.instance.tasker.inited) {
            return false
        }

        return true
    }

    async launchTask(
        launch: LaunchInfo,
        stage: StageInfo,
        task: TaskInfo,
        interfaceData: Interface
    ) {
        const taskMeta = interfaceData.task.find(x => x.name === task.task)
        if (!taskMeta) {
            return false
        }

        const override: Record<string, Record<string, unknown>> = {}
        const applyOverride = (po?: unknown) => {
            if (po) {
                for (const [key, val] of Object.entries(po)) {
                    override[key] = Object.assign(override[key] ?? {}, val)
                }
            }
        }

        applyOverride(taskMeta.pipeline_override)
        for (const option of taskMeta.option ?? []) {
            const optionMeta = interfaceData.option?.[option]
            if (!optionMeta) {
                return false
            }

            const val = task.option?.[option] ?? optionMeta.default_case ?? optionMeta.cases[0].name
            const caseMeta = optionMeta.cases.find(x => x.name === val)
            if (!caseMeta) {
                return false
            }
            applyOverride(caseMeta.pipeline_override)
        }

        return await launch.instance.tasker?.post_task(taskMeta.entry, override).wait().succeeded
    }
}
