/**
 * The image-generation service: the twenty operations of the app's `DiffusionService`, one method
 * each, over the module's state. The command surface of `commands.rs` in
 * `tauri-plugin-atomic-diffusion` (app commit `ec1fd3ea7`), with the plugin's setup and exit hooks
 * (`lib.rs`) as `start`/`shutdown`.
 */

import { mkdir, stat } from 'node:fs/promises'
import type {
  CoreEvents,
  DiffusionBackendInstallRecord,
  DiffusionCancelResult,
  DiffusionConfig,
  DiffusionModelFile,
  DiffusionStatus,
  FinalizeBackendInstallArgs,
  GalleryFlags,
  GalleryImageItem,
  GalleryListOptions,
  GalleryPage,
  GalleryVideoItem,
  ImageCapabilities,
  ImageGenerateRequest,
  ImageJob,
  LoadDiffusionModelRequest,
  LoadedDiffusionModel,
  SystemInfo,
  VideoCapabilities,
  VideoEstimate,
  VideoGalleryPage,
  VideoGenerateRequest,
  VideoJob,
} from '../contracts/index.js'
import type { DiffusionPaths } from '../config/index.js'
import type { BackendOutputSink } from '../runtime/shared/index.js'
import type { ImagesBackend, VideosBackend } from '../server/index.js'
import { selectModelInstall } from './compat.js'
import { samePath } from './containment.js'
import { VIDEO_VAE_TILING_PIXEL_FRAMES } from './args.js'
import { diffusionError, errorBody, ioError, modelNotLoadedError } from './errors.js'
import { Gallery } from './gallery.js'
import { createSdHttpClient } from './http.js'
import type { SdHttpClient } from './http.js'
import { startIdleTask } from './idle.js'
import {
  deleteModelFile,
  ensureDirs,
  finalizeBackendInstall,
  listInstalledBackends,
  listModelFiles,
  removeBackend,
} from './install.js'
import {
  cancelJob,
  DEFAULT_JOB_TIMINGS,
  drawSeed,
  readSourceFile,
  runImageJob,
  runVideoJob,
  startImageJob,
  startVideoJob,
} from './jobs.js'
import type { JobPlan } from './job-kind.js'
import type { JobDeps, JobOutcome, JobTimings } from './jobs.js'
import { AsyncMutex } from './mutex.js'
import { spawnServer } from './server-process.js'
import {
  activateInstall,
  buildStatus,
  capabilities,
  emitState,
  loadFromSpec,
  shutdownSession,
  takeDownSession,
  unload,
  videoCapabilities,
} from './session.js'
import type { DiffusionEmitter, DiffusionLogger } from './session.js'
import { DiffusionState, isTerminalJobState } from './state.js'
import { DEFAULT_STARTUP_TIMEOUT_SECS } from './types.js'
import type { ServerSpec } from './types.js'
import { stripDataUrl, validateVideoRequest } from './validate.js'
import { estimateVideoCost, planDecodeTiling } from './video-estimate.js'
import type { VideoCost, VideoEstimateInput } from './video-estimate.js'
import { diffusionGpuCards } from './session.js'
import type { GpuClaimHook, GpuOccupancy } from '../runtime/shared/index.js'
import { isValidVideoId, MAX_POSTER_BYTES, VideoGallery } from './video-gallery.js'
import { historyMultiplier, VideoHistory } from './video-history.js'
import { VIDEO_JOB_KIND } from './video-job.js'

export interface DiffusionServiceDeps {
  paths: DiffusionPaths
  /** The core's data folder, which `configure` must name. */
  dataFolder: string
  emit: DiffusionEmitter
  log: DiffusionLogger
  /** The child journal: written right after the spawn, cleared when the server is gone. */
  journal?: {
    add(pid: number, port: number, exe: string, modelId: string): Promise<void>
    remove(pid: number): Promise<void>
  }
  http?: SdHttpClient
  /** Every stdout/stderr line `sd-server` prints, for the life of the session. */
  backendOutput?: BackendOutputSink
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timings?: Partial<JobTimings>
  idleTickMs?: number
  /** The core's hardware facts (the override applied), which the video estimate weighs; absent: no estimate. */
  systemInfo?: () => Promise<SystemInfo>
  /** Test seams. */
  spawn?: (spec: ServerSpec, scratchDir: string, signal?: AbortSignal) => ReturnType<typeof spawnServer>
  drawSeed?: () => number
  /**
   * Core's GPU residency (spec `gpu-residency`): asked before every `sd-server` spawn — a load, a
   * respawn after a cancel or a crash — to free the GPU of the other engines. Absent, nothing is asked.
   */
  claimGpu?: GpuClaimHook
}

