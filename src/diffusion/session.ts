/**
 * Session lifecycle: bringing `sd-server` up from a `ServerSpec`, tearing it down, and describing
 * the result as the status and capabilities the app reads. Every state change here emits
 * `diffusion:state`. Port of `session.rs` in `tauri-plugin-atomic-diffusion` (app commit `ec1fd3ea7`).
 */

import { stat } from 'node:fs/promises'
import type {
  CoreEvents,
  DiffusionBackendInstallRecord,
  DiffusionEngineInstall,
  DiffusionErrorBody,
  DiffusionModelFiles,
  DiffusionStatus,
  ImageCapabilities,
  LoadedDiffusionModel,
  VideoCapabilities,
} from '../contracts/index.js'
import { checkEngineCompatibility } from './compat.js'
import { samePath } from './containment.js'
import { diffusionError, errorBody, modelNotLoadedError, toDiffusionError } from './errors.js'
import { listInstalledBackends } from './install.js'
import type { DiffusionState, ServerHandle } from './state.js'
import { MAX_BATCH, MODEL_FILE_KEYS } from './types.js'
import type { ModelFileBytes, ServerSpec } from './types.js'
import { videoWorkflowsForFamily, workflowsForSpec } from './workflow.js'

/** CUDA and ROCm need a moment after the chat model's process dies before the driver reports the VRAM as free. */
export const GPU_SETTLE_MS = 500
/** App exit: a short grace, then the kill. */
export const SHUTDOWN_GRACE_MS = 2_000

export type DiffusionEventName =
  | 'diffusion:state'
  | 'diffusion:progress'
  | 'diffusion:job'
  | 'diffusion:error'
  | 'diffusion:video-progress'
  | 'diffusion:video-job'
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
  /** A file's size in bytes, `undefined` when it cannot be read. Default: `statFileSize`. */
  fileSize?: (path: string) => Promise<number | undefined>
}

/** A regular file's size, or `undefined` when it is missing or not a file. */
export const statFileSize = (path: string): Promise<number | undefined> =>
  stat(path).then(
    (s) => (s.isFile() ? s.size : undefined),
    () => undefined
  )

