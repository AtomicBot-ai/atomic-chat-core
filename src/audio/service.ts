/**
 * The audio-generation service: one resident `audiocpp_server` for the loaded model, jobs against it,
 * the gallery and the model files, and what the engine-builds module and GPU residency need of it.
 * The shape of image generation's `DiffusionService`, much smaller.
 */

import { mkdir, stat } from 'node:fs/promises'
import type { AudioPaths } from '../config/index.js'
import type {
  AudioCancelResult,
  AudioCapabilities,
  AudioConfig,
  AudioGalleryListOptions,
  AudioGalleryPage,
  AudioGenerateRequest,
  AudioJob,
  AudioMode,
  AudioModelFile,
  AudioStatus,
  LoadAudioModelRequest,
  LoadedAudioModel,
} from '../contracts/index.js'
import { AsyncMutex, samePath } from '../diffusion/index.js'
import type { EngineHost } from '../engine-builds/service.js'
import type { AudioSpeechBackend } from '../server/index.js'
import type { BackendOutputSink, GpuClaimHook, GpuOccupancy } from '../runtime/shared/index.js'
import { resolveAudioBackend } from './args.js'
import { resolveModelPath, taskForMode } from './config.js'
import { audioError, audioIoError } from './errors.js'
import { AudioGallery } from './gallery.js'
import { createAudioHttpClient } from './http.js'
import type { AudioHttpClient } from './http.js'
import { startAudioIdleTask } from './idle.js'
import { listInstalledAudioBuilds, readAudioInstallRecord } from './install.js'
import {
  cancelAudioJob,
  DEFAULT_AUDIO_JOB_TIMINGS,
  drawAudioSeed,
  readVoiceRefFile,
  runAudioJob,
  startAudioJob,
} from './jobs.js'
import type { AudioJobDeps, AudioJobOutcome, AudioJobTimings } from './jobs.js'
import { audioModelFilePath, deleteAudioModelFile, listAudioModelFiles } from './model-files.js'
import { spawnAudioServer } from './server-process.js'
import {
  activateAudioInstall,
  audioCapabilities,
  audioGpuCards,
  buildAudioStatus,
  emitAudioState,
  failLoad,
  loadFromSpec,
  shutdownAudioSession,
  takeDownSession,
  unloadSession,
} from './session.js'
import type { AudioEmitter, AudioLogger } from './session.js'
import { AudioState, isTerminalAudioJobState } from './state.js'
import { DEFAULT_STARTUP_TIMEOUT_SECS } from './types.js'
import type { AudioServerHandle, AudioServerSpec } from './types.js'

export interface AudioServiceDeps {
  paths: AudioPaths
  emit: AudioEmitter
  log: AudioLogger
  /** The child journal: written right after the spawn, cleared when the server is gone. */
  journal?: {
    add(pid: number, port: number, exe: string, modelId: string): Promise<void>
    remove(pid: number): Promise<void>
  }
  http?: AudioHttpClient
  /** Every stdout/stderr line `audiocpp_server` prints, for the life of the session. */
  backendOutput?: BackendOutputSink
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timings?: Partial<AudioJobTimings>
  idleTickMs?: number
  /**
   * Core's GPU residency: asked before every `audiocpp_server` spawn — a load, a respawn after a
   * cancel or a crash — to free the GPU of the other engines. Absent, nothing is asked.
   */
  claimGpu?: GpuClaimHook
  /** Test seams. */
  spawn?: (spec: AudioServerSpec, signal?: AbortSignal) => Promise<AudioServerHandle>
  drawSeed?: () => number
}

/** A live job, as GPU residency reports it. */
type Working = Required<Pick<GpuOccupancy, 'busy' | 'remedy'>>

const WHAT: Readonly<Record<AudioMode, string>> = {
  speech: 'speech',
  music: 'music',
  effects: 'a sound effect',
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile() || s.isDirectory(),
    () => false
  )

async function ensureDir(dir: string, message: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch((error: unknown) => {
    throw audioIoError(message, error)
  })
}

export class AudioService {
  readonly state: AudioState
  private readonly deps: AudioJobDeps
  private readonly platform: NodeJS.Platform
  private readonly env: NodeJS.ProcessEnv
  private readonly idleTickMs: number | undefined
  private idle: { stop(): void } | undefined
  /** Stops a load still waiting for its model when the model is unloaded or the core shuts down. */
  private loading: AbortController | undefined
  /** GPU claims in flight, a load's or a respawn's; an unload aborts them rather than wait behind them. */
  private readonly claims = new Set<AbortController>()
  /** Unloads asked for and not finished: a GPU claim that starts meanwhile gives up at once. */
  private unloadRequests = 0

