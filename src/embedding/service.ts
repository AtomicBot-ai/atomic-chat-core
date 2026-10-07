/**
 * The embedding module's surface: one embedding `llama-server` at most (stock llama.cpp), its
 * lifecycle, and the target the public `/v1/embeddings` forwards to.
 *
 * Outside the sessions registry on purpose, like the decision model
 * (ADR 2026-10-07-embedding-models-are-their-own-core-module): a chat model switch unloads every
 * other session of its provider, and the model the API serves must stay up across it. So nothing here
 * is a `LocalRuntime`; the module borrows only process mechanics.
 *
 * What it guarantees (the decision module's rules, minus the fail-open calls):
 *  - start and stop are serialized, and a stop aborts a start still waiting for readiness;
 *  - a process that dies after it was ready is restarted with backoff, at most `MAX_RESTARTS` times in
 *    a row; a start that fails is not retried until a setting changes, `load` is asked for, or a
 *    llama.cpp build is installed (`onEnginesChanged`); an `unsupported` module is also retried in
 *    the background by a request, at most once per `UNSUPPORTED_RETRY_MS`, quietly;
 *  - a request to a module that is enabled but idle starts it and waits for it (`acquire`);
 *  - every state change is an `embedding:state` event, and a failure nobody awaits an `embedding:error`.
 */

import { stat } from 'node:fs/promises'
import { AtomicCoreError } from '../contracts/index.js'
import type {
  CoreEvents,
  EmbeddingEmbedResponse,
  EmbeddingEngineInfo,
  EmbeddingErrorEvent,
  EmbeddingSettings,
  EmbeddingState,
  EmbeddingStatus,
} from '../contracts/index.js'
import { nextRestartCount, resolveDataPath, restartDelayMs, shouldGiveUp } from '../decision/index.js'
import type { DecisionHttp } from '../decision/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import type { EmbeddingBackend, EmbeddingTarget } from '../server/index.js'
import { defaultEmbeddingModelId } from './args.js'
import {
  embeddingCtxSize,
  embeddingMinBuild,
  embeddingPooling,
  notAnEmbeddingModel,
  readEmbeddingModelFacts,
} from './model-facts.js'
import type { EmbeddingModelFacts } from './model-facts.js'
import { EMBEDDING_TERMINATE_GRACE_MS } from './process.js'
import type { EmbeddingProcessHandle, EmbeddingServerSpec } from './process.js'
import { EMBEDDINGS_PATH } from './readiness.js'

/** How often a request may retry an `unsupported` module in the background. */
export const UNSUPPORTED_RETRY_MS = 5 * 60_000
/** Engine builds a start may skip after readiness refused them, before it gives up. */
export const MAX_ENGINE_ATTEMPTS = 8
/** The control route's own request budget, once the model runs. */
export const EMBED_REQUEST_TIMEOUT_MS = 120_000

export type EmbeddingEmitter = <K extends 'embedding:state' | 'embedding:error'>(
  name: K,
  payload: CoreEvents[K]
) => void
export type EmbeddingLogger = (level: 'info' | 'warn' | 'debug', msg: string) => void

export interface EmbeddingServiceDeps {
  /** The core's data folder: relative model paths are resolved against it. */
  dataFolder: string
  readSettings: () => EmbeddingSettings
  /** A checked write of the `embedding` settings section (`SettingsStore.updateEmbedding`). */
  writeSettings: (patch: Record<string, unknown>) => Promise<unknown>
  /** The engine gate (`EmbeddingEngineResolver.resolve`). */
  resolveEngine: (enginePath: string, minBuild: number) => Promise<EmbeddingEngineInfo>
  /** A resolved build that readiness refused: skipped from now on (`EmbeddingEngineResolver.reject`). */
  rejectEngine?: (exe: string, why: string) => Promise<void>
  /** Try every refused build again (`EmbeddingEngineResolver.forgetRejected`). */
  forgetRejectedEngines?: () => void
  /** Start one process and wait for readiness (`spawnEmbeddingServer` plus the journal). */
  spawn: (spec: EmbeddingServerSpec, signal: AbortSignal) => Promise<EmbeddingProcessHandle>
  http: DecisionHttp
  emit: EmbeddingEmitter
  log: EmbeddingLogger
  now?: () => number
  /** Whether a file exists. */
  fileExists?: (path: string) => Promise<boolean>
  /** What the GGUF header says (`readEmbeddingModelFacts`); `undefined` when it cannot be read. */
  readModelFacts?: (path: string) => Promise<EmbeddingModelFacts | undefined>
  /** Run `fn` after `ms`; returns the cancel. The default timer never keeps the process alive. */
  schedule?: (fn: () => void, ms: number) => () => void
}

