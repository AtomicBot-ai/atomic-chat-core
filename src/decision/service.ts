/**
 * The decision module's surface: one `llama-server --decision` process at most, its lifecycle, and
 * the calls the rest of the core makes to it.
 *
 * Outside the sessions registry on purpose (ADR 2026-09-30-the-decision-model-is-its-own-core-module):
 * a chat model switch unloads every other local session and the chat auto-unload policy would treat
 * the decision model as one more text model, while the router must stay up across both. So nothing
 * here is a `LocalRuntime`; the module borrows only process mechanics.
 *
 * What it guarantees:
 *  - `scoreCandidates` and `decide` never throw and never wait longer than their budget (500 ms by
 *    default): every failure is `{unavailable: true, reason}`, and the caller keeps its default policy;
 *  - start and stop are serialized, and a stop aborts a start still waiting for readiness;
 *  - a process that dies after it was ready is restarted with backoff, at most `MAX_RESTARTS` times in
 *    a row; a start that fails is not retried until a setting changes, `load` is asked for, or a
 *    TurboQuant build is installed (`onEnginesChanged`); an `unsupported` module is also retried in
 *    the background by a call, at most once per `UNSUPPORTED_RETRY_MS`, quietly (no `starting` on the
 *    way, and no event at all when it lands where it was);
 *  - the engine builds readiness refused are tried again after each of those three triggers (a build
 *    installed, `load`, a launch setting changed), but not by a background retry;
 *  - every state change is a `decision:state` event, and a failure nobody awaits a `decision:error`.
 */

import { stat } from 'node:fs/promises'
import { AtomicCoreError } from '../contracts/index.js'
import type {
  CoreEvents,
  DecisionEngineInfo,
  DecisionErrorEvent,
  DecisionOutcome,
  DecisionQuestion,
  DecisionSettings,
  DecisionState,
  DecisionStatus,
  DecisionTruncation,
  RouterCandidate,
  RouterScoreResponse,
  SystemoneResponse,
} from '../contracts/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import type { DecisionBackend, DecisionTarget } from '../server/index.js'
import { decisionThreads, resolveDataPath } from './args.js'
import type { ThreadFacts } from './args.js'
import { nextRestartCount, restartDelayMs, shouldGiveUp } from './backoff.js'
import { DecisionAbortedError, DecisionTimeoutError } from './http.js'
import type { DecisionHttp } from './http.js'
import {
  isRouterScoreBody,
  isSystemoneBody,
  NOT_CALIBRATED_MESSAGE,
  outcomeFromAnswer,
  refusalForState,
  scoresMatchCandidates,
  unavailable,
} from './outcome.js'
import { DECISION_TERMINATE_GRACE_MS } from './process.js'
import type { DecisionProcessHandle, DecisionServerSpec } from './process.js'

export const ROUTER_SCORE_PATH = '/v1/router/score'
export const SYSTEMONE_PATH = '/v1/systemone'

/**
 * How often a call may retry an `unsupported` module in the background. The state only clears when
 * a build that serves `--decision` appears on disk; an install through this core says so at once
 * (`onEnginesChanged`), this catches one made by anything else. Each retry costs a directory scan
 * and, for a pack not probed yet, one `-h`.
 */
export const UNSUPPORTED_RETRY_MS = 5 * 60_000
/** Engine builds a start may skip after readiness refused them, before it gives up. */
export const MAX_ENGINE_ATTEMPTS = 8

export type DecisionEmitter = <K extends 'decision:state' | 'decision:error'>(
  name: K,
  payload: CoreEvents[K]
) => void
export type DecisionLogger = (level: 'info' | 'warn' | 'debug', msg: string) => void

export interface DecisionCallOptions {
  /** Overrides `settings.decision.timeout_ms` for this call. */
  timeoutMs?: number
  /** The caller gave up; the call answers `aborted` at once. */
  signal?: AbortSignal
  truncation?: DecisionTruncation
}