  constructor(options: AudioServiceDeps) {
    const now = options.now ?? Date.now
    const platform = options.platform ?? process.platform
    const http = options.http ?? createAudioHttpClient()
    const log = options.log
    this.platform = platform
    this.env = options.env ?? process.env
    this.idleTickMs = options.idleTickMs
    this.state = new AudioState(options.paths, now)
    const journal = options.journal
    const spawn =
      options.spawn ??
      ((spec: AudioServerSpec, signal?: AbortSignal) =>
        spawnAudioServer(spec, {
          http,
          runDir: options.paths.runDir,
          tmpDir: options.paths.tmpDir,
          platform,
          env: this.env,
          log,
          ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
          ...(signal ? { signal } : {}),
          ...(journal
            ? {
                onSpawned: (pid: number, port: number, exe: string) =>
                  journal.add(pid, port, exe, spec.modelId),
                onGone: (pid: number) => journal.remove(pid),
              }
            : {}),
        }))
    this.deps = {
      state: this.state,
      emit: options.emit,
      log,
      platform,
      now,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      spawn,
      ...(journal ? { onServerGone: (pid: number) => journal.remove(pid) } : {}),
      ...(options.claimGpu ? { claimGpu: this.claimGpu(options.claimGpu) } : {}),
      http,
      gallery: new AudioGallery((level, msg) => log(level, msg)),
      loadLock: new AsyncMutex(),
      timings: { ...DEFAULT_AUDIO_JOB_TIMINGS, ...options.timings },
      drawSeed: options.drawSeed ?? drawAudioSeed,
      readSource: readVoiceRefFile,
    }
  }

  /** Arm the idle timer. */
  start(): void {
    if (this.idle) return
    this.idle = startAudioIdleTask({
      state: this.state,
      loadLock: this.deps.loadLock,
      unload: (reason) => unloadSession(this.deps, reason),
      log: this.deps.log,
      ...(this.idleTickMs !== undefined ? { tickMs: this.idleTickMs } : {}),
    })
  }

  // --- configuration and status ------------------------------------------------------------------

  /** Optional settings: the output folder (`null` restores `<data>/audios`) and the idle unload. */
  async config(config: AudioConfig): Promise<AudioStatus> {
    if (config.outputDir !== undefined) {
      const chosen = config.outputDir?.trim() ?? ''
      if (chosen !== '') await ensureDir(chosen, 'Could not create the output folder.')
      this.state.outputDirOverride = chosen === '' ? null : chosen
    }
    if (config.idleUnloadSecs !== undefined) {
      this.state.idleUnloadSecs = config.idleUnloadSecs
      // Re-arm the idle timer with the new interval.
      if (this.state.spec && this.state.activeJobId === undefined) this.state.touchIdle()
    }
    await emitAudioState(this.deps, 'config')
    return buildAudioStatus(this.deps)
  }

  status(): Promise<AudioStatus> {
    return buildAudioStatus(this.deps)
  }

  /** The gallery folder; an empty path restores `<data>/audios`. */
  async setOutputDir(path: string): Promise<AudioStatus> {
    const trimmed = path.trim()
    if (trimmed !== '') await ensureDir(trimmed, 'Could not create the output folder.')
    this.state.outputDirOverride = trimmed === '' ? null : trimmed
    await emitAudioState(this.deps, 'output-dir')
    return buildAudioStatus(this.deps)
  }

  // --- engine builds and GPU residency -----------------------------------------------------------

  /**
   * What the engine-builds module needs of audio generation: the load lock, the build directories in
   * use, and the activation of a new build — cancel the running job, unload a model whose build the
   * new one replaces (`engine-updated`), report the install.
   */
  engineHost(): EngineHost {
    return {
      exclusive: (fn) => this.deps.loadLock.run(fn),
      inUse: async () => {
        const dirs: string[] = []
        // A resident server, a spec kept after an idle unload or a crash, a server still exiting.
        for (const dir of [
          this.state.session?.spec.binaryDir,
          this.state.spec?.binaryDir,
          this.state.stopping?.spec.binaryDir,
        ])
          if (dir !== undefined && !dirs.includes(dir)) dirs.push(dir)
        return dirs
      },
      activate: async (dir, replaced) => {
        const record = await readAudioInstallRecord(dir)
        if (!record) throw audioError('INTERNAL', 'The new audio engine build has no install record.', dir)
        if (this.state.activeJobId !== undefined)
          await cancelAudioJob(this.deps, this.state.activeJobId).catch(() => undefined)
        const spec = this.state.spec
        // The same directory with a fresh tree: what runs from it is the old binary.
        if (replaced && spec && (await samePath(spec.binaryDir, dir, this.platform)))
          await unloadSession(this.deps, 'engine-updated')
        else await activateAudioInstall(this.deps, record)
        await emitAudioState(this.deps, 'install')
      },
      // The `install` part of the status changed.
      changed: (reason) => emitAudioState(this.deps, reason),
    }
  }

