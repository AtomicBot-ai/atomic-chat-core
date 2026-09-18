/**
 * The image-generation service: the twenty operations of the app's `DiffusionService`, one method
 * each, over the module's state. The command surface of `commands.rs` in
 * `tauri-plugin-atomic-diffusion` (app commit `767ff6350`), with the plugin's setup and exit hooks
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
  ImageCapabilities,
  ImageGenerateRequest,
  ImageJob,
  LoadDiffusionModelRequest,
  LoadedDiffusionModel,
} from '../contracts/index.js'
import type { DiffusionPaths } from '../config/index.js'
import type { ImagesBackend } from '../server/index.js'
import { samePath } from './containment.js'
import { diffusionError, ioError } from './errors.js'
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
  startImageJob,
} from './jobs.js'
import type { JobDeps, JobOutcome, JobTimings } from './jobs.js'
import { AsyncMutex } from './mutex.js'
import { spawnServer } from './server-process.js'
import {
  buildStatus,
  capabilities,
  emitState,
  loadFromSpec,
  shutdownSession,
  takeDownSession,
  unload,
} from './session.js'
import type { DiffusionEmitter, DiffusionLogger } from './session.js'
import { DiffusionState } from './state.js'
import { DEFAULT_STARTUP_TIMEOUT_SECS } from './types.js'
import type { ServerSpec } from './types.js'

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
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  timings?: Partial<JobTimings>
  idleTickMs?: number
  /** Test seams. */
  spawn?: (spec: ServerSpec, scratchDir: string, signal?: AbortSignal) => ReturnType<typeof spawnServer>
  drawSeed?: () => number
}

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

export class DiffusionService {
  readonly state: DiffusionState
  private readonly deps: JobDeps
  private readonly gallery: Gallery
  private readonly platform: NodeJS.Platform
  private readonly dataFolder: string
  private readonly idleTickMs: number | undefined
  private idle: { stop(): void } | undefined
  /** Stops a load still waiting for its port when the model is unloaded or the core shuts down. */
  private loading: AbortController | undefined

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
    const journal = options.journal
    const spawn =
      options.spawn ??
      ((spec: ServerSpec, scratchDir: string, signal?: AbortSignal) =>
        spawnServer(spec, scratchDir, {
          http,
          platform,
          env: options.env ?? process.env,
          log,
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
      http,
      gallery: this.gallery,
      loadLock: new AsyncMutex(),
      timings: { ...DEFAULT_JOB_TIMINGS, ...options.timings },
      drawSeed: options.drawSeed ?? drawSeed,
      readSource: readSourceFile,
      isFile,
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
    await ensureDirs([paths.root, paths.backendsDir, paths.modelsDir, this.state.outputDir()])
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

  async finalizeBackendInstall(args: FinalizeBackendInstallArgs): Promise<DiffusionBackendInstallRecord> {
    const record = await finalizeBackendInstall(this.state.paths.backendsDir, args, {
      platform: this.platform,
      log: this.deps.log,
      now: this.deps.now,
    })
    await emitState(this.deps, 'install')
    return record
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
        files.qwen2vl,
      ])
        if (used !== undefined && (await samePath(used, path, this.platform)))
          throw diffusionError(
            'BACKEND_IN_USE',
            'That file belongs to the loaded image model. Unload it first.'
          )
    }
    await deleteModelFile(this.state.paths.modelsDir, path, this.platform)
  }

  // --- session -------------------------------------------------------------------------------------

  async loadModel(request: LoadDiffusionModelRequest): Promise<LoadedDiffusionModel> {
    const { state } = this
    const root = state.paths.backendsDir
    return this.deps.loadLock.run(async () => {
      if (state.closing) throw diffusionError('ENGINE_CRASHED', 'sd-server was stopped.')
      if (state.activeJobId !== undefined)
        await cancelJob(this.deps, state.activeJobId).catch(() => undefined)
      await takeDownSession(this.deps)
      state.spec = undefined

      await checkFiles(request.files)
      const engine = request.engine ?? 'sd-cpp'
      if (engine !== 'sd-cpp')
        throw diffusionError(
          'UNSUPPORTED_BACKEND',
          'Only the stable-diffusion.cpp engine is available in this build.',
          engine
        )
      const record = (await listInstalledBackends(root, this.platform)).find((r) => r.engine === engine)
      if (!record) throw diffusionError('ENGINE_MISSING', 'Install the image engine first.')

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
        defaults: { ...request.defaults },
        ranges: {
          steps: [...request.ranges.steps],
          dims: [...request.ranges.dims],
          dimMultiple: request.ranges.dimMultiple,
        },
        offload: request.offload,
        ...(request.threads !== undefined ? { threads: request.threads } : {}),
        extraArgs: [],
        startupTimeoutMs:
          (request.startupTimeoutSecs !== undefined && request.startupTimeoutSecs > 0
            ? request.startupTimeoutSecs
            : DEFAULT_STARTUP_TIMEOUT_SECS) * 1000,
        cpuFallback: false,
      }
      this.loading = new AbortController()
      try {
        return await loadFromSpec(this.deps, spec, 'load', this.loading.signal)
      } finally {
        this.loading = undefined
      }
    })
  }

  async unloadModel(): Promise<void> {
    this.loading?.abort()
    await this.deps.loadLock.run(async () => {
      if (this.state.activeJobId !== undefined)
        await cancelJob(this.deps, this.state.activeJobId).catch(() => undefined)
      await unload(this.deps, 'unload')
    })
  }

  getCapabilities(): ImageCapabilities {
    return capabilities(this.state)
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

  getJob(jobId: string): ImageJob | null {
    return this.state.job(jobId) ?? null
  }

  cancelJob(jobId: string): Promise<DiffusionCancelResult> {
    return cancelJob(this.deps, jobId)
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
    await shutdownSession(this.deps)
  }

  /** What the events carry; for tests and the facade. */
  static eventNames(): Array<keyof CoreEvents> {
    return ['diffusion:state', 'diffusion:progress', 'diffusion:job', 'diffusion:error']
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
    ['qwen2vl', files.qwen2vl],
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
