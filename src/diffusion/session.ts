/**
 * Session lifecycle: bringing `sd-server` up from a `ServerSpec`, tearing it down, and describing
 * the result as the status and capabilities the app reads. Every state change here emits
 * `diffusion:state`. Port of `session.rs` in `tauri-plugin-atomic-diffusion` (app commit `767ff6350`).
 */

import type {
  CoreEvents,
  DiffusionEngineInstall,
  DiffusionErrorBody,
  DiffusionStatus,
  ImageCapabilities,
  LoadedDiffusionModel,
} from '../contracts/index.js'
import { samePath } from './containment.js'
import { errorBody, modelNotLoadedError, toDiffusionError } from './errors.js'
import { listInstalledBackends } from './install.js'
import type { DiffusionState, ServerHandle } from './state.js'
import { MAX_BATCH } from './types.js'
import type { ServerSpec } from './types.js'
import { workflowsForFamily } from './workflow.js'

/** CUDA and ROCm need a moment after the chat model's process dies before the driver reports the VRAM as free. */
export const GPU_SETTLE_MS = 500
/** App exit: a short grace, then the kill. */
export const SHUTDOWN_GRACE_MS = 2_000

export type DiffusionEventName =
  'diffusion:state' | 'diffusion:progress' | 'diffusion:job' | 'diffusion:error'
export type DiffusionEmitter = <K extends DiffusionEventName>(name: K, payload: CoreEvents[K]) => void
export type DiffusionLogger = (level: 'info' | 'warn' | 'debug', msg: string) => void

export interface SessionDeps {
  state: DiffusionState
  emit: DiffusionEmitter
  log: DiffusionLogger
  platform: NodeJS.Platform
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Bring a server up for `spec`; rejects with the server dead. */
  spawn: (spec: ServerSpec, scratchDir: string, signal?: AbortSignal) => Promise<ServerHandle>
  /** The child is gone (or was never journalled); forget it. */
  onServerGone?: (pid: number) => Promise<void>
}

/** The install the status reports: the resident spec's tree when there is one, otherwise the newest. */
export async function currentInstall(
  deps: Pick<SessionDeps, 'state' | 'platform'>
): Promise<DiffusionEngineInstall> {
  const records = await listInstalledBackends(deps.state.paths.backendsDir, deps.platform)
  let chosen = records[0]
  const spec = deps.state.spec
  if (spec)
    for (const record of records)
      if (await samePath(record.dir, spec.binaryDir, deps.platform)) {
        chosen = record
        break
      }
  if (!chosen) return { state: 'not-installed' }
  return {
    state: 'installed',
    engine: chosen.engine,
    backend: chosen.backend,
    tag: chosen.tag,
    backendId: chosen.backendId,
    dir: chosen.dir,
  }
}

/** Snapshot for `getStatus` and the `state` event. */
export async function buildStatus(deps: Pick<SessionDeps, 'state' | 'platform'>): Promise<DiffusionStatus> {
  const { state } = deps
  const model: DiffusionStatus['model'] = {
    state: state.modelState,
    loaded: state.modelState === 'loaded' && state.session ? { ...state.session.info } : null,
  }
  if (state.modelError) model.error = state.modelError
  return {
    configured: state.configured,
    install: state.configured ? await currentInstall(deps) : { state: 'not-installed' },
    model,
    activeJob: state.activeJob(),
    outputDir: state.outputDir(),
    idleUnloadSecs: state.idleUnloadSecs(),
  }
}

export async function emitState(deps: SessionDeps, reason: string): Promise<void> {
  deps.emit('diffusion:state', { status: await buildStatus(deps), reason })
}

export function emitError(
  deps: Pick<SessionDeps, 'emit'>,
  jobId: string | undefined,
  error: DiffusionErrorBody
): void {
  const payload: CoreEvents['diffusion:error'] = { code: error.code, message: error.message }
  if (jobId !== undefined) payload.jobId = jobId
  if (error.details !== undefined) payload.details = error.details
  deps.emit('diffusion:error', payload)
}