const defaultSchedule = (fn: () => void, ms: number): (() => void) => {
  const timer = setTimeout(fn, ms)
  timer.unref()
  return () => clearTimeout(timer)
}

const defaultFileExists = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

function errorOf(error: unknown): EmbeddingErrorEvent {
  if (error instanceof AtomicCoreError)
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details }
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
}

function sameError(a: EmbeddingErrorEvent | null, b: EmbeddingErrorEvent): boolean {
  return a !== null && a.code === b.code && a.message === b.message && a.details === b.details
}

function describeExit(exit: ExitInfo): string {
  if (exit.code !== null) return `code ${exit.code}`
  if (exit.signal !== null) return `signal ${exit.signal}`
  return 'an unknown status'
}

/** The settings a running process was started with; any change means a restart. */
export function embeddingLaunchKey(settings: EmbeddingSettings): string {
  const { model_path, mmproj_path, model_id, ctx_size, pooling, image_max_tokens, threads, engine_path } =
    settings
  return JSON.stringify([
    model_path,
    mmproj_path,
    model_id,
    ctx_size,
    pooling,
    image_max_tokens,
    threads,
    engine_path,
  ])
}

/** The name API clients pass as `model`: the setting, else the file name; `null` without a model. */
export function embeddingModelIdOf(settings: EmbeddingSettings): string | null {
  if (settings.model_path.trim() === '') return null
  return settings.model_id !== '' ? settings.model_id : defaultEmbeddingModelId(settings.model_path)
}

/** Why a request cannot reach the model in `state`, for the public route's 503. */
export function embeddingRefusal(state: EmbeddingState, configured: boolean): string {
  if (state === 'disabled') return 'The embedding model is turned off.'
  if (!configured) return 'No embedding model is configured.'
  if (state === 'unsupported') return 'No installed llama.cpp build can run the embedding model.'
  if (state === 'failed') return 'The embedding model failed to start.'
  if (state === 'starting' || state === 'restarting') return 'The embedding model is still starting.'
  return 'The embedding model is not running.'
}

type StartMode = 'load' | 'restart'

/** States a public request keeps waiting through: a start is on its way. */
const WAITABLE_STATES: ReadonlySet<EmbeddingState> = new Set(['idle', 'starting', 'restarting'])

type InternalState = Omit<EmbeddingStatus, 'enabled' | 'model_path' | 'model_id'>

export class EmbeddingService {
  private state: InternalState
  private handle: EmbeddingProcessHandle | undefined
  private runningKey: string | undefined
  /** `embeddingLaunchKey` of the start in flight, from the moment it read the settings. */
  private loadingKey: string | undefined
  private readySince = 0
  /** `embeddingLaunchKey` of the last start: a start with another one tries the refused builds again. */
  private lastLaunchKey: string | undefined
  /** When a request last retried an `unsupported` module; a quiet retry that changes nothing emits nothing. */
  private lastQuietRetry = Number.NEGATIVE_INFINITY
  private loading: Promise<EmbeddingProcessHandle> | undefined
  private loadAbort: AbortController | undefined
  private cancelRestart: (() => void) | undefined
  private cancelIdle: (() => void) | undefined
  private inFlight = 0
  private stopping = false
  /** Called on every state change and when a start settles: the public route's waits. */
  private readonly waiters = new Set<() => void>()
  /** Start and stop, one at a time. */
  private chain: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private readonly schedule: (fn: () => void, ms: number) => () => void