  /**
   * The GPU the resident, stopping or starting `audiocpp_server` holds, for core's residency rule. The
   * resident or starting one is `busy` while a job runs on it that nobody asked to cancel: residency
   * then refuses a chat load (`GPU_BUSY`) instead of stopping the clip.
   */
  gpuOccupancy(): GpuOccupancy[] {
    const held = (spec: AudioServerSpec, state: GpuOccupancy['state'], working?: Working): GpuOccupancy => ({
      model_id: spec.modelId,
      cards: audioGpuCards(spec),
      auxiliary: false,
      state,
      ...(working ?? {}),
    })
    const out: GpuOccupancy[] = []
    const { session, stopping, starting } = this.state
    if (session && session.server.exitStatus() === undefined)
      out.push(held(session.spec, 'ready', this.working(session.spec)))
    if (stopping) out.push(held(stopping.spec, 'stopping'))
    if (starting) out.push(held(starting, 'loading', this.working(starting)))
    return out
  }

  /** What the active job is making on `spec`; none when no job is live. */
  private working(spec: AudioServerSpec): Working | undefined {
    const id = this.state.activeJobId
    const record = id === undefined ? undefined : this.state.record(id)
    if (!record || record.cancel.requested || isTerminalAudioJobState(record.job.state)) return undefined
    return {
      busy: `${spec.displayName} is generating ${WHAT[spec.mode]}`,
      remedy: 'Wait for the clip to finish, or stop it, then try again.',
    }
  }

  /** The session's claim hook over core's: abortable by an unload, whatever signal the caller had. */
  private claimGpu(
    hook: GpuClaimHook
  ): (spec: AudioServerSpec, signal?: AbortSignal, granted?: () => void) => Promise<void> {
    return async (spec, signal, granted) => {
      const controller = new AbortController()
      const forward = () => controller.abort()
      if (signal?.aborted || this.unloadRequests > 0) controller.abort()
      signal?.addEventListener('abort', forward, { once: true })
      this.claims.add(controller)
      try {
        await hook(
          { model_id: spec.modelId, cards: audioGpuCards(spec), auxiliary: false },
          controller.signal,
          granted
        )
      } finally {
        this.claims.delete(controller)
        signal?.removeEventListener('abort', forward)
      }
    }
  }

  // --- model files ---------------------------------------------------------------------------------

  listModelFiles(): Promise<AudioModelFile[]> {
    return listAudioModelFiles(this.state.paths.modelsDir)
  }

  /** Delete a file named relative to `<data>/audio/models`; the loaded model's own file is refused. */
  async deleteModelFile(relativePath: string): Promise<void> {
    const root = this.state.paths.modelsDir
    const path = await audioModelFilePath(root, relativePath, this.platform)
    const spec = this.state.spec
    if (spec && (await samePath(spec.modelPath, path, this.platform)))
      throw audioError('BACKEND_IN_USE', 'That file belongs to the loaded audio model. Unload it first.')
    await deleteAudioModelFile(root, path, this.platform)
  }

  // --- session -------------------------------------------------------------------------------------

  /** Answers once the server serves the model. One load at a time; a load replaces the resident model. */
  async loadModel(request: LoadAudioModelRequest): Promise<LoadedAudioModel> {
    const { state } = this
    return this.deps.loadLock.run(async () => {
      // First, before any await: an unload from here on reaches this load, wherever it is waiting.
      const loading = new AbortController()
      this.loading = loading
      try {
        if (state.closing) throw audioError('ENGINE_CRASHED', 'The audio engine is shutting down.')
        if (state.activeJobId !== undefined)
          await cancelAudioJob(this.deps, state.activeJobId).catch(() => undefined)
        await takeDownSession(this.deps)
        state.spec = undefined
        state.capabilities = undefined
        let spec: AudioServerSpec
        try {
          spec = await this.specFor(request)
        } catch (error) {
          return await failLoad(this.deps, error, 'load-blocked')
        }
        return await loadFromSpec(this.deps, spec, 'load', loading.signal)
      } finally {
        if (this.loading === loading) this.loading = undefined
      }
    })
  }