/** A live job, as GPU residency reports it. */
type Working = Required<Pick<GpuOccupancy, 'busy' | 'remedy'>>

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

export class DiffusionService {
  readonly state: DiffusionState
  private readonly deps: JobDeps
  private readonly gallery: Gallery
  private readonly videoGallery: VideoGallery
  private readonly history: VideoHistory
  private readonly systemInfo: (() => Promise<SystemInfo>) | undefined
  private readonly platform: NodeJS.Platform
  private readonly dataFolder: string
  private readonly idleTickMs: number | undefined
  private idle: { stop(): void } | undefined
  /** Stops a load still waiting for its port when the model is unloaded or the core shuts down. */
  private loading: AbortController | undefined
  /**
   * GPU claims in flight, a load's or a respawn's. An unload aborts them: a claim waits for its turn
   * under the load lock, and an unload that core asks for to free the GPU must not wait behind it.
   */
  private readonly claims = new Set<AbortController>()
  /**
   * Unloads asked for and not finished. A GPU claim that starts meanwhile — a load or a respawn that
   * held the lock before the unload asked — gives up at once: the unload waits for that lock, and core
   * may be waiting for the unload, so a claim that waited here would never be granted.
   */
  private unloadRequests = 0

  constructor(options: DiffusionServiceDeps) {
    const now = options.now ?? Date.now
    const platform = options.platform ?? process.platform
    const http = options.http ?? createSdHttpClient()
    const log = options.log
    this.platform = platform
    this.dataFolder = options.dataFolder
    this.idleTickMs = options.idleTickMs
    this.state = new DiffusionState(options.paths, now)
    this.gallery = new Gallery((level, msg) => log(level, msg))
    this.videoGallery = new VideoGallery((level, msg) => log(level, msg))
    this.history = new VideoHistory(async (dir) =>
      (
        await this.videoGallery.list(dir, {
          offset: 0,
          limit: Number.MAX_SAFE_INTEGER,
          includeArchived: true,
        })
      ).items.map((item) => item.recipe)
    )
    this.systemInfo = options.systemInfo
    const journal = options.journal
    const spawn =
      options.spawn ??
      ((spec: ServerSpec, scratchDir: string, signal?: AbortSignal) =>
        spawnServer(spec, scratchDir, {
          http,
          platform,
          env: options.env ?? process.env,
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
      gallery: this.gallery,
      videoGallery: this.videoGallery,
      loadLock: new AsyncMutex(),
      timings: { ...DEFAULT_JOB_TIMINGS, ...options.timings },
      drawSeed: options.drawSeed ?? drawSeed,
      readSource: readSourceFile,
      isFile,
      planVideo: (request, spec) => this.videoCost(request, spec),
      videoSaved: () => this.history.invalidate(),
    }
  }

  /** Arm the idle timer; the plugin did this in its setup hook. */
  start(): void {
    if (this.idle) return
    this.idle = startIdleTask({
      state: this.state,
      loadLock: this.deps.loadLock,
      unload: (reason) => unload(this.deps, reason),
      log: this.deps.log,
      ...(this.idleTickMs !== undefined ? { tickMs: this.idleTickMs } : {}),
    })
  }

  // --- configuration and status ------------------------------------------------------------------

  async configure(config: DiffusionConfig): Promise<DiffusionStatus> {
    if (config.dataFolder.trim() === '') throw diffusionError('NOT_CONFIGURED', 'The data folder is not set.')
    if (!(await samePath(config.dataFolder, this.dataFolder, this.platform)))
      throw diffusionError(
        'NOT_CONFIGURED',
        "Image generation runs inside the core's data folder only.",
        `${config.dataFolder} is not ${this.dataFolder}`
      )
    this.state.config = config
    const { paths } = this.state
    await ensureDirs([
      paths.root,
      paths.backendsDir,
      paths.modelsDir,
      this.state.outputDir(),
      this.state.videoOutputDir(),
    ])
    // Re-arm the idle timer with the (possibly new) interval.
    if (this.state.session && this.state.activeJobId === undefined) this.state.touchIdle()
    return buildStatus(this.deps)
  }

  getStatus(): Promise<DiffusionStatus> {
    return buildStatus(this.deps)
  }

  async setOutputDir(path: string): Promise<DiffusionStatus> {
    const config = this.state.config
    if (!config) throw diffusionError('NOT_CONFIGURED', 'Image generation has not been configured yet.')
    const trimmed = path.trim()
    if (trimmed !== '') await ensureOutputDir(trimmed)
    if (trimmed === '') delete config.outputDir
    else config.outputDir = trimmed
    await ensureOutputDir(this.state.outputDir())
    await emitState(this.deps, 'output-dir')
    return buildStatus(this.deps)
  }

  // --- engine binary -------------------------------------------------------------------------------

  /**
   * Under the load lock, so no load or respawn runs across it: finalize, cancel a running job, and
   * unload a model whose tree the new install replaces.
   */
  finalizeBackendInstall(args: FinalizeBackendInstallArgs): Promise<DiffusionBackendInstallRecord> {
    return this.deps.loadLock.run(async () => {
      const record = await finalizeBackendInstall(this.state.paths.backendsDir, args, {
        platform: this.platform,
        log: this.deps.log,
        now: this.deps.now,
      })
      if (this.state.activeJobId !== undefined)
        await cancelJob(this.deps, this.state.activeJobId).catch(() => undefined)
      await activateInstall(this.deps, record)
      await emitState(this.deps, 'install')
      return record
    })
  }

  listInstalledBackends(): Promise<DiffusionBackendInstallRecord[]> {
    return listInstalledBackends(this.state.paths.backendsDir, this.platform)
  }

  async removeBackend(dir: string): Promise<void> {
    const inUse = [this.state.session?.spec.binaryDir, this.state.spec?.binaryDir]
    for (const used of inUse)
      if (used !== undefined && (await samePath(used, dir, this.platform)))
        throw diffusionError('BACKEND_IN_USE', 'Unload the image model before removing its engine.')
    await removeBackend(this.state.paths.backendsDir, dir, this.platform)
    await emitState(this.deps, 'uninstall')
  }

  // --- model files ---------------------------------------------------------------------------------

  listModelFiles(): Promise<DiffusionModelFile[]> {
    return listModelFiles(this.state.paths.modelsDir)
  }

  async deleteModelFile(path: string): Promise<void> {
    const spec = this.state.spec
    if (spec) {
      const files = spec.files
      for (const used of [
        files.diffusionModel,
        files.vae,
        files.clipL,
        files.t5xxl,
        files.llm,
        files.llmVision,
        files.qwen2vl,
        files.audioVae,
        files.embeddingsConnectors,
      ])
        if (used !== undefined && (await samePath(used, path, this.platform)))
          throw diffusionError(
            'BACKEND_IN_USE',
            spec.modality === 'video'
              ? 'That file belongs to the loaded video model. Unload it first.'
              : 'That file belongs to the loaded image model. Unload it first.'
          )
    }
    await deleteModelFile(this.state.paths.modelsDir, path, this.platform)
  }

  // --- session -------------------------------------------------------------------------------------

  async loadModel(request: LoadDiffusionModelRequest): Promise<LoadedDiffusionModel> {
    const { state } = this
    const root = state.paths.backendsDir
    return this.deps.loadLock.run(async () => {
      // First, before any await: an unload from here on reaches this load, wherever it is waiting.
      const loading = new AbortController()
      this.loading = loading
      if (state.closing) throw diffusionError('ENGINE_CRASHED', 'sd-server was stopped.')
      if (state.activeJobId !== undefined)
        await cancelJob(this.deps, state.activeJobId).catch(() => undefined)
      await takeDownSession(this.deps)
      state.spec = undefined
      state.modelFileBytes = undefined

      await checkFiles(request.files)
      const engine = request.engine ?? 'sd-cpp'
      if (engine !== 'sd-cpp')
        throw diffusionError(
          'UNSUPPORTED_BACKEND',
          'Only the stable-diffusion.cpp engine is available in this build.',
          engine
        )
      let record: DiffusionBackendInstallRecord
      try {
        record = selectModelInstall(await listInstalledBackends(root, this.platform), engine, request.family)
      } catch (error) {
        state.setModelState('failed', errorBody(error))
        await emitState(this.deps, 'load-blocked')
        throw error
      }

      const spec: ServerSpec = {
        binaryDir: record.dir,
        engine,
        backend: record.backend,
        backendId: record.backendId,
        tag: record.tag,
        modelId: request.modelId,
        family: request.family,
        modality: request.modality,
        displayName: request.displayName,
        files: { ...request.files },
        defaults: structuredClone(request.defaults),
        ranges: structuredClone(request.ranges),
        offload: request.offload,
        ...(request.offloadFallback !== undefined && request.offloadFallback !== request.offload
          ? { offloadFallback: request.offloadFallback }
          : {}),
        ...(request.threads !== undefined ? { threads: request.threads } : {}),
        extraArgs: [],
        startupTimeoutMs:
          (request.startupTimeoutSecs !== undefined && request.startupTimeoutSecs > 0
            ? request.startupTimeoutSecs
            : DEFAULT_STARTUP_TIMEOUT_SECS) * 1000,
        cpuFallback: false,
      }
      try {
        return await loadFromSpec(this.deps, spec, 'load', loading.signal)
      } finally {
        if (this.loading === loading) this.loading = undefined
      }
    })
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
            await cancelJob(this.deps, this.state.activeJobId).catch(() => undefined)
          await unload(this.deps, 'unload')
          // A server taken down outside the lock (a job's crash or cancel) is waited for as well:
          // this unload answers only once nothing of the model is left on the GPU.
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

  getCapabilities(): ImageCapabilities {
    return capabilities(this.state)
  }

  getVideoCapabilities(): VideoCapabilities {
    return videoCapabilities(this.state)
  }

  /** Reset the idle-unload deadline without generating. */
  touchIdle(): void {
    if (this.state.activeJobId === undefined && this.state.modelState === 'loaded') this.state.touchIdle()
  }

  // --- jobs ----------------------------------------------------------------------------------------

  async generate(request: ImageGenerateRequest): Promise<{ jobId: string }> {
    const { id } = await startImageJob(this.deps, request)
    return { jobId: id }
  }

  /** Run one job to completion; the OpenAI facade's path. */
  runImageJob(request: ImageGenerateRequest): Promise<JobOutcome> {
    return runImageJob(this.deps, request)
  }

  /** What `POST /v1/images/generations` needs: the resident model, and a job it can await or abandon. */
  imagesBackend(): ImagesBackend {
    return {
      loaded: () => {
        const spec = this.state.spec
        return spec
          ? { modelId: spec.modelId, displayName: spec.displayName, defaults: { ...spec.defaults } }
          : undefined
      },
      start: (request) => startImageJob(this.deps, request),
      cancel: (jobId) => cancelJob(this.deps, jobId),
    }
  }

  /** What `/v1/videos` needs: the resident model, the runner's records and the gallery. */
  videosBackend(): VideosBackend {
    return {
      loaded: () => {
        const spec = this.state.spec
        return spec
          ? {
              modelId: spec.modelId,
              displayName: spec.displayName,
              modality: spec.modality,
              defaults: structuredClone(spec.defaults),
              ranges: structuredClone(spec.ranges),
            }
          : undefined
      },
      start: (request) => startVideoJob(this.deps, request),
      job: (id) => this.state.videoJob(id) ?? null,
      jobs: () => this.state.videoJobs(),
      // Any string can come in from a URL: one that is not an id is simply not a clip.
      item: (id) =>
        this.state.configured && isValidVideoId(id) ? this.getVideoGalleryItem(id) : Promise.resolve(null),
      list: (options) =>
        this.state.configured
          ? this.listVideoGallery(options)
          : Promise.resolve({ items: [], hasMore: false, total: 0 }),
      cancel: (jobId) => cancelJob(this.deps, jobId),
      delete: (id) => this.deleteVideoGalleryItems([id]),
    }
  }

  getJob(jobId: string): ImageJob | null {
    return this.state.job(jobId) ?? null
  }

  /** Cancels a job of either kind. */
  cancelJob(jobId: string): Promise<DiffusionCancelResult> {
    return cancelJob(this.deps, jobId)
  }

  // --- video jobs ----------------------------------------------------------------------------------

  async generateVideo(request: VideoGenerateRequest): Promise<{ jobId: string }> {
    const { id } = await startVideoJob(this.deps, request)
    return { jobId: id }
  }

  /** Run one video job to completion; the `/v1/videos` facade's path. */
  runVideoJob(request: VideoGenerateRequest): Promise<JobOutcome<VideoJob>> {
    return runVideoJob(this.deps, request)
  }

  /**
   * What `request` would cost on this machine with the loaded model. Refused like a job would be
   * (no model, an image model, an invalid request), but it starts nothing and answers while another
   * job runs.
   */
  async estimateVideo(request: VideoGenerateRequest): Promise<VideoEstimate> {
    const spec = this.state.spec
    if (!spec) throw modelNotLoadedError()
    if (spec.modality !== 'video')
      throw diffusionError('MODEL_INCOMPATIBLE', VIDEO_JOB_KIND.messages.wrongModel, spec.modelId)
    await validateVideoRequest(request, spec, { isFile })
    return (await this.videoCost(request, spec)).estimate
  }

  /**
   * The estimate and its forecast for a request already validated against `spec`, and the tiling of
   * its decode they were worked out for.
   */
  private async videoCost(request: VideoGenerateRequest, spec: ServerSpec): Promise<JobPlan & VideoCost> {
    if (!this.systemInfo)
      throw diffusionError('INTERNAL', 'The core has no hardware facts to estimate the video with.')
    const base: VideoEstimateInput = {
      family: spec.family,
      backend: spec.backend,
      offload: spec.offload,
      cpuFallback: spec.cpuFallback,
      fileBytes: this.state.modelFileBytes ?? {},
      width: request.width,
      height: request.height,
      frames: request.frames ?? spec.defaults.video?.frames ?? 1,
      steps: request.steps,
      cfgScale: request.cfgScale,
      tilingPixelFrames: VIDEO_VAE_TILING_PIXEL_FRAMES,
      system: await this.systemInfo(),
    }
    const decodeTiling = planDecodeTiling(base)
    const input: VideoEstimateInput = decodeTiling ? { ...base, decodeTiling } : base
    const recipes = this.state.configured
      ? await this.history.recipes(this.state.videoOutputDir()).catch(() => [])
      : []
    const cost = estimateVideoCost(input, historyMultiplier(recipes, input))
    if (!cost) throw diffusionError('INTERNAL', 'The core could not read how much memory this machine has.')
    return decodeTiling ? { ...cost, decodeTiling } : cost
  }

  getVideoJob(jobId: string): VideoJob | null {
    return this.state.videoJob(jobId) ?? null
  }

  cancelVideoJob(jobId: string): Promise<DiffusionCancelResult> {
    if (this.state.record(jobId)?.kind !== 'video')
      return Promise.reject(diffusionError('JOB_NOT_FOUND', 'That job no longer exists.'))
    return cancelJob(this.deps, jobId)
  }

  // --- video gallery -------------------------------------------------------------------------------

  listVideoGallery(options: GalleryListOptions): Promise<VideoGalleryPage> {
    return this.videoGallery.list(this.requireVideoOutputDir(), options)
  }

  getVideoGalleryItem(id: string): Promise<GalleryVideoItem | null> {
    return this.videoGallery.get(this.requireVideoOutputDir(), id)
  }

  async deleteVideoGalleryItems(ids: string[]): Promise<void> {
    try {
      await this.videoGallery.delete(this.requireVideoOutputDir(), ids)
    } finally {
      this.history.invalidate()
    }
  }

  setVideoGalleryFlags(id: string, flags: GalleryFlags): Promise<GalleryVideoItem> {
    return this.videoGallery.setFlags(this.requireVideoOutputDir(), id, flags)
  }

  exportVideoGalleryItem(id: string, targetPath: string): Promise<void> {
    return this.videoGallery.export(this.requireVideoOutputDir(), id, targetPath)
  }

  /** The poster the app rendered from the clip's first frame, as base64 PNG (a data-URL prefix accepted). */
  setVideoPoster(id: string, pngBase64: string): Promise<GalleryVideoItem> {
    const dir = this.requireVideoOutputDir()
    const payload = stripDataUrl(pngBase64)
    // A base64 payload past the cap is refused before it is decoded.
    if (payload.length > (MAX_POSTER_BYTES * 4) / 3 + 4)
      return Promise.reject(
        diffusionError('INVALID_REQUEST', 'The poster is too large.', `${payload.length} base64 characters`)
      )
    return this.videoGallery.setPoster(dir, id, Buffer.from(payload, 'base64'))
  }

  private requireVideoOutputDir(): string {
    if (!this.state.configured)
      throw diffusionError('NOT_CONFIGURED', 'Image generation has not been configured yet.')
    return this.state.videoOutputDir()
  }

  // --- gallery -------------------------------------------------------------------------------------

  async listGallery(options: GalleryListOptions): Promise<GalleryPage> {
    return this.gallery.list(this.requireOutputDir(), options)
  }

  async getGalleryItem(id: string): Promise<GalleryImageItem | null> {
    return this.gallery.get(this.requireOutputDir(), id)
  }

  async deleteGalleryItems(ids: string[]): Promise<void> {
    return this.gallery.delete(this.requireOutputDir(), ids)
  }

  async setGalleryFlags(id: string, flags: GalleryFlags): Promise<GalleryImageItem> {
    return this.gallery.setFlags(this.requireOutputDir(), id, flags)
  }

  async exportGalleryItem(id: string, targetPath: string): Promise<void> {
    return this.gallery.export(this.requireOutputDir(), id, targetPath)
  }

  private requireOutputDir(): string {
    if (!this.state.configured)
      throw diffusionError('NOT_CONFIGURED', 'Image generation has not been configured yet.')
    return this.state.outputDir()
  }

  // --- lifecycle -----------------------------------------------------------------------------------

  /** Owner exit: a multi-gigabyte `sd-server` must not outlive the core. No events, a short grace. */
  async shutdown(): Promise<void> {
    this.state.closing = true
    this.idle?.stop()
    this.idle = undefined
    this.loading?.abort()
    for (const claim of this.claims) claim.abort()
    await shutdownSession(this.deps)
  }

  /**
   * The GPU the resident, stopping (exit not yet confirmed) or starting `sd-server` holds, for core's
   * residency rule. The resident or starting one is `busy` while a job runs on it that nobody asked to
   * cancel: residency then refuses a chat load instead of stopping the clip (ATO-549).
   */
  gpuOccupancy(): GpuOccupancy[] {
    const held = (spec: ServerSpec, state: GpuOccupancy['state'], working?: Working): GpuOccupancy => ({
      model_id: spec.modelId,
      cards: diffusionGpuCards(spec),
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

  /** What the active job is making on `spec`, for a refused claim; none when no job is live. */
  private working(spec: ServerSpec): Working | undefined {
    const id = this.state.activeJobId
    const record = id === undefined ? undefined : this.state.record(id)
    if (!record || record.cancel.requested || isTerminalJobState(record.job.state)) return undefined
    const video = record.kind === 'video'
    return {
      busy: `${spec.displayName} is generating ${video ? 'a video' : 'an image'}`,
      remedy: `Wait for the ${video ? 'video' : 'image'} to finish, or stop it, then try again.`,
    }
  }

  /** The session's claim hook over core's: abortable by an unload, whatever signal the caller had. */
  private claimGpu(
    hook: GpuClaimHook
  ): (spec: ServerSpec, signal?: AbortSignal, granted?: () => void) => Promise<void> {
    return async (spec, signal, granted) => {
      const controller = new AbortController()
      const forward = () => controller.abort()
      if (signal?.aborted || this.unloadRequests > 0) controller.abort()
      signal?.addEventListener('abort', forward, { once: true })
      this.claims.add(controller)
      try {
        const claim = { model_id: spec.modelId, cards: diffusionGpuCards(spec), auxiliary: false }
        await hook(claim, controller.signal, granted)
      } finally {
        this.claims.delete(controller)
        signal?.removeEventListener('abort', forward)
      }
    }
  }

  /** What the events carry; for tests and the facade. */
  static eventNames(): Array<keyof CoreEvents> {
    return [
      'diffusion:state',
      'diffusion:progress',
      'diffusion:job',
      'diffusion:error',
      'diffusion:video-progress',
      'diffusion:video-job',
    ]
  }
}

async function ensureOutputDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true }).catch((error: unknown) => {
    throw ioError('Could not create the output folder.', error)
  })
}

/** Every file the load names must exist; the transformer's absence has its own code. */
async function checkFiles(files: LoadDiffusionModelRequest['files']): Promise<void> {
  const entries: Array<[string, string | undefined]> = [
    ['diffusionModel', files.diffusionModel],
    ['vae', files.vae],
    ['clipL', files.clipL],
    ['t5xxl', files.t5xxl],
    ['llm', files.llm],
    ['llmVision', files.llmVision],
    ['qwen2vl', files.qwen2vl],
    ['audioVae', files.audioVae],
    ['embeddingsConnectors', files.embeddingsConnectors],
  ]
  for (const [label, path] of entries) {
    if (path === undefined) continue
    if (await isFile(path)) continue
    const name = path.split(/[\\/]/).pop() || path
    throw diffusionError(
      label === 'diffusionModel' ? 'MODEL_MISSING' : 'SIDE_FILE_MISSING',
      `${name} is missing. Download the model again.`,
      `${label}: ${path}`
    )
  }
}