  constructor(private readonly deps: EmbeddingServiceDeps) {
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? defaultSchedule
    this.state = {
      state: deps.readSettings().enabled ? 'idle' : 'disabled',
      engine: null,
      pid: null,
      port: null,
      dims: null,
      modalities: [],
      restarts: 0,
      error: null,
      since: this.now(),
    }
  }

  /** Called once by the owner: an enabled and configured module starts in the background. */
  start(): void {
    const settings = this.deps.readSettings()
    if (settings.enabled && settings.model_path !== '') this.startInBackground('load')
  }

  getStatus(): EmbeddingStatus {
    const settings = this.deps.readSettings()
    return {
      ...this.state,
      modalities: [...this.state.modalities],
      enabled: settings.enabled,
      model_path: resolveDataPath(this.deps.dataFolder, settings.model_path) ?? null,
      model_id: embeddingModelIdOf(settings),
    }
  }

  getConfig(): EmbeddingSettings {
    return this.deps.readSettings()
  }

  /** Write settings, then bring the process in line with them. */
  async configure(patch: Record<string, unknown>): Promise<EmbeddingStatus> {
    await this.deps.writeSettings(patch)
    return this.reconcile()
  }

  /**
   * After a settings change: turned off → stop; started (or starting) with other launch settings →
   * restart; enabled and not running → start in the background. The crash count starts over. A change
   * that does not touch the launch (`idle_unload_secs`, `startup_timeout_secs`) leaves a running
   * process alone; `idle_unload_secs` takes effect at once.
   */
  async reconcile(): Promise<EmbeddingStatus> {
    const settings = this.deps.readSettings()
    if (!settings.enabled) {
      await this.unload()
      return this.getStatus()
    }
    const running = this.handle !== undefined || this.loading !== undefined
    const key = this.runningKey ?? this.loadingKey
    if (running && key !== undefined && key !== embeddingLaunchKey(settings)) await this.unload()
    if (this.handle === undefined && this.loading === undefined) {
      this.cancelRestart?.()
      this.cancelRestart = undefined
      if (this.state.restarts !== 0) this.setState({ restarts: 0 })
      if (settings.model_path !== '') this.startInBackground('load')
      else this.setState({ state: 'idle', error: null })
    } else if (this.handle !== undefined) {
      this.armIdle()
    }
    return this.getStatus()
  }

  /**
   * A llama.cpp build was installed: a module that is `unsupported` or `failed` tries again, since the
   * new build may be the first new enough for the model. Installs of other providers are ignored.
   */
  async onEnginesChanged(provider?: string): Promise<EmbeddingStatus> {
    const settings = this.deps.readSettings()
    if (this.stopping || !settings.enabled) return this.getStatus()
    if (provider !== undefined && provider !== 'llamacpp-upstream') return this.getStatus()
    this.deps.forgetRejectedEngines?.()
    if (this.state.state !== 'unsupported' && this.state.state !== 'failed') return this.getStatus()
    this.deps.log('info', 'a llama.cpp build was installed; trying the embedding model again')
    return this.reconcile()
  }

  /** Start now (or join the start in flight) and answer once it is ready; a failure is thrown. */
  async load(): Promise<EmbeddingStatus> {
    if (!this.handle && !this.loading) this.deps.forgetRejectedEngines?.()
    if (this.state.state === 'failed' || this.state.state === 'restarting') {
      this.cancelRestart?.()
      this.cancelRestart = undefined
      if (this.state.restarts !== 0) this.setState({ restarts: 0 })
    }
    await this.ensureLoaded('load')
    return this.getStatus()
  }

  /** Stop the process (or the start in flight). The module stays enabled: the next request starts it again. */
  async unload(): Promise<EmbeddingStatus> {
    this.cancelRestart?.()
    this.cancelRestart = undefined
    this.loadAbort?.abort()
    await this.serial(async () => {
      await this.stopProcess()
      const enabled = this.deps.readSettings().enabled
      this.setState({
        state: enabled ? 'idle' : 'disabled',
        pid: null,
        port: null,
        dims: null,
        modalities: [],
        error: null,
      })
    })
    return this.getStatus()
  }