export interface DecisionServiceDeps {
  /** The core's data folder: relative model and spec paths are resolved against it. */
  dataFolder: string
  readSettings: () => DecisionSettings
  /** A checked write of the `decision` settings section (`SettingsStore.updateDecision`). */
  writeSettings: (patch: Record<string, unknown>) => Promise<unknown>
  /** The engine gate (`DecisionEngineResolver.resolve`). */
  resolveEngine: (enginePath: string) => Promise<DecisionEngineInfo>
  /**
   * A resolved build started but readiness refused it (`DECISION_ENGINE_UNSUPPORTED`, for example
   * API version 2): the gate skips it from now on (`DecisionEngineResolver.reject`), and the start
   * resolves again. Without it the first refusal ends the start.
   */
  rejectEngine?: (exe: string, why: string) => Promise<void>
  /**
   * Try every build `rejectEngine` refused again (`DecisionEngineResolver.forgetRejected`): called when
   * a build is installed, on an explicit `load`, and on a start with other launch settings.
   */
  forgetRejectedEngines?: () => void
  /** CPU facts for the automatic thread count. */
  cpu: () => Promise<Omit<ThreadFacts, 'setting'>>
  /** Start one process and wait for readiness (`spawnDecisionServer` plus the journal). */
  spawn: (spec: DecisionServerSpec, signal: AbortSignal) => Promise<DecisionProcessHandle>
  http: DecisionHttp
  emit: DecisionEmitter
  log: DecisionLogger
  now?: () => number
  fileExists?: (path: string) => Promise<boolean>
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

function errorOf(error: unknown): DecisionErrorEvent {
  if (error instanceof AtomicCoreError)
    return error.details === undefined
      ? { code: error.code, message: error.message }
      : { code: error.code, message: error.message, details: error.details }
  return { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
}

function sameError(a: DecisionErrorEvent | null, b: DecisionErrorEvent): boolean {
  return a !== null && a.code === b.code && a.message === b.message && a.details === b.details
}

function describeExit(exit: ExitInfo): string {
  if (exit.code !== null) return `code ${exit.code}`
  if (exit.signal !== null) return `signal ${exit.signal}`
  return 'an unknown status'
}

/** The settings a running process was started with; any change means a restart. */
function launchKey(settings: DecisionSettings): string {
  const { model_path, model_id, spec_path, threads, allow_uncalibrated, engine_path } = settings
  return JSON.stringify([model_path, model_id, spec_path, threads, allow_uncalibrated, engine_path])
}

type StartMode = 'load' | 'restart'

/** States a public request keeps waiting through: a start is on its way. */
const WAITABLE_STATES: ReadonlySet<DecisionState> = new Set(['idle', 'starting', 'restarting'])

export class DecisionService {
  private state: Omit<DecisionStatus, 'enabled' | 'model_path'>
  private handle: DecisionProcessHandle | undefined
  private runningKey: string | undefined
  /** `launchKey` of the start in flight, from the moment it read the settings. */
  private loadingKey: string | undefined
  private readySince = 0
  /** `launchKey` of the last start: a start with another one tries the refused builds again. */
  private lastLaunchKey: string | undefined
  /** When a call last retried an `unsupported` module; a quiet retry that changes nothing emits nothing. */
  private lastQuietRetry = Number.NEGATIVE_INFINITY
  private loading: Promise<DecisionProcessHandle> | undefined
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

  constructor(private readonly deps: DecisionServiceDeps) {
    this.now = deps.now ?? Date.now
    this.schedule = deps.schedule ?? defaultSchedule
    this.state = {
      state: deps.readSettings().enabled ? 'idle' : 'disabled',
      engine: null,
      pid: null,
      port: null,
      props: null,
      capabilities: [],
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

  getStatus(): DecisionStatus {
    const settings = this.deps.readSettings()
    return {
      ...this.state,
      capabilities: [...this.state.capabilities],
      enabled: settings.enabled,
      model_path: resolveDataPath(this.deps.dataFolder, settings.model_path) ?? null,
    }
  }

  getConfig(): DecisionSettings {
    return this.deps.readSettings()
  }

  /** Write settings, then bring the process in line with them. */
  async configure(patch: Record<string, unknown>): Promise<DecisionStatus> {
    await this.deps.writeSettings(patch)
    return this.reconcile()
  }

  /**
   * After a settings change: turned off → stop; started (or starting) with other launch settings →
   * restart; enabled and not running (idle, failed, unsupported) → start in the background. The crash
   * count starts over. A change that does not touch the launch (`timeout_ms`, `idle_unload_secs`, …)
   * leaves a running process or a start in flight alone; `idle_unload_secs` takes effect at once.
   */
  async reconcile(): Promise<DecisionStatus> {
    const settings = this.deps.readSettings()
    if (!settings.enabled) {
      await this.unload()
      return this.getStatus()
    }
    const running = this.handle !== undefined || this.loading !== undefined
    // No key yet means a start queued behind another operation: it reads the settings when it runs.
    const key = this.runningKey ?? this.loadingKey
    if (running && key !== undefined && key !== launchKey(settings)) await this.unload()
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
   * A llama.cpp (TurboQuant) build was installed: a module that is `unsupported` or `failed` tries
   * again, since the new build may be the first that serves `--decision`. Any other state is left as
   * it is.
   */
  async onEnginesChanged(): Promise<DecisionStatus> {
    const settings = this.deps.readSettings()
    if (this.stopping || !settings.enabled) return this.getStatus()
    // The new build may replace one readiness refused, or a refusal may no longer hold.
    this.deps.forgetRejectedEngines?.()
    if (this.state.state !== 'unsupported' && this.state.state !== 'failed') return this.getStatus()
    this.deps.log('info', 'a TurboQuant build was installed; trying the decision model again')
    return this.reconcile()
  }

  /**
   * Start now (or join the start in flight) and answer once it is ready; a failure is thrown. A new
   * start tries again every engine build readiness refused before: the user asked for it.
   */
  async load(): Promise<DecisionStatus> {
    if (!this.handle && !this.loading) this.deps.forgetRejectedEngines?.()
    if (this.state.state === 'failed' || this.state.state === 'restarting') {
      this.cancelRestart?.()
      this.cancelRestart = undefined
      if (this.state.restarts !== 0) this.setState({ restarts: 0 })
    }
    await this.ensureLoaded('load')
    return this.getStatus()
  }

  /** Stop the process (or the start in flight). The module stays enabled: the next call starts it again. */
  async unload(): Promise<DecisionStatus> {
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
        props: null,
        capabilities: [],
        error: null,
      })
    })
    return this.getStatus()
  }

  /**
   * `POST /v1/router/score`: independent, calibrated `p_success` per candidate. Fail-open: never
   * throws, never waits past the budget.
   */
  scoreCandidates(
    task: string,
    criterion: string,
    candidates: RouterCandidate[],
    options: DecisionCallOptions = {}
  ): Promise<DecisionOutcome<RouterScoreResponse>> {
    const body = {
      task,
      criterion,
      candidates,
      ...(options.truncation ? { truncation: options.truncation } : {}),
    }
    const ids = candidates.map((c) => c.id)
    const check = (answer: unknown): answer is RouterScoreResponse =>
      isRouterScoreBody(answer) && scoresMatchCandidates(answer, ids)
    return this.call(ROUTER_SCORE_PATH, body, options, check)
  }

  /** `POST /v1/systemone`: TypeSafe-style questions about `state`. Fail-open like `scoreCandidates`. */
  decide(
    state: unknown,
    questions: Record<string, DecisionQuestion>,
    options: DecisionCallOptions = {}
  ): Promise<DecisionOutcome<SystemoneResponse>> {
    const body = { state, questions, ...(options.truncation ? { truncation: options.truncation } : {}) }
    return this.call(SYSTEMONE_PATH, body, options, isSystemoneBody)
  }

  /** What the public server forwards `/systemone` and `/router/score` to. */
  publicBackend(): DecisionBackend {
    return { acquire: (waitMs, signal) => this.acquire(waitMs, signal) }
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

  private setState(patch: Partial<Omit<DecisionStatus, 'enabled' | 'model_path'>>): void {
    this.state = { ...this.state, ...patch, since: patch.state !== undefined ? this.now() : this.state.since }
    if (!this.stopping) this.deps.emit('decision:state', this.getStatus())
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

  /**
   * `quietCode`: a background retry of a state the app already heard about. A failure with this code
   * is not reported again, and the start shows no `starting` on its way (see `startProcess`).
   */
  private startInBackground(mode: StartMode, quietCode?: string): void {
    // A start already on its way has its own reporter; joining it would report its failure twice.
    if (this.handle || this.loading) return
    this.ensureLoaded(mode, quietCode !== undefined).catch((error: unknown) => {
      if (mode === 'load' && errorOf(error).code !== quietCode) this.reportUnawaited(error)
    })
  }

  /** An `unsupported` module whose state is older than `UNSUPPORTED_RETRY_MS` tries again, quietly. */
  private retryUnsupported(settings: DecisionSettings): void {
    if (this.state.state !== 'unsupported' || !settings.enabled || settings.model_path === '') return
    if (this.handle || this.loading) return
    // A quiet retry that ends where it started emits nothing, so `since` does not move: keep its own clock.
    if (this.now() - Math.max(this.state.since, this.lastQuietRetry) < UNSUPPORTED_RETRY_MS) return
    this.lastQuietRetry = this.now()
    this.startInBackground('load', 'DECISION_ENGINE_UNSUPPORTED')
  }

  private reportUnawaited(error: unknown): void {
    const body = errorOf(error)
    // A start stopped by an unload or a shutdown is not a failure anyone needs to hear about.
    if (body.code === 'DECISION_UNAVAILABLE' || this.stopping) return
    this.deps.log('warn', `decision model: ${body.message}${body.details ? ` (${body.details})` : ''}`)
    this.deps.emit('decision:error', body)
  }

  private ensureLoaded(mode: StartMode, quiet = false): Promise<DecisionProcessHandle> {
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
   * `quiet`: a background retry of an `unsupported` module. It does not announce `starting` (the app
   * would flash a start for every retry that finds nothing new) and, when it fails the same way again,
   * leaves the state as it was without an event. A retry that gets further is reported as usual.
   */
  private async startProcess(mode: StartMode, quiet = false): Promise<DecisionProcessHandle> {
    if (this.handle) return this.handle
    if (this.stopping) throw new AtomicCoreError('DECISION_UNAVAILABLE', 'The core is shutting down.')
    const settings = this.deps.readSettings()
    const abort = new AbortController()
    this.loadAbort = abort
    const key = launchKey(settings)
    this.loadingKey = key
    if (key !== this.lastLaunchKey) {
      // A refusal may have come from the launch (the spec, the model): other settings, another try.
      if (this.lastLaunchKey !== undefined) this.deps.forgetRejectedEngines?.()
      this.lastLaunchKey = key
    }
    let engine = this.state.engine
    try {
      if (!settings.enabled)
        throw new AtomicCoreError('DECISION_NOT_CONFIGURED', 'The decision model is turned off.')
      const modelPath = resolveDataPath(this.deps.dataFolder, settings.model_path)
      if (modelPath === undefined)
        throw new AtomicCoreError('DECISION_NOT_CONFIGURED', 'No decision model file is configured.')
      const exists = this.deps.fileExists ?? defaultFileExists
      if (!(await exists(modelPath)))
        throw new AtomicCoreError(
          'MODEL_FILE_NOT_FOUND',
          'The decision model file does not exist.',
          modelPath
        )
      const specPath = resolveDataPath(this.deps.dataFolder, settings.spec_path)
      if (specPath !== undefined && !(await exists(specPath)))
        throw new AtomicCoreError('MODEL_FILE_NOT_FOUND', 'The decision spec file does not exist.', specPath)
      if (!quiet) this.setState({ state: mode === 'restart' ? 'restarting' : 'starting', error: null })
      const threads = decisionThreads({ setting: settings.threads, ...(await this.deps.cpu()) })
      const onEngine = (chosen: DecisionEngineInfo) => {
        engine = chosen
        if (!quiet) this.setState({ engine })
      }
      const handle = await this.spawnOnFirstGoodEngine(settings, abort.signal, onEngine, (engine) => ({
        engine,
        modelPath,
        ...(specPath !== undefined ? { specPath } : {}),
        ...(settings.model_id !== '' ? { modelId: settings.model_id } : {}),
        threads,
        allowUncalibrated: settings.allow_uncalibrated,
        startupTimeoutMs: settings.startup_timeout_secs * 1000,
      }))
      if (abort.signal.aborted || this.stopping) {
        await handle.terminate(DECISION_TERMINATE_GRACE_MS)
        throw new AtomicCoreError('DECISION_UNAVAILABLE', 'The decision model start was stopped.')
      }
      this.handle = handle
      this.runningKey = key
      this.readySince = this.now()
      this.setState({
        state: 'ready',
        engine,
        pid: handle.pid,
        port: handle.port,
        props: handle.props,
        capabilities: [...handle.capabilities],
        error: null,
      })
      void handle.exited.then((exit) => this.onExit(handle, exit))
      this.armIdle()
      return handle
    } catch (error) {
      const body = errorOf(error)
      if (body.code === 'DECISION_UNAVAILABLE') throw error
      if (mode === 'restart') {
        this.onRestartFailed(body)
        throw error
      }
      const state: DecisionState =
        body.code === 'DECISION_ENGINE_UNSUPPORTED'
          ? 'unsupported'
          : body.code === 'DECISION_NOT_CONFIGURED'
            ? settings.enabled
              ? 'idle'
              : 'disabled'
            : 'failed'
      if (!(quiet && state === this.state.state && sameError(this.state.error, body)))
        this.setState({ state, engine, pid: null, port: null, props: null, capabilities: [], error: body })
      throw error
    } finally {
      if (this.loadAbort === abort) this.loadAbort = undefined
      if (this.loadingKey === key) this.loadingKey = undefined
    }
  }

  /**
   * Resolve an engine and spawn it; a resolved build that readiness refuses as unsupported (an API
   * version this core does not speak, a dev build with an unfinished decision API) is handed to
   * `rejectEngine` and the next one is tried, so a valid lower-ranked build still runs. An explicit
   * `engine_path` has nothing to fall back to: its refusal ends the start.
   */
  private async spawnOnFirstGoodEngine(
    settings: DecisionSettings,
    signal: AbortSignal,
    onEngine: (engine: DecisionEngineInfo) => void,
    specFor: (engine: DecisionEngineInfo) => DecisionServerSpec
  ): Promise<DecisionProcessHandle> {
    for (let attempt = 1; ; attempt++) {
      const engine = await this.deps.resolveEngine(settings.engine_path)
      onEngine(engine)
      if (signal.aborted)
        throw new AtomicCoreError('DECISION_UNAVAILABLE', 'The decision model start was stopped.')
      try {
        return await this.deps.spawn(specFor(engine), signal)
      } catch (error) {
        const fallback =
          error instanceof AtomicCoreError &&
          error.code === 'DECISION_ENGINE_UNSUPPORTED' &&
          settings.engine_path === '' &&
          this.deps.rejectEngine !== undefined &&
          attempt < MAX_ENGINE_ATTEMPTS
        if (!fallback) throw error
        const why = error.details ?? error.message
        this.deps.log('warn', `decision engine ${engine.path} refused at readiness, trying the next: ${why}`)
        await this.deps.rejectEngine?.(engine.path, why)
      }
    }
  }

  private onExit(handle: DecisionProcessHandle, exit: ExitInfo): void {
    if (this.handle !== handle) return
    this.handle = undefined
    this.runningKey = undefined
    this.cancelIdle?.()
    this.cancelIdle = undefined
    if (this.stopping) return
    const tail = handle.tail().slice(-20).join('\n')
    const error: DecisionErrorEvent = {
      code: 'DECISION_UNAVAILABLE',
      message: `The decision model exited unexpectedly with ${describeExit(exit)}.`,
      ...(tail ? { details: tail } : {}),
    }
    this.deps.log('warn', error.message)
    this.deps.emit('decision:error', error)
    const restarts = nextRestartCount(this.state.restarts, this.now() - this.readySince)
    this.scheduleRestart(restarts, error)
  }

  private onRestartFailed(error: DecisionErrorEvent): void {
    this.deps.log('warn', `decision model restart failed: ${error.message}`)
    this.deps.emit('decision:error', error)
    this.scheduleRestart(this.state.restarts + 1, error)
  }

  private scheduleRestart(restarts: number, error: DecisionErrorEvent): void {
    const cleared = { pid: null, port: null, props: null, capabilities: [], restarts, error }
    if (shouldGiveUp(restarts)) {
      this.setState({ state: 'failed', ...cleared })
      return
    }
    this.setState({ state: 'restarting', ...cleared })
    const delay = restartDelayMs(restarts)
    this.deps.log('info', `restarting the decision model in ${delay} ms (attempt ${restarts})`)
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
    if (handle) await handle.terminate(DECISION_TERMINATE_GRACE_MS)
  }

  /** (Re)arm the idle unload; a call in flight pushes it back. */
  private armIdle(): void {
    this.cancelIdle?.()
    this.cancelIdle = undefined
    const secs = this.deps.readSettings().idle_unload_secs
    if (secs <= 0 || !this.handle || this.stopping) return
    this.cancelIdle = this.schedule(() => {
      this.cancelIdle = undefined
      if (this.inFlight > 0) return this.armIdle()
      this.deps.log('info', 'unloading the decision model after idling')
      void this.unload()
    }, secs * 1000)
  }

  private async call<T>(
    path: string,
    body: unknown,
    options: DecisionCallOptions,
    check: (body: unknown) => body is T
  ): Promise<DecisionOutcome<T>> {
    const started = this.now()
    const elapsed = () => this.now() - started
    try {
      if (options.signal?.aborted) return unavailable('aborted', 'The caller gave up before the call.', 0)
      const settings = this.deps.readSettings()
      const handle = this.handle
      if (!handle) {
        const configured = settings.model_path !== ''
        const refusal = refusalForState(this.state.state, configured) ?? {
          reason: 'not_running' as const,
          message: 'The decision model is not running.',
        }
        if (this.state.state === 'idle' && settings.enabled && configured) this.startInBackground('load')
        else this.retryUnsupported(settings)
        return unavailable(refusal.reason, refusal.message, elapsed())
      }
      // The process says it will refuse the router (no calibration, no `--decision-allow-uncalibrated`):
      // answer that without a round trip. `capabilities` is not the signal, since `router_score` is
      // missing from it even when the flag makes the router available.
      if (path === ROUTER_SCORE_PATH && handle.props.router?.available === false)
        return unavailable('not_calibrated', NOT_CALIBRATED_MESSAGE, elapsed())
      // Serialized before the request: a BigInt or a cycle in `state` is the caller's input, not a
      // transport failure.
      let payload: string
      try {
        payload = JSON.stringify(body)
      } catch (error) {
        return unavailable(
          'rejected',
          `The request could not be serialized as JSON: ${error instanceof Error ? error.message : String(error)}`,
          elapsed()
        )
      }
      this.inFlight++
      try {
        const answer = await this.deps.http.request(`${handle.baseUrl}${path}`, {
          method: 'POST',
          apiKey: handle.apiKey,
          body: payload,
          timeoutMs: options.timeoutMs ?? settings.timeout_ms,
          ...(options.signal ? { signal: options.signal } : {}),
        })
        return outcomeFromAnswer(answer.status, answer.text, elapsed(), check)
      } finally {
        this.inFlight--
        this.armIdle()
      }
    } catch (error) {
      if (error instanceof DecisionTimeoutError)
        return unavailable(
          'timeout',
          `The decision model did not answer within ${error.timeoutMs} ms.`,
          elapsed()
        )
      if (error instanceof DecisionAbortedError) return unavailable('aborted', error.message, elapsed())
      return unavailable(
        'transport_error',
        `The decision model could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        elapsed()
      )
    }
  }

  /**
   * The public route's target. An enabled, configured module that is idle is started (a failure is a
   * `decision:error`, as for a call); one that is starting or restarting is waited on, up to `waitMs`,
   * until it is ready or lands in a state no start will leave (failed, unsupported, disabled), or the
   * client leaves (`signal`).
   */
  private async acquire(waitMs: number, signal?: AbortSignal): Promise<DecisionTarget> {
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
      const refusal = refusalForState(this.state.state, settings.model_path !== '') ?? {
        reason: 'not_running',
        message: 'The decision model is not running.',
      }
      const detail = this.state.error ? ` ${this.state.error.message}` : ''
      return { ok: false, reason: refusal.reason, message: `${refusal.message}${detail}` }
    }
    this.inFlight++
    let released = false
    return {
      ok: true,
      port: handle.port,
      apiKey: handle.apiKey,
      release: () => {
        if (released) return
        released = true
        this.inFlight--
        this.armIdle()
      },
    }
  }

  /** The handle once there is one; `undefined` on timeout, on `signal`, or once no start is on its way. */
  private waitForHandle(waitMs: number, signal?: AbortSignal): Promise<DecisionProcessHandle | undefined> {
    return new Promise((resolve) => {
      const done = (handle: DecisionProcessHandle | undefined) => {
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
      // Declared before anything can call `done`: the timer, the signal and `check` all come after.
      const cancelTimer = this.schedule(() => done(undefined), waitMs)
      this.waiters.add(check)
      signal?.addEventListener('abort', onAbort, { once: true })
      check()
    })
  }
}
