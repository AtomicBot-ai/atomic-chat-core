/**
 * How the owner builds the decision service: the settings section, the engine gate over the data
 * folder, the CPU facts from the hardware service, and the child journal (a decision process is
 * journalled like any backend, under `provider: 'decision'`, from the moment it spawns until it is
 * gone). Kept out of `create.ts`, which stays a list of `await`s.
 */

import type { DataLayout } from '../config/index.js'
import type { CoreEvents, DecisionSettings, HardwareInfoResponse } from '../contracts/index.js'
import { processStartId } from '../lock/index.js'
import type { ProcessJournal } from '../lock/index.js'
import type { BackendOutputSink } from '../runtime/shared/index.js'
import type { ThreadFacts } from './args.js'
import { DECISION_ENGINE_PROVIDER, DecisionEngineResolver } from './engine.js'
import type { EngineResolverDeps } from './engine.js'
import { createDecisionHttp } from './http.js'
import type { DecisionHttp } from './http.js'
import { spawnDecisionServer } from './process.js'
import type { DecisionProcessHandle, DecisionServerSpec, SpawnDecisionDeps } from './process.js'
import { DecisionService } from './service.js'
import type { DecisionServiceDeps } from './service.js'

export interface WireDecisionOptions {
  layout: DataLayout
  settings: {
    readonly decision: DecisionSettings
    updateDecision(patch: Record<string, unknown>): Promise<unknown>
  }
  journal: Pick<ProcessJournal, 'add' | 'remove'>
  instanceId: string
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  /** The core's event bus: a finished TurboQuant install lets an `unsupported` or `failed` module retry. */
  on?: (
    name: 'backend:download-finished',
    listener: (payload: CoreEvents['backend:download-finished']) => void
  ) => () => void
  log: (level: 'info' | 'warn' | 'debug', msg: string) => void
  hardware?: { info(): Promise<HardwareInfoResponse> }
  backendOutput?: BackendOutputSink
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Test seams, straight through. */
  overrides?: {
    http?: DecisionHttp
    spawn?: SpawnDecisionDeps['spawn']
    listPacks?: EngineResolverDeps['listPacks']
    probe?: EngineResolverDeps['probe']
    schedule?: DecisionServiceDeps['schedule']
  }
}

/** The journal record a decision process gets as soon as it starts, so a crashed owner's successor can reap it. */
export function decisionJournal(
  journal: Pick<ProcessJournal, 'add' | 'remove'>,
  instanceId: string,
  now: () => number = Date.now
): {
  add(pid: number, port: number, exe: string, modelId: string): Promise<void>
  remove(pid: number): Promise<void>
} {
  return {
    add: async (pid, port, exe, modelId) =>
      journal.add({
        instance_id: instanceId,
        pid,
        process_start_id: (await processStartId(pid)) ?? null,
        exe,
        provider: 'decision',
        model_id: modelId,
        port,
        started_at: new Date(now()).toISOString(),
      }),
    remove: (pid) => journal.remove(pid),
  }
}

/**
 * CPU facts for the thread count, out of the hardware service. Apple silicon is hybrid and its
 * performance-core count is not in the facts yet, which `decisionThreads` accounts for. Intel hybrid
 * parts (Alder Lake and later, P + E cores) are not recognised: `SystemInfo.cpu` carries no core
 * types, so they get the full physical count, capped at `MAX_AUTO_THREADS`, and some threads may land
 * on E-cores. A performance-core count in the hardware facts would fix both.
 */
export function cpuFactsOf(info: HardwareInfoResponse | undefined): Omit<ThreadFacts, 'setting'> {
  const cpu = info?.info.cpu
  if (!cpu) return { physicalCores: 1 }
  const appleSilicon = info.info.os_type === 'macos' && /^(aarch64|arm64)$/.test(cpu.arch)
  return { physicalCores: cpu.core_count, ...(appleSilicon ? { hybrid: true } : {}) }
}

/**
 * A backend install finished: a TurboQuant build lets an `unsupported` or `failed` module try again
 * (`DecisionService.onEnginesChanged`). Fire and forget, and never an unhandled rejection. Shared by
 * the event bus (installs made by the app) and the owner's own control route, which emits no event.
 */
export function noticeEngineInstall(
  service: Pick<DecisionService, 'onEnginesChanged'>,
  provider: string,
  installed: boolean
): void {
  if (provider === DECISION_ENGINE_PROVIDER && installed) void service.onEnginesChanged().catch(() => {})
}

export function wireDecision(options: WireDecisionOptions): DecisionService {
  const http = options.overrides?.http ?? createDecisionHttp()
  const journal = decisionJournal(options.journal, options.instanceId)
  const resolver = new DecisionEngineResolver({
    layout: options.layout,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.overrides?.listPacks ? { listPacks: options.overrides.listPacks } : {}),
    ...(options.overrides?.probe ? { probe: options.overrides.probe } : {}),
    log: options.log,
  })
  const spawn = async (spec: DecisionServerSpec, signal: AbortSignal): Promise<DecisionProcessHandle> => {
    const modelId = spec.modelId ?? 'decision'
    const handle = await spawnDecisionServer(spec, {
      http,
      signal,
      log: options.log,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
      ...(options.overrides?.spawn ? { spawn: options.overrides.spawn } : {}),
      onSpawned: (pid, port, exe) => journal.add(pid, port, exe, modelId),
      onGone: (pid) => journal.remove(pid).catch(() => {}),
    })
    // From now on the process leaves the journal when it exits, whether it crashed or was stopped.
    void handle.exited.then(() => journal.remove(handle.pid).catch(() => {}))
    return handle
  }
  const service = new DecisionService({
    dataFolder: options.layout.root,
    readSettings: () => options.settings.decision,
    writeSettings: (patch) => options.settings.updateDecision(patch),
    resolveEngine: (enginePath, needs) => resolver.resolve(enginePath, needs),
    rejectEngine: (exe, why) => resolver.reject(exe, why),
    forgetRejectedEngines: () => resolver.forgetRejected(),
    cpu: async () => cpuFactsOf(await options.hardware?.info().catch(() => undefined)),
    spawn,
    http,
    emit: options.emit,
    log: options.log,
    ...(options.overrides?.schedule ? { schedule: options.overrides.schedule } : {}),
  })
  options.on?.('backend:download-finished', (event) =>
    noticeEngineInstall(service, event.provider, event.success)
  )
  // Not started here: the owner calls `start()` once the facade exists, so a core that fails to
  // come up never leaves a decision process behind.
  return service
}