  /**
   * One `/v1/embeddings` request for the app (`POST /atomic/v1/embedding/embed`): the module is
   * started when it is enabled and idle, the body is sent with the running model's name, and the
   * engine's answer comes back as it is. `EMBEDDING_UNAVAILABLE` when the model cannot be reached.
   */
  async embed(body: Record<string, unknown>): Promise<EmbeddingEmbedResponse> {
    const settings = this.deps.readSettings()
    const target = await this.acquire(settings.startup_timeout_secs * 1000)
    if (!target.ok) throw new AtomicCoreError('EMBEDDING_UNAVAILABLE', target.message)
    try {
      const answer = await this.deps.http.request(`http://127.0.0.1:${target.port}${EMBEDDINGS_PATH}`, {
        method: 'POST',
        apiKey: target.apiKey,
        body: JSON.stringify({ ...body, model: target.modelId }),
        timeoutMs: EMBED_REQUEST_TIMEOUT_MS,
      })
      let parsed: unknown
      try {
        parsed = JSON.parse(answer.text)
      } catch {
        parsed = answer.text
      }
      return { status: answer.status, body: parsed }
    } catch (error) {
      throw new AtomicCoreError(
        'EMBEDDING_UNAVAILABLE',
        'The embedding model did not answer.',
        error instanceof Error ? error.message : String(error)
      )
    } finally {
      target.release()
    }
  }

  /** What the public server forwards `/embeddings` to. */
  publicBackend(): EmbeddingBackend {
    return {
      acquire: (waitMs, signal) => this.acquire(waitMs, signal),
      modelId: () => {
        const settings = this.deps.readSettings()
        return settings.enabled ? embeddingModelIdOf(settings) : null
      },
    }
  }

  /** Stop everything for good: timers, a start in flight, the process. No events after this. */
  async shutdown(): Promise<void> {
    this.stopping = true
    this.cancelRestart?.()
    this.cancelIdle?.()
    this.loadAbort?.abort()
    this.notifyWaiters()
    await this.chain.catch(() => {})
    await this.loading?.catch(() => {})
    await this.stopProcess()
  }

  // --- internals -------------------------------------------------------------------------------

  private setState(patch: Partial<InternalState>): void {
    this.state = { ...this.state, ...patch, since: patch.state !== undefined ? this.now() : this.state.since }
    if (!this.stopping) this.deps.emit('embedding:state', this.getStatus())
    this.notifyWaiters()
  }