/** The size of every file `files` names; one that cannot be read is left out. */
export async function modelFileBytes(
  files: DiffusionModelFiles,
  fileSize: (path: string) => Promise<number | undefined> = statFileSize
): Promise<ModelFileBytes> {
  const bytes: ModelFileBytes = {}
  await Promise.all(
    MODEL_FILE_KEYS.map(async (key) => {
      const path = files[key]
      if (path === undefined) return
      const size = await fileSize(path)
      if (size !== undefined) bytes[key] = size
    })
  )
  return bytes
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
    activeVideoJob: state.activeVideoJob(),
    outputDir: state.outputDir(),
    videoOutputDir: state.videoOutputDir(),
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
  if (spec.modality !== 'image')
    throw diffusionError('MODEL_INCOMPATIBLE', 'The loaded model generates video, not images.', spec.modelId)
  return {
    workflows: workflowsForSpec(spec),
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

/** The video counterpart of `capabilities`; an image spec is refused, so the app's form never guesses. */
export function videoCapabilities(state: DiffusionState): VideoCapabilities {
  const spec = state.spec
  if (!spec) throw modelNotLoadedError()
  const video = spec.defaults.video
  const range = spec.ranges.frames
  if (spec.modality !== 'video' || video === undefined || range === undefined)
    throw diffusionError('MODEL_INCOMPATIBLE', 'The loaded model generates images, not video.', spec.modelId)
  const vidGen = state.session?.server.capabilities.vidGen
  const formats = vidGen?.outputFormats
  return {
    workflows: videoWorkflowsForFamily(spec.family),
    minDim: spec.ranges.dims[0],
    maxDim: spec.ranges.dims[1],
    dimMultiple: spec.ranges.dimMultiple,
    supportsNegativePrompt: spec.defaults.cfgScale > 1.0,
    supportsGuidance: spec.defaults.guidance !== undefined,
    cancelGenerating: vidGen?.cancelGenerating ?? false,
    fps: video.fps,
    frames: {
      min: range[0],
      max: range[1],
      step: video.frameStep,
      offset: video.frameOffset,
      default: video.frames,
    },
    resolutionPresets: video.resolutionPresets.map(([w, h]) => [w, h]),
    outputFormat: 'webm',
    webmSupported: formats === undefined ? null : formats.includes('webm'),
    defaults: structuredClone(spec.defaults),
    ranges: structuredClone(spec.ranges),
  }
}

/**
 * The spec to run after `spec` ran out of memory: its offload fallback, dropped once taken so a second
 * shortage is reported rather than retried. `undefined` when there is none.
 */
export function withOffloadFallback(spec: ServerSpec): ServerSpec | undefined {
  const { offloadFallback, ...rest } = spec
  if (offloadFallback === undefined || offloadFallback === spec.offload) return undefined
  return { ...rest, offload: offloadFallback }
}

const settleGpu = async (deps: SessionDeps, spec: ServerSpec): Promise<void> => {
  if (spec.backend === 'cuda' || spec.backend === 'rocm') await deps.sleep(GPU_SETTLE_MS)
}

/** Spawn `spec`; when it runs out of memory loading and has an offload fallback, spawn that instead. */
async function spawnFallingBack(
  deps: SessionDeps,
  spec: ServerSpec,
  signal?: AbortSignal
): Promise<{ server: ServerHandle; spec: ServerSpec }> {
  const scratchDir = deps.state.paths.scratchDir
  try {
    return { server: await deps.spawn(spec, scratchDir, signal), spec }
  } catch (raw) {
    const fallback = withOffloadFallback(spec)
    if (!fallback || signal?.aborted || toDiffusionError(raw).code !== 'OUT_OF_MEMORY') throw raw
    deps.log(
      'warn',
      `sd-server ran out of memory loading under ${spec.offload} offload; retrying under ${fallback.offload}`
    )
    await settleGpu(deps, fallback)
    return { server: await deps.spawn(fallback, scratchDir, signal), spec: fallback }
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
  await settleGpu(deps, spec)

  // A load reads the sizes the video estimate weighs, once; a respawn of the kept spec reuses them.
  const fileBytes =
    reason === 'load' || state.modelFileBytes === undefined
      ? await modelFileBytes(spec.files, deps.fileSize)
      : state.modelFileBytes

  let started: { server: ServerHandle; spec: ServerSpec }
  try {
    // A retained spec can name an engine build that an update has since made too old for it.
    checkEngineCompatibility(spec.family, spec.tag)
    started = await spawnFallingBack(deps, spec, signal)
  } catch (raw) {
    const error = toDiffusionError(raw)
    const body = errorBody(error)
    state.setModelState('failed', body)
    await emitState(deps, 'load-failed')
    emitError(deps, undefined, body)
    throw error
  }

  // What runs, which is `spec` unless loading it ran out of memory and its fallback took over.
  const { server, spec: running } = started
  const info: LoadedDiffusionModel = {
    modelId: running.modelId,
    family: running.family,
    modality: running.modality,
    displayName: running.displayName,
    engine: running.engine,
    backend: running.backend,
    offload: running.offload,
    cpuFallback: running.cpuFallback,
    port: server.port,
    pid: server.pid,
    loadedAtMs: deps.now(),
  }
  state.session = { server, info, spec: running, baseUrl: `http://127.0.0.1:${server.port}` }
  state.spec = running
  state.modelFileBytes = fileBytes
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
  state.modelFileBytes = undefined
  state.clearIdle()
  state.setModelState('unloaded')
  await emitState(deps, reason)
}

/**
 * A finished engine install that replaces the tree the spec runs from invalidates both a resident
 * server and a spec kept after an idle unload or a crash: unload, so no job respawns the old binary.
 * The caller holds the load lock and has cancelled any running job.
 */
export async function activateInstall(
  deps: SessionDeps,
  record: DiffusionBackendInstallRecord
): Promise<void> {
  const spec = deps.state.spec
  if (!spec || spec.engine !== record.engine) return
  if (spec.tag === record.tag && (await samePath(spec.binaryDir, record.dir, deps.platform))) return
  await unload(deps, 'engine-updated')
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