export function capabilities(state: DiffusionState): ImageCapabilities {
  const spec = state.spec
  if (!spec) throw modelNotLoadedError()
  return {
    workflows: workflowsForFamily(spec.family),
    minDim: spec.ranges.dims[0],
    maxDim: spec.ranges.dims[1],
    dimMultiple: spec.ranges.dimMultiple,
    supportsNegativePrompt: spec.defaults.cfgScale > 1.0,
    supportsGuidance: spec.defaults.guidance !== undefined,
    cancelGenerating: state.session?.server.capabilities.cancelGenerating ?? false,
    maxBatch: MAX_BATCH,
    defaults: { ...spec.defaults },
    ranges: {
      steps: [...spec.ranges.steps],
      dims: [...spec.ranges.dims],
      dimMultiple: spec.ranges.dimMultiple,
    },
  }
}

/**
 * Spawn the server for `spec` and make it the resident session. The caller holds the load lock,
 * and any previous session is already gone.
 */
export async function loadFromSpec(
  deps: SessionDeps,
  spec: ServerSpec,
  reason: string,
  signal?: AbortSignal
): Promise<LoadedDiffusionModel> {
  const { state } = deps
  state.setModelState('loading')
  await emitState(deps, reason)
  if (spec.backend === 'cuda' || spec.backend === 'rocm') await deps.sleep(GPU_SETTLE_MS)

  let server: ServerHandle
  try {
    server = await deps.spawn(spec, state.paths.scratchDir, signal)
  } catch (raw) {
    const error = toDiffusionError(raw)
    const body = errorBody(error)
    state.setModelState('failed', body)
    await emitState(deps, 'load-failed')
    emitError(deps, undefined, body)
    throw error
  }

  const info: LoadedDiffusionModel = {
    modelId: spec.modelId,
    family: spec.family,
    modality: spec.modality,
    displayName: spec.displayName,
    engine: spec.engine,
    backend: spec.backend,
    offload: spec.offload,
    cpuFallback: spec.cpuFallback,
    port: server.port,
    pid: server.pid,
    loadedAtMs: deps.now(),
  }
  state.session = { server, info, spec, baseUrl: `http://127.0.0.1:${server.port}` }
  state.spec = spec
  state.setModelState('loaded')
  state.touchIdle()
  await emitState(deps, 'loaded')
  return { ...info }
}

/**
 * Take the session out of the state and terminate it. Whether one was running. Touches neither the
 * spec nor the model state: callers decide what the teardown means.
 */
export async function takeDownSession(deps: SessionDeps, graceMs?: number): Promise<boolean> {
  const { state } = deps
  const session = state.session
  if (!session) return false
  state.session = undefined
  session.server.setLineListener(undefined)
  await session.server.terminate(graceMs)
  await deps.onServerGone?.(session.server.pid)
  return true
}

/** Explicit unload: stop the server, forget the spec, report `unloaded`. */
export async function unload(deps: SessionDeps, reason: string): Promise<void> {
  const { state } = deps
  if (state.modelState === 'loaded') {
    state.setModelState('unloading')
    await emitState(deps, reason)
  }
  await takeDownSession(deps)
  state.spec = undefined
  state.clearIdle()
  state.setModelState('unloaded')
  await emitState(deps, reason)
}

/** The server was stopped but the spec stays: the next job respawns it. */
export async function stopKeepingSpec(
  deps: SessionDeps,
  reason: string,
  error?: DiffusionErrorBody
): Promise<void> {
  const { state } = deps
  await takeDownSession(deps)
  state.clearIdle()
  if (error) state.setModelState('failed', error)
  else state.setModelState('unloaded')
  await emitState(deps, reason)
}

/** Owner exit: no events, no waiting beyond a short grace. */
export async function shutdownSession(deps: SessionDeps): Promise<void> {
  await takeDownSession(deps, SHUTDOWN_GRACE_MS)
}