  private notifyWaiters(): void {
    for (const waiter of [...this.waiters]) waiter()
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const run = this.chain.then(op, op)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** `quietCode`: a background retry of a state the app already heard about (see `startProcess`). */
  private startInBackground(mode: StartMode, quietCode?: string): void {
    if (this.handle || this.loading) return
    this.ensureLoaded(mode, quietCode !== undefined).catch((error: unknown) => {
      if (mode === 'load' && errorOf(error).code !== quietCode) this.reportUnawaited(error)
    })
  }

  /** An `unsupported` module whose state is older than `UNSUPPORTED_RETRY_MS` tries again, quietly. */
  private retryUnsupported(settings: EmbeddingSettings): void {
    if (this.state.state !== 'unsupported' || !settings.enabled || settings.model_path === '') return
    if (this.handle || this.loading) return
    if (this.now() - Math.max(this.state.since, this.lastQuietRetry) < UNSUPPORTED_RETRY_MS) return
    this.lastQuietRetry = this.now()
    this.startInBackground('load', 'EMBEDDING_ENGINE_UNSUPPORTED')
  }

  private reportUnawaited(error: unknown): void {
    const body = errorOf(error)
    // A start stopped by an unload or a shutdown is not a failure anyone needs to hear about.
    if (body.code === 'EMBEDDING_UNAVAILABLE' || this.stopping) return
    this.deps.log('warn', `embedding model: ${body.message}${body.details ? ` (${body.details})` : ''}`)
    this.deps.emit('embedding:error', body)
  }

  private ensureLoaded(mode: StartMode, quiet = false): Promise<EmbeddingProcessHandle> {
    if (this.handle) return Promise.resolve(this.handle)
    if (this.loading) return this.loading
    const started = this.serial(() => this.startProcess(mode, quiet)).finally(() => {
      if (this.loading === started) this.loading = undefined
      this.notifyWaiters()
    })
    this.loading = started
    return started
  }

  /**
   * `quiet`: a background retry of an `unsupported` module. It does not announce `starting` and, when
   * it fails the same way again, leaves the state as it was without an event.
   */
  private async startProcess(mode: StartMode, quiet = false): Promise<EmbeddingProcessHandle> {
    if (this.handle) return this.handle
    if (this.stopping) throw new AtomicCoreError('EMBEDDING_UNAVAILABLE', 'The core is shutting down.')
    const settings = this.deps.readSettings()
    const abort = new AbortController()
    this.loadAbort = abort
    const key = embeddingLaunchKey(settings)
    this.loadingKey = key
    if (key !== this.lastLaunchKey) {
      if (this.lastLaunchKey !== undefined) this.deps.forgetRejectedEngines?.()
      this.lastLaunchKey = key
    }
    let engine = this.state.engine
    try {
      if (!settings.enabled)
        throw new AtomicCoreError('EMBEDDING_NOT_CONFIGURED', 'The embedding model is turned off.')
      const modelPath = resolveDataPath(this.deps.dataFolder, settings.model_path)
      if (modelPath === undefined)
        throw new AtomicCoreError('EMBEDDING_NOT_CONFIGURED', 'No embedding model file is configured.')
      const exists = this.deps.fileExists ?? defaultFileExists
      if (!(await exists(modelPath)))
        throw new AtomicCoreError('MODEL_FILE_NOT_FOUND', 'The embedding model does not exist.', modelPath)
      const mmprojPath = resolveDataPath(this.deps.dataFolder, settings.mmproj_path)
      if (mmprojPath !== undefined && !(await exists(mmprojPath)))
        throw new AtomicCoreError(
          'MODEL_FILE_NOT_FOUND',
          'The embedding model projector does not exist.',
          mmprojPath
        )
      const facts = await (this.deps.readModelFacts ?? readEmbeddingModelFacts)(modelPath)
      if (facts === undefined)
        throw new AtomicCoreError(
          'MODEL_LOAD_FAILED',
          'The embedding model file is not a readable GGUF.',
          modelPath
        )
      const refusal = notAnEmbeddingModel(facts)
      if (refusal !== undefined)
        throw new AtomicCoreError(
          'EMBEDDING_MODEL_NOT_EMBEDDING',
          `The file cannot run as an embedding model. ${refusal}`,
          modelPath
        )
      if (!quiet) this.setState({ state: mode === 'restart' ? 'restarting' : 'starting', error: null })
      const modelId = embeddingModelIdOf(settings) as string
      const pooling = embeddingPooling(settings.pooling, facts)
      const minBuild = embeddingMinBuild(facts.arch, mmprojPath !== undefined)
      const handle = await this.spawnOnFirstGoodEngine(
        settings,
        minBuild,
        abort.signal,
        (chosen) => {
          engine = chosen
          if (!quiet) this.setState({ engine })
        },
        (chosen) => ({
          engine: chosen,
          modelPath,
          ...(mmprojPath !== undefined ? { mmprojPath } : {}),
          modelId,
          ctxSize: embeddingCtxSize(settings.ctx_size, facts.contextTrain),
          ...(pooling !== undefined ? { pooling } : {}),
          ...(settings.image_max_tokens > 0 ? { imageMaxTokens: settings.image_max_tokens } : {}),
          ...(settings.threads > 0 ? { threads: settings.threads } : {}),
          startupTimeoutMs: settings.startup_timeout_secs * 1000,
        })
      )
      if (abort.signal.aborted || this.stopping) {
        await handle.terminate(EMBEDDING_TERMINATE_GRACE_MS)
        throw new AtomicCoreError('EMBEDDING_UNAVAILABLE', 'The embedding model start was stopped.')
      }
      this.handle = handle
      this.runningKey = key
      this.readySince = this.now()
      this.setState({
        state: 'ready',
        engine,
        pid: handle.pid,
        port: handle.port,
        dims: handle.dims,
        modalities: [...handle.modalities],
        error: null,
      })
      void handle.exited.then((exit) => this.onExit(handle, exit))
      this.armIdle()
      return handle
    } catch (error) {
      const body = errorOf(error)
      if (body.code === 'EMBEDDING_UNAVAILABLE') throw error
      if (mode === 'restart') {
        this.onRestartFailed(body)
        throw error
      }
      const state: EmbeddingState =
        body.code === 'EMBEDDING_ENGINE_UNSUPPORTED'
          ? 'unsupported'
          : body.code === 'EMBEDDING_NOT_CONFIGURED'
            ? settings.enabled
              ? 'idle'
              : 'disabled'
            : 'failed'
      if (!(quiet && state === this.state.state && sameError(this.state.error, body)))
        this.setState({ state, engine, pid: null, port: null, dims: null, modalities: [], error: body })
      throw error
    } finally {
      if (this.loadAbort === abort) this.loadAbort = undefined
      if (this.loadingKey === key) this.loadingKey = undefined
    }
  }

  /**
   * Resolve an engine and spawn it; a build that readiness refuses as unsupported is handed to
   * `rejectEngine` and the next one is tried. An explicit `engine_path` has nothing to fall back to.
   */
  private async spawnOnFirstGoodEngine(
    settings: EmbeddingSettings,
    minBuild: number,
    signal: AbortSignal,
    onEngine: (engine: EmbeddingEngineInfo) => void,
    specFor: (engine: EmbeddingEngineInfo) => EmbeddingServerSpec
  ): Promise<EmbeddingProcessHandle> {
    for (let attempt = 1; ; attempt++) {
      const engine = await this.deps.resolveEngine(settings.engine_path, minBuild)
      onEngine(engine)
      if (signal.aborted)
        throw new AtomicCoreError('EMBEDDING_UNAVAILABLE', 'The embedding model start was stopped.')
      try {
        return await this.deps.spawn(specFor(engine), signal)
      } catch (error) {
        const fallback =
          error instanceof AtomicCoreError &&
          error.code === 'EMBEDDING_ENGINE_UNSUPPORTED' &&
          settings.engine_path === '' &&
          this.deps.rejectEngine !== undefined &&
          attempt < MAX_ENGINE_ATTEMPTS
        if (!fallback) throw error
        const why = error.details ?? error.message
        this.deps.log('warn', `embedding engine ${engine.path} refused at readiness, trying the next: ${why}`)
        await this.deps.rejectEngine?.(engine.path, why)
      }
    }
  }

  private onExit(handle: EmbeddingProcessHandle, exit: ExitInfo): void {
    if (this.handle !== handle) return
    this.handle = undefined
    this.runningKey = undefined
    this.cancelIdle?.()
    this.cancelIdle = undefined
    if (this.stopping) return
    const tail = handle.tail().slice(-20).join('\n')
    const error: EmbeddingErrorEvent = {
      code: 'EMBEDDING_UNAVAILABLE',
      message: `The embedding model exited unexpectedly with ${describeExit(exit)}.`,
      ...(tail ? { details: tail } : {}),
    }
    this.deps.log('warn', error.message)
    this.deps.emit('embedding:error', error)
    const restarts = nextRestartCount(this.state.restarts, this.now() - this.readySince)
    this.scheduleRestart(restarts, error)
  }

  private onRestartFailed(error: EmbeddingErrorEvent): void {
    this.deps.log('warn', `embedding model restart failed: ${error.message}`)
    this.deps.emit('embedding:error', error)
    this.scheduleRestart(this.state.restarts + 1, error)
  }

  private scheduleRestart(restarts: number, error: EmbeddingErrorEvent): void {
    const cleared = { pid: null, port: null, dims: null, modalities: [], restarts, error }
    if (shouldGiveUp(restarts)) {
      this.setState({ state: 'failed', ...cleared })
      return
    }
    this.setState({ state: 'restarting', ...cleared })
    const delay = restartDelayMs(restarts)
    this.deps.log('info', `restarting the embedding model in ${delay} ms (attempt ${restarts})`)
    this.cancelRestart = this.schedule(() => {
      this.cancelRestart = undefined
      if (this.stopping || !this.deps.readSettings().enabled) return
      this.startInBackground('restart')
    }, delay)
  }

  private async stopProcess(): Promise<void> {
    this.cancelIdle?.()
    this.cancelIdle = undefined
    const handle = this.handle
    this.handle = undefined
    this.runningKey = undefined
    if (handle) await handle.terminate(EMBEDDING_TERMINATE_GRACE_MS)
  }

  /** (Re)arm the idle unload; a request in flight pushes it back. */
  private armIdle(): void {
    this.cancelIdle?.()
    this.cancelIdle = undefined
    const secs = this.deps.readSettings().idle_unload_secs
    if (secs <= 0 || !this.handle || this.stopping) return
    this.cancelIdle = this.schedule(() => {
      this.cancelIdle = undefined
      if (this.inFlight > 0) return this.armIdle()
      this.deps.log('info', 'unloading the embedding model after idling')
      void this.unload()
    }, secs * 1000)
  }

  /**
   * The public route's target. An enabled, configured module that is idle is started (a failure is an
   * `embedding:error`); one that is starting or restarting is waited on, up to `waitMs`, until it is
   * ready or lands in a state no start will leave, or the client leaves (`signal`).
   */
  private async acquire(waitMs: number, signal?: AbortSignal): Promise<EmbeddingTarget> {
    const settings = this.deps.readSettings()
    let handle = this.handle
    const configured = settings.enabled && settings.model_path !== ''
    if (!handle && configured && WAITABLE_STATES.has(this.state.state) && !signal?.aborted) {
      if (this.state.state === 'idle') this.startInBackground('load')
      handle = await this.waitForHandle(waitMs, signal)
    } else if (!handle) {
      this.retryUnsupported(settings)
    }
    if (!handle) {
      const detail = this.state.error ? ` ${this.state.error.message}` : ''
      return {
        ok: false,
        reason: this.state.state,
        message: `${embeddingRefusal(this.state.state, settings.model_path !== '')}${detail}`,
      }
    }
    this.inFlight++
    let released = false
    return {
      ok: true,
      port: handle.port,
      apiKey: handle.apiKey,
      modelId: handle.modelId,
      dims: handle.dims,
      modalities: [...handle.modalities],
      release: () => {
        if (released) return
        released = true
        this.inFlight--
        this.armIdle()
      },
    }
  }

  /** The handle once there is one; `undefined` on timeout, on `signal`, or once no start is on its way. */
  private waitForHandle(waitMs: number, signal?: AbortSignal): Promise<EmbeddingProcessHandle | undefined> {
    return new Promise((resolve) => {
      const done = (handle: EmbeddingProcessHandle | undefined) => {
        this.waiters.delete(check)
        cancelTimer()
        signal?.removeEventListener('abort', onAbort)
        resolve(handle)
      }
      const check = () => {
        if (this.handle) return done(this.handle)
        const state = this.state.state
        // `idle` counts only while a start is in flight: an idle module with none is not coming up.
        const coming = WAITABLE_STATES.has(state) && (state !== 'idle' || this.loading !== undefined)
        if (this.stopping || !coming) done(undefined)
      }
      const onAbort = () => done(undefined)
      const cancelTimer = this.schedule(() => done(undefined), waitMs)
      this.waiters.add(check)
      signal?.addEventListener('abort', onAbort, { once: true })
      check()
    })
  }
}
