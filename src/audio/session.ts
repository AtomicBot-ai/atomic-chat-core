/**
 * Session lifecycle: bringing `audiocpp_server` up from a spec, tearing it down, and describing the
 * result as the status the client reads. Every state change here emits `audio:state`. The shape of
 * image generation's `session.ts`, without its offload and CPU fallbacks.
 */

import type {
  AudioBackendInstallRecord,
  AudioCapabilities,
  AudioEngineInstall,
  AudioErrorBody,
  AudioStatus,
  CoreEvents,
  LoadedAudioModel,
} from '../contracts/index.js'
import { samePath } from '../diffusion/index.js'
import type { GpuCards } from '../runtime/shared/index.js'
import { audioError, audioErrorBody, toAudioError } from './errors.js'
import { listInstalledAudioBuilds } from './install.js'
import type { AudioState } from './state.js'
import type { AudioServerHandle, AudioServerSpec } from './types.js'

/** CUDA needs a moment after another engine's process dies before the driver reports the VRAM as free. */
export const GPU_SETTLE_MS = 500
/** Owner exit: a short grace, then the kill. */
export const SHUTDOWN_GRACE_MS = 2_000

export type AudioEventName = 'audio:state' | 'audio:job' | 'audio:error'
export type AudioEmitter = <K extends AudioEventName>(name: K, payload: CoreEvents[K]) => void
export type AudioLogger = (level: 'info' | 'warn' | 'debug', msg: string) => void

export interface AudioSessionDeps {
  state: AudioState
  emit: AudioEmitter
  log: AudioLogger
  platform: NodeJS.Platform
  now: () => number
  sleep: (ms: number) => Promise<void>
  /** Bring a server up for `spec`; rejects with the server dead. */
  spawn: (spec: AudioServerSpec, signal?: AbortSignal) => Promise<AudioServerHandle>
  /** The child is gone (or was never journalled); forget it. */
  onServerGone?: (pid: number) => Promise<void>
  /**
   * Core's GPU residency: asked before every spawn — a load and a respawn alike — to free the GPU of
   * the other engines. Rejects (`GPU_BUSY`, a cancel) fail the load.
   */
  claimGpu?: (spec: AudioServerSpec, signal?: AbortSignal, granted?: () => void) => Promise<void>
}

export function modelNotLoadedError() {
  return audioError('MODEL_NOT_LOADED', 'No audio model is loaded. Load one first.')
}

/** Which GPUs an `audiocpp_server` holds: every card on a device backend, none on the CPU backend. */
export function audioGpuCards(spec: Pick<AudioServerSpec, 'backend'>): GpuCards {
  return spec.backend === 'cpu' ? [] : 'all'
}

/** The install the status reports: the resident spec's tree when there is one, otherwise the newest. */
export async function currentAudioInstall(
  deps: Pick<AudioSessionDeps, 'state' | 'platform'>
): Promise<AudioEngineInstall> {
  const records = await listInstalledAudioBuilds(deps.state.paths.backendsDir, deps.platform)
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
    backend: chosen.backend,
    tag: chosen.tag,
    backendId: chosen.backendId,
    dir: chosen.dir,
  }
}

/** Snapshot for `status` and the `state` event. */
export async function buildAudioStatus(
  deps: Pick<AudioSessionDeps, 'state' | 'platform'>
): Promise<AudioStatus> {
  const { state } = deps
  const model: AudioStatus['model'] = {
    state: state.modelState,
    loaded: state.modelState === 'loaded' && state.session ? { ...state.session.info } : null,
  }
  if (state.modelError) model.error = state.modelError
  return {
    install: await currentAudioInstall(deps),
    model,
    activeJob: state.activeJob(),
    outputDir: state.outputDir(),
    idleUnloadSecs: state.idleUnloadSecs,
  }
}

export async function emitAudioState(deps: AudioSessionDeps, reason: string): Promise<void> {
  deps.emit('audio:state', { status: await buildAudioStatus(deps), reason })
}

export function emitAudioError(
  deps: Pick<AudioSessionDeps, 'emit'>,
  jobId: string | undefined,
  error: AudioErrorBody
): void {
  const payload: CoreEvents['audio:error'] = { code: error.code, message: error.message }
  if (jobId !== undefined) payload.jobId = jobId
  if (error.details !== undefined) payload.details = error.details
  deps.emit('audio:error', payload)
}

/** What the loaded model takes, as its server declared it when it last came up. */
export function audioCapabilities(state: AudioState): AudioCapabilities {
  if (!state.spec || !state.capabilities) throw modelNotLoadedError()
  return structuredClone(state.capabilities)
}

/**
 * A load failure everywhere it is seen: the model state, the `state` event and the `error` event. A
 * load that `signal` stopped (an unload, a shutdown, a cancelled job's respawn) is no failure: the
 * model is `unloaded` and the error is `CANCELLED`, with no `error` event.
 */