  /** What a load runs: the newest installed build, the model file checked. */
  private async specFor(request: LoadAudioModelRequest): Promise<AudioServerSpec> {
    if (request.task !== taskForMode(request.mode))
      throw audioError(
        'INVALID_REQUEST',
        `A ${request.mode} model is served as audio.cpp's ${taskForMode(request.mode)} task.`,
        `task: ${request.task}`
      )
    const modelPath = resolveModelPath(request.file, this.state.paths.modelsDir, this.platform)
    if (!(await exists(modelPath))) {
      const name = modelPath.split(/[\\/]/).pop() || modelPath
      throw audioError('MODEL_MISSING', `${name} is missing. Download the model again.`, modelPath)
    }
    const record = (await listInstalledAudioBuilds(this.state.paths.backendsDir, this.platform))[0]
    if (!record) throw audioError('ENGINE_MISSING', 'The audio engine is not installed.')
    return {
      binaryDir: record.dir,
      backend: resolveAudioBackend(record.backend, this.env),
      buildBackend: record.backend,
      backendId: record.backendId,
      tag: record.tag,
      modelId: request.modelId,
      displayName: request.displayName,
      mode: request.mode,
      family: request.family,
      task: request.task,
      modelPath,
      ...(request.loadOptions ? { loadOptions: { ...request.loadOptions } } : {}),
      ...(request.sessionOptions ? { sessionOptions: { ...request.sessionOptions } } : {}),
      ...(request.defaultRequestOptions
        ? { defaultRequestOptions: { ...request.defaultRequestOptions } }
        : {}),
      ...(request.defaultVoice !== undefined ? { defaultVoice: request.defaultVoice } : {}),
      ...(request.threads !== undefined ? { threads: request.threads } : {}),
      startupTimeoutMs:
        (request.startupTimeoutSecs !== undefined && request.startupTimeoutSecs > 0
          ? request.startupTimeoutSecs
          : DEFAULT_STARTUP_TIMEOUT_SECS) * 1000,
    }
  }

  async unloadModel(): Promise<void> {
    this.unloadRequests += 1
    let counted = true
    const done = () => {
      if (!counted) return
      counted = false
      this.unloadRequests -= 1
    }
    this.loading?.abort()
    for (const claim of this.claims) claim.abort()
    try {
      await this.deps.loadLock.run(async () => {
        try {
          if (this.state.activeJobId !== undefined)
            await cancelAudioJob(this.deps, this.state.activeJobId).catch(() => undefined)
          await unloadSession(this.deps, 'unload')
          // A server taken down outside the lock (a job's crash or cancel) is waited for as well.
          await this.state.stopping?.done
        } finally {
          // Still inside the lock: a load queued behind this unload is never taken for superseded.
          done()
        }
      })
    } finally {
      done()
    }
  }

  /** Reset the idle-unload deadline without generating. */
  touchIdle(): void {
    if (this.state.activeJobId === undefined && this.state.spec) this.state.touchIdle()
  }

  capabilities(): AudioCapabilities {
    return audioCapabilities(this.state)
  }

  // --- jobs ----------------------------------------------------------------------------------------

  /** Start a job; answers it at once, its phases and outcome arrive as `audio:job` events. */
  async generate(mode: AudioMode, request: AudioGenerateRequest): Promise<AudioJob> {
    return (await startAudioJob(this.deps, mode, request)).job
  }

  /** Run one job to completion and answer the clip. */
  runJob(mode: AudioMode, request: AudioGenerateRequest): Promise<AudioJobOutcome> {
    return runAudioJob(this.deps, mode, request)
  }

  /**
   * What `POST /v1/audio/speech` needs: the loaded model and what it makes, and a speech job started
   * the way `runJob` starts one — same validation, events, gallery and idle timer — but answered with
   * its id at once, so a client that hangs up can have it cancelled.
   */
  speechBackend(): AudioSpeechBackend {
    return {
      loaded: () => {
        const spec = this.state.spec
        return spec ? { modelId: spec.modelId, displayName: spec.displayName, mode: spec.mode } : undefined
      },
      start: async (request) => {
        const { job, done } = await startAudioJob(this.deps, 'speech', request)
        return { id: job.id, done }
      },
      cancel: (jobId) => cancelAudioJob(this.deps, jobId),
    }
  }

  getJob(id: string): AudioJob | null {
    return this.state.job(id) ?? null
  }

  cancelJob(id: string): Promise<AudioCancelResult> {
    return cancelAudioJob(this.deps, id)
  }

  // --- gallery -------------------------------------------------------------------------------------

  gallery(options: AudioGalleryListOptions): Promise<AudioGalleryPage> {
    return this.deps.gallery.list(this.state.outputDir(), options)
  }

  deleteGalleryItem(id: string): Promise<void> {
    return this.deps.gallery.delete(this.state.outputDir(), id)
  }

  // --- lifecycle -----------------------------------------------------------------------------------

  /** Owner exit: an `audiocpp_server` must not outlive the core. No events, a short grace. */
  async shutdown(): Promise<void> {
    this.state.closing = true
    this.idle?.stop()
    this.idle = undefined
    this.loading?.abort()
    for (const claim of this.claims) claim.abort()
    const id = this.state.activeJobId
    if (id !== undefined) {
      const record = this.state.record(id)
      if (record) {
        record.cancel.requested = true
        record.cancel.abort.abort()
      }
    }
    await shutdownAudioSession(this.deps)
  }
}