export async function failLoad(
  deps: AudioSessionDeps,
  raw: unknown,
  reason: string,
  signal?: AbortSignal
): Promise<never> {
  if (signal?.aborted) {
    deps.state.setModelState('unloaded')
    await emitAudioState(deps, 'load-cancelled')
    throw audioError('CANCELLED', 'The audio model load was stopped.')
  }
  const error = toAudioError(raw)
  const body = audioErrorBody(error)
  deps.state.setModelState('failed', body)
  await emitAudioState(deps, reason)
  emitAudioError(deps, undefined, body)
  throw error
}

/**
 * Spawn the server for `spec` and make it the resident session. The caller holds the load lock, and
 * any previous session is already gone — or still exiting after a cancel or a crash outside the lock,
 * which is awaited before the claim and the spawn so two servers of this module never share the GPU.
 */
export async function loadFromSpec(
  deps: AudioSessionDeps,
  spec: AudioServerSpec,
  reason: string,
  signal?: AbortSignal
): Promise<LoadedAudioModel> {
  const { state } = deps
  state.setModelState('loading')
  await emitAudioState(deps, reason)

  let server: AudioServerHandle
  try {
    // `done` never rejects: an unconfirmed exit puts the server back as the session instead.
    await state.stopping?.done
    // From the moment the claim is granted this server holds the GPU as starting.
    const hold = () => {
      state.starting = spec
    }
    if (deps.claimGpu) await deps.claimGpu(spec, signal, hold)
    hold()
    if (spec.backend === 'cuda') await deps.sleep(GPU_SETTLE_MS)
    server = await deps.spawn(spec, signal)
  } catch (raw) {
    return failLoad(deps, raw, 'load-failed', signal)
  } finally {
    state.starting = undefined
  }

  const info: LoadedAudioModel = {
    modelId: spec.modelId,
    displayName: spec.displayName,
    mode: spec.mode,
    family: spec.family,
    task: spec.task,
    backend: spec.backend,
    tag: spec.tag,
    backendId: spec.backendId,
    port: server.port,
    pid: server.pid,
    loadedAtMs: deps.now(),
  }
  state.session = { server, info, spec, baseUrl: `http://127.0.0.1:${server.port}` }
  state.spec = spec
  state.capabilities = server.capabilities
  state.setModelState('loaded')
  state.touchIdle()
  await emitAudioState(deps, 'loaded')
  return { ...info }
}

/**
 * Take the session out of the state and terminate it. Whether one was running. Touches neither the
 * spec nor the model state: callers decide what the teardown means.
 */
export async function takeDownSession(deps: AudioSessionDeps, graceMs?: number): Promise<boolean> {
  const { state } = deps
  const session = state.session
  if (!session) return false
  state.session = undefined
  // Still on the GPU until its exit is confirmed: GPU residency sees it as stopping until then.
  const exit = session.server.terminate(graceMs).then(() => undefined)
  const stopping = { spec: session.spec, done: exit.catch(() => undefined) }
  state.stopping = stopping
  try {
    await exit
  } catch (error) {
    // Not confirmed: a server that may still be running stays the session, never forgotten.
    if (session.server.exitStatus() === undefined && state.session === undefined) state.session = session
    throw error
  } finally {
    if (state.stopping === stopping) state.stopping = undefined
  }
  await deps.onServerGone?.(session.server.pid)
  return true
}

/** Explicit unload: stop the server, forget the spec, report `unloaded`. */
export async function unloadSession(deps: AudioSessionDeps, reason: string): Promise<void> {
  const { state } = deps
  if (state.modelState === 'loaded') {
    state.setModelState('unloading')
    await emitAudioState(deps, reason)
  }
  await takeDownSession(deps)
  state.spec = undefined
  state.capabilities = undefined
  state.clearIdle()
  state.setModelState('unloaded')
  await emitAudioState(deps, reason)
}

/**
 * A new engine build is active: a resident server, or a spec kept after a cancel or a crash, that
 * runs from another tree is unloaded, so no job respawns the old binary. The caller holds the load
 * lock and has cancelled any running job.
 */
export async function activateAudioInstall(
  deps: AudioSessionDeps,
  record: AudioBackendInstallRecord
): Promise<void> {
  const spec = deps.state.spec
  if (!spec) return
  if (spec.tag === record.tag && (await samePath(spec.binaryDir, record.dir, deps.platform))) return
  await unloadSession(deps, 'engine-updated')
}

/** The server was stopped but the spec stays: the next job respawns it. */
export async function stopKeepingSpec(
  deps: AudioSessionDeps,
  reason: string,
  error?: AudioErrorBody
): Promise<void> {
  const { state } = deps
  await takeDownSession(deps)
  state.clearIdle()
  if (error) state.setModelState('failed', error)
  else state.setModelState('unloaded')
  await emitAudioState(deps, reason)
}

/** Owner exit: no events, no waiting beyond a short grace. */
export async function shutdownAudioSession(deps: AudioSessionDeps): Promise<void> {
  await takeDownSession(deps, SHUTDOWN_GRACE_MS)
}
