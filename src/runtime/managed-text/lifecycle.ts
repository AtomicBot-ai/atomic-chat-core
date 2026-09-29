/**
 * The engine-neutral load lifecycle of a managed text model (openspec change `add-tensorrt-llm-linux`,
 * task 2.12; spec `tensorrt-llm-runtime`, design D8/D11): everything between "load this model in a
 * container" and a `SessionInfo` a caller can talk OpenAI HTTP to, and back again.
 *
 * One load, in order:
 *  1. resolve the adapter by the installation's `adapter_id` (`MANAGED_ADAPTER_UNAVAILABLE` if this
 *     core has none) and let it validate the settings — before anything touches Docker;
 *  2. `stopping-previous`: the caller's own callback (GPU residency, task 2.15) frees the card;
 *  3. `starting-container`: engine cache dir, watchdog script and this generation's heartbeat dir on
 *     disk; the heartbeat ticker running and its first write landed; `docker create` (journalled at
 *     once), `docker start` — with a fresh host port if the one core picked was taken meanwhile;
 *  4. `initializing-engine` (entered when an adapter log marker shows up, or at once if the adapter
 *     has none): poll `docker inspect` and the readiness probe, re-emitting progress with the elapsed
 *     time on every poll. A container that exits fails the load right there, classified by the
 *     adapter from its log tail — never by waiting out the timeout;
 *  5. `ready`: a session gateway with a fresh key in front of the container, and the `SessionInfo`
 *     (`pid: null`, `execution: 'container'`, a new `generation`) carrying the gateway's port and key.
 *
 * Unload, cancel and every failure end the same way: gateway closed, heartbeat stopped, container
 * stopped with Docker's confirmation, then removed, then its journal record dropped. A stop Docker
 * would not confirm keeps the model in `stop-unconfirmed` — no session, but still holding its GPU for
 * task 2.15 to see — and answers `MANAGED_STOP_UNCONFIRMED`; unloading again retries the stop.
 *
 * While that stop is in flight the model is `stopping`: one teardown per entry, shared by every
 * caller (a second unload, a crash noticed meanwhile); a load of the same model waits for it and
 * starts fresh only after a confirmed stop. Every removal from the session table and every event is
 * guarded by the entry's identity, so a finished teardown can never touch a newer load's session.
 *
 * There is no `engine_id` branch here: the engine id only travels into the journal record and the
 * container's discovery labels as data.
 */
import { mkdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  ErrorCode,
  LocalProviderId,
  ModelFamilySupport,
  SessionInfo,
  SessionLoadStage,
} from '../../contracts/index.js'
import type { ManagedScopePaths } from '../../config/index.js'
import {
  CONTAINER_ENGINE_CACHE_PATH,
  CONTAINER_HEARTBEAT_PATH,
  CONTAINER_MODEL_PATH,
  containerLogs,
  createContainer,
  inspectContainer,
  removeContainer,
  startContainer,
  startHeartbeatTicker,
  stopContainer,
  watchdogEnv,
  writeWatchdogScript,
} from '../container/index.js'
import type {
  CreateContainerDeps,
  DockerExec,
  ExecutionJournal,
  HeartbeatTicker,
  HeartbeatTickerOptions,
  ImageRef,
  ModelContainerCreateSpec,
  StopOutcome,
} from '../container/index.js'
import { loadCancelledError, raceLoadCancel } from '../shared/index.js'
import type { EmitFn } from '../shared/index.js'
import type {
  EngineLoadStage,
  ManagedEngineLaunch,
  ManagedExitClassification,
  ManagedTextAdapter,
  ManagedTextAdapterRegistry,
} from './adapter.js'
import { projectSessionPort } from './backend-target.js'
import { ensureEngineCacheDir, removeEngineCaches } from './engine-cache.js'
import type { EngineCacheSelector } from './engine-cache.js'
import { generateGatewayKey, startManagedGateway } from './gateway.js'
import type { ManagedGateway, ManagedGatewayOptions } from './gateway.js'
import {
  advanceStage,
  exitErrorCode,
  isPortBindConflict,
  readContainerState,
  resolveReadinessTimeoutMs,
  stripDockerTimestamps,
} from './load-policy.js'
import { probeReadiness } from './readiness.js'
import type { BackendTarget, ManagedDeployment, PreparedLaunch } from './types.js'

/** The heartbeat file's name inside its generation's directory (and inside the container). */
export const HEARTBEAT_FILE = 'heartbeat'

/**
 * Knobs a test shortens and task 2.19's live measurements may tune. Kept together so nothing else in
 * this file carries a bare number of milliseconds.
 */
export interface ManagedLifecycleTimings {
  /** Between two readiness/exit polls while loading; also how often progress is re-emitted. */
  pollIntervalMs: number
  /** One readiness probe's own deadline. */
  probeTimeoutMs: number
  /** How long the first heartbeat write may take before the load gives up (it never settles on its own if writes keep failing). */
  heartbeatReadyTimeoutMs: number
  /** `docker stop --time`. */
  stopTimeoutSecs: number
  /** How many log lines a failure keeps, and a classifier reads. */
  logTailLines: number
  /** How many host ports a load tries when the one core picked keeps getting taken. */
  portAttempts: number
  /** Between two liveness checks of a ready container. */
  monitorIntervalMs: number
}

export const DEFAULT_MANAGED_LIFECYCLE_TIMINGS: ManagedLifecycleTimings = {
  pollIntervalMs: 1_000,
  probeTimeoutMs: 2_000,
  heartbeatReadyTimeoutMs: 10_000,
  stopTimeoutSecs: 10,
  logTailLines: 200,
  portAttempts: 3,
  monitorIntervalMs: 5_000,
}

export type ManagedLifecycleLogger = (level: 'info' | 'warn' | 'error', message: string) => void

export interface ManagedTextLifecycleDeps {
  /** The provider id every event carries (task 2.14 passes its own). */
  provider: LocalProviderId
  adapters: ManagedTextAdapterRegistry
  exec: DockerExec
  deployment: ManagedDeployment
  journal: ExecutionJournal
  /** This scope's managed paths: heartbeats, engine caches, the watchdog script. */
  paths: ManagedScopePaths
  instanceId: string
  scope: string
  /** The public server's LIVE trusted-hosts array — the same reference, so a later change reaches every gateway. */
  allowedHosts: string[]
  /**
   * The one directory `:z` relabels may stay within under SELinux: this scope's data folder, since a
   * model's directory lives under `<data>/<provider>/models/`, beside `<data>/atomic-core/`.
   */
  selinuxDataRoot: string
  emit: EmitFn
  log?: ManagedLifecycleLogger
  fetch?: typeof fetch
  now?: () => number
  /** Rejects when `signal` aborts. Tests inject a fake clock through this and `now`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  newGeneration?: () => string
  timings?: Partial<ManagedLifecycleTimings>
  startHeartbeat?: (options: HeartbeatTickerOptions) => HeartbeatTicker
  startGateway?: (options: ManagedGatewayOptions) => Promise<ManagedGateway>
  createContainerDeps?: CreateContainerDeps
}

/** The pinned installation a load runs: which descriptor, image and adapter. */
export interface ManagedInstallationRef {
  descriptor_id: string
  engine_id: string
  adapter_id: string
  adapter_contract_version: number
  /** The descriptor's image for this host's platform. */
  image: ImageRef
}

export interface ManagedLoadRequest {
  modelId: string
  /** The model directory as core sees it; mounted read-only. */
  modelPath: string
  weightBytes: number
  installation: ManagedInstallationRef
  /** The descriptor's `model_families` entry for this model's architecture, or null. */
  family: ModelFamilySupport | null
  gpuUuid: string
  /** Whether Docker runs with SELinux (probe snapshot): mounts then get the shared `:z` label. */
  selinux: boolean
  /** Raw provider settings; the adapter validates them. */
  settings: unknown
  /** The provider's readiness-timeout setting; overrides what the adapter computes. */
  timeoutMs?: number
  signal?: AbortSignal
  /**
   * Frees the card first (GPU residency, task 2.15). Runs before any container of this load exists,
   * with the load's own signal — aborted when the load is cancelled or unloaded, so a callback still
   * waiting for its turn gives up rather than stopping sessions for a load that is gone — and the
   * generation this load's reservation carries.
   */
  stopPrevious?: (signal: AbortSignal, generation: string) => Promise<void>
  /**
   * Runs once, after `stopPrevious` has resolved and right before the first `docker create` attempt
   * (task 2.16w round 1, finding 1 (Critical)): a provider's own re-check that only makes sense once
   * whatever `stopPrevious` freed is actually free — free VRAM on the chosen card, for
   * `tensorrt-llm`, re-probed fresh rather than trusted from a snapshot taken before eviction.
   * Throwing refuses the load with no container ever created, the same as `stopPrevious` throwing.
   */
  beforeCreate?: () => Promise<void>
  /** The saved card was gone, so `gpuUuid` is a replacement: every progress event of this load says so. */
  gpuSubstituted?: { requested_gpu_id: string; gpu_id: string }
}

/**
 * `stopping`: a teardown is in flight (unload, failed load or crash). `stop-unconfirmed`: Docker would
 * not confirm the stop, so the GPU stays reserved until an unload retries it.
 */
export type ManagedSessionState = 'loading' | 'ready' | 'stopping' | 'stop-unconfirmed'

/** A model holding (or about to hold) its GPU: what residency (task 2.15) must see, including unconfirmed stops. */
export interface ManagedReservation {
  model_id: string
  generation: string
  gpu_uuid: string
  container_id: string | null
  state: ManagedSessionState
}

/** The logs of a model's last attempt that did not end in a clean unload, kept until its next load. */
export interface ManagedLastAttempt {
  model_id: string
  generation: string
  log_tail: string
  error: { code: ErrorCode; message: string }
  at: number
}

/** A load that ended because the engine exited, or never got ready: carries the classification and log tail. */
export class ManagedLoadError extends AtomicCoreError {
  readonly classification: ManagedExitClassification | undefined
  readonly exitCode: number | null

  constructor(
    code: ErrorCode,
    message: string,
    logTail: string,
    classification?: ManagedExitClassification,
    exitCode: number | null = null
  ) {
    super(code, message, logTail)
    this.name = 'ManagedLoadError'
    this.classification = classification
    this.exitCode = exitCode
  }
}

interface Entry {
  modelId: string
  generation: string
  gpuUuid: string
  descriptorId: string
  modelPath: string
  /** What this session was started with (`loadKeyOf`): a load asking for anything else reloads it. */
  loadKey: string
  /**
   * The validated settings in force: replaced by a later load that joins this session with settings
   * outside the adapter's restart key, which the gateway's rewriter reads on every request.
   */
  settings: unknown
  state: ManagedSessionState
  adapter: ManagedTextAdapter
  /** Aborted by `unload` of a model still loading, and by the caller's own signal. */
  loadAbort: AbortController
  settled?: Promise<unknown> | undefined
  heartbeatDir: string
  containerId?: string | undefined
  ticker?: HeartbeatTicker | undefined
  gateway?: ManagedGateway | undefined
  info?: SessionInfo | undefined
  monitor?: AbortController | undefined
  /** The one teardown in flight for this entry, shared by every caller that wants it stopped. */
  ending?: Promise<StopOutcome | null> | undefined
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(loadCancelledError())
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(loadCancelledError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Rejects after `ms` of real time unless `settle` is called first; never keeps the process alive. */
function deadline(ms: number, error: () => Error): { promise: Promise<never>; settle: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(error()), ms)
    timer.unref?.()
  })
  promise.catch(() => {})
  return { promise, settle: () => clearTimeout(timer) }
}

/**
 * Everything a running container was started with that a later load could ask differently for: the
 * adapter's restart-relevant settings (`restartKey`, all of them by default), the pinned descriptor
 * and image, the card and the model directory. A load of a ready model with the same key joins its
 * session; any difference reloads it, since none of these can change inside a running container
 * (spec "изменение настроек, требующих перезапуска, MUST применяться только при следующей загрузке").
 * A setting outside the restart key — one the gateway enforces per request, or one only a load reads
 * — never costs a restart (findings-2.14-r1.md item 3).
 */
function loadKeyOf(request: ManagedLoadRequest, adapter: ManagedTextAdapter, settings: unknown): string {
  const { installation } = request
  return JSON.stringify([
    adapter.restartKey === undefined ? settings : adapter.restartKey(settings),
    installation.descriptor_id,
    installation.adapter_id,
    installation.adapter_contract_version,
    installation.image.repository,
    installation.image.digest,
    request.gpuUuid,
    request.modelPath,
  ])
}

export class ManagedTextLifecycle {
  private readonly entries = new Map<string, Entry>()
  /** Set by `shutdown()`: from then on no load may start a container. */
  private closed = false
  private readonly lastAttempts = new Map<string, ManagedLastAttempt>()
  private readonly timings: ManagedLifecycleTimings
  private readonly log: ManagedLifecycleLogger
  private readonly fetchFn: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  private readonly newGeneration: () => string
  private readonly startHeartbeat: (options: HeartbeatTickerOptions) => HeartbeatTicker
  private readonly startGateway: (options: ManagedGatewayOptions) => Promise<ManagedGateway>

  constructor(private readonly deps: ManagedTextLifecycleDeps) {
    this.timings = { ...DEFAULT_MANAGED_LIFECYCLE_TIMINGS, ...deps.timings }
    this.log = deps.log ?? (() => {})
    this.fetchFn = deps.fetch ?? fetch
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.newGeneration = deps.newGeneration ?? randomUUID
    this.startHeartbeat = deps.startHeartbeat ?? startHeartbeatTicker
    this.startGateway = deps.startGateway ?? startManagedGateway
  }

  /** Ready sessions only: a loading or stop-unconfirmed model has none to offer. */
  list(): SessionInfo[] {
    return [...this.entries.values()].flatMap((e) => (e.state === 'ready' && e.info ? [e.info] : []))
  }

  findSession(modelId: string): SessionInfo | undefined {
    const entry = this.entries.get(modelId)
    return entry?.state === 'ready' ? entry.info : undefined
  }

  isLoading(modelId: string): boolean {
    return this.entries.get(modelId)?.state === 'loading'
  }

  /** Every model holding its GPU, including one whose stop Docker would not confirm. */
  reservations(): ManagedReservation[] {
    return [...this.entries.values()].map((e) => ({
      model_id: e.modelId,
      generation: e.generation,
      gpu_uuid: e.gpuUuid,
      container_id: e.containerId ?? null,
      state: e.state,
    }))
  }

  lastAttempt(modelId: string): ManagedLastAttempt | undefined {
    return this.lastAttempts.get(modelId)
  }

  /** The loaded model's live log tail, or its last attempt's kept tail, or undefined. */
  async logs(modelId: string): Promise<string | undefined> {
    const entry = this.entries.get(modelId)
    if (entry?.state === 'ready' && entry.containerId !== undefined) {
      return this.tail(entry.containerId)
    }
    return this.lastAttempts.get(modelId)?.log_tail
  }

  /** Removes engine caches, refusing one a container of this core still mounts. */
  async removeEngineCaches(selector: EngineCacheSelector): Promise<string[]> {
    const busy = [...this.entries.values()].find(
      (e) =>
        (selector.modelId === undefined || selector.modelId === e.modelId) &&
        (selector.descriptorId === undefined || selector.descriptorId === e.descriptorId)
    )
    if (busy) {
      throw new AtomicCoreError(
        'MANAGED_RESOURCE_IN_USE',
        'That engine cache is mounted into a container; unload the model first.',
        busy.modelId
      )
    }
    return removeEngineCaches(this.deps.paths, selector)
  }

  async load(request: ManagedLoadRequest): Promise<SessionInfo> {
    this.assertOpen()
    let existing = this.entries.get(request.modelId)
    if (existing?.state === 'stopping') {
      // Wait for the teardown in flight; only a confirmed stop frees the model for a fresh load.
      await existing.ending
      // A shutdown that began while this load waited must not be followed by a new container.
      this.assertOpen()
      existing = this.entries.get(request.modelId)
    }
    if (existing?.state === 'stopping') {
      throw new AtomicCoreError('MANAGED_OPERATION_CONFLICT', 'This model is being stopped.', request.modelId)
    }
    if (existing?.state === 'loading') {
      throw new AtomicCoreError(
        'MANAGED_OPERATION_CONFLICT',
        'This model is already loading.',
        request.modelId
      )
    }
    if (existing?.state === 'stop-unconfirmed') {
      throw new AtomicCoreError(
        'MANAGED_STOP_UNCONFIRMED',
        "This model's previous container has not been confirmed stopped; unload it again first.",
        existing.containerId
      )
    }

    // Validated before a ready session is compared against, or replaced: settings the adapter
    // rejects must never cost the caller the session that is already running.
    const { installation } = request
    const adapter = this.deps.adapters.resolve(installation.adapter_id, installation.adapter_contract_version)
    const settings = adapter.validateSettings(request.settings)
    const timeoutMs = resolveReadinessTimeoutMs(
      adapter.readinessTimeoutMs(request.weightBytes, settings),
      request.timeoutMs
    )
    const loadKey = loadKeyOf(request, adapter, settings)

    if (existing?.state === 'ready' && existing.info) {
      if (existing.loadKey === loadKey) {
        existing.settings = settings
        return existing.info
      }
      await this.unloadEntry(existing)
      this.assertOpen()
      if (this.entries.has(request.modelId)) {
        throw new AtomicCoreError(
          'MANAGED_OPERATION_CONFLICT',
          'Another load of this model started while its previous session was stopping.',
          request.modelId
        )
      }
    }
    if (request.signal?.aborted) throw loadCancelledError()

    const generation = this.newGeneration()
    const loadAbort = new AbortController()
    const forwardAbort = () => loadAbort.abort()
    request.signal?.addEventListener('abort', forwardAbort, { once: true })
    const entry: Entry = {
      modelId: request.modelId,
      generation,
      gpuUuid: request.gpuUuid,
      descriptorId: installation.descriptor_id,
      modelPath: request.modelPath,
      loadKey,
      settings,
      state: 'loading',
      adapter,
      loadAbort,
      heartbeatDir: this.deps.paths.heartbeatDir(generation),
    }
    this.entries.set(request.modelId, entry)
    this.lastAttempts.delete(request.modelId)

    const run = this.runLoad(entry, request, settings, timeoutMs)
    entry.settled = run.catch(() => {})
    try {
      return await run
    } finally {
      request.signal?.removeEventListener('abort', forwardAbort)
    }
  }

  /**
   * Ends the model's session with a Docker-confirmed stop. Unloading a model still loading cancels
   * that load. An unconfirmed stop throws `MANAGED_STOP_UNCONFIRMED` and leaves the model reserved.
   */
  async unload(modelId: string): Promise<void> {
    const entry = this.entries.get(modelId)
    if (!entry) return
    if (entry.state === 'loading') {
      entry.loadAbort.abort()
      await entry.settled
      const after = this.entries.get(modelId)
      if (after === entry && after.state === 'stop-unconfirmed') {
        throw this.stopUnconfirmed(after, 'the cancelled load')
      }
      return
    }
    await this.unloadEntry(entry)
  }

  /** Unloads everything; failures are logged, never thrown, so one stuck container cannot block shutdown. */
  async shutdown(): Promise<void> {
    this.closed = true
    await Promise.all(
      [...this.entries.keys()].map((modelId) =>
        this.unload(modelId).catch((error: unknown) =>
          this.log('warn', `managed-text: unloading ${modelId} at shutdown failed: ${String(error)}`)
        )
      )
    )
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AtomicCoreError(
        'CORE_NOT_RUNNING',
        'The managed runtime is shutting down; nothing new loads.'
      )
    }
  }

  /**
   * Ends a session that is not loading with a Docker-confirmed stop. A teardown already in flight (a
   * second unload, a crash, a failed load) is joined, not repeated, and only the first caller reports
   * `session:unloaded`.
   */
  private async unloadEntry(entry: Entry): Promise<void> {
    const first = entry.ending === undefined
    const outcome = await this.end(entry)
    if (outcome && !outcome.confirmed) throw this.stopUnconfirmed(entry, outcome.reason)
    if (first) {
      this.deps.emit('session:unloaded', { provider: this.deps.provider, model_id: entry.modelId, pid: null })
    }
  }

  // ── load ──────────────────────────────────────────────────────────────────────────────────────

  private async runLoad(
    entry: Entry,
    request: ManagedLoadRequest,
    settings: unknown,
    timeoutMs: number
  ): Promise<SessionInfo> {
    const startedAt = this.now()
    const signal = entry.loadAbort.signal
    const progress = (stage: SessionLoadStage) =>
      this.deps.emit('session:load-progress', {
        provider: this.deps.provider,
        model_id: entry.modelId,
        generation: entry.generation,
        stage,
        elapsed_ms: this.now() - startedAt,
        ...(request.gpuSubstituted === undefined ? {} : { gpu_substituted: request.gpuSubstituted }),
      })

    try {
      if (request.stopPrevious) {
        progress('stopping-previous')
        await raceLoadCancel(request.stopPrevious(signal, entry.generation), signal)
      }
      progress('starting-container')
      const cacheDir = await ensureEngineCacheDir(
        this.deps.paths,
        request.installation.descriptor_id,
        entry.modelId
      )
      const launch = entry.adapter.buildLaunch({
        modelId: entry.modelId,
        settings,
        modelPath: CONTAINER_MODEL_PATH,
        engineCachePath: CONTAINER_ENGINE_CACHE_PATH,
        weightBytes: request.weightBytes,
        family: request.family,
      })
      await writeWatchdogScript(this.deps.paths.watchdogScript)
      await mkdir(entry.heartbeatDir, { recursive: true })
      this.checkAborted(signal)

      entry.ticker = this.startHeartbeat({
        path: join(entry.heartbeatDir, HEARTBEAT_FILE),
        onError: (error) =>
          this.log('warn', `managed-text: heartbeat write failed for ${entry.modelId}: ${String(error)}`),
      })
      await this.firstHeartbeat(entry.ticker, signal)

      const prepared = await this.createAndStart(entry, request, launch, cacheDir, signal)
      await this.waitReady(entry, prepared.target, timeoutMs, progress, signal)

      const apiKey = generateGatewayKey()
      const adapter = entry.adapter
      // What this session can do, for the rewriter to refuse what it cannot (findings-2.14-r1.md
      // item 1): read off the same family the launch was built from, never guessed.
      const capabilities = adapter.capabilities({ settings, family: request.family })
      // Bound here, once, so the gateway itself never needs to know an adapter's settings shape
      // (ManagedTextAdapter.rewriteRequestBody, ADR
      // 2026-09-28-tensorrt-llm-output-cap-enforced-by-the-session-gateway). The settings are read off
      // the entry on every request: a later load that joins this session with new per-request
      // settings (outside the adapter's restart key) takes effect at once. Called through
      // `adapter.rewriteRequestBody(...)`, not a detached local reference to the function, so an
      // implementation that relies on `this` (an object method, not just a plain function like
      // tensorrt-llm's own) still sees `this === adapter` when the gateway invokes it
      // (findings-2.13-r2.md item 4); the same holds for `mapErrorResponse`.
      entry.gateway = await this.startGateway({
        upstream: { host: '127.0.0.1', port: projectSessionPort(prepared.target) },
        apiKey,
        allowedHosts: this.deps.allowedHosts,
        routes: adapter.routes,
        ...(adapter.rewritableRoutes === undefined ? {} : { rewritableRoutes: adapter.rewritableRoutes }),
        ...(adapter.rewriteRequestBody === undefined
          ? {}
          : {
              rewriteRequestBody: (route: string, body: unknown) =>
                adapter.rewriteRequestBody!(route, body, entry.settings, capabilities),
            }),
        ...(adapter.mapErrorResponse === undefined
          ? {}
          : {
              mapErrorResponse: (route: string, status: number, body: string) =>
                adapter.mapErrorResponse!(route, status, body),
            }),
      })
      this.checkAborted(signal)
      entry.info = {
        pid: null,
        port: entry.gateway.port,
        model_id: entry.modelId,
        model_path: entry.modelPath,
        is_embedding: false,
        api_key: apiKey,
        execution: 'container',
        generation: entry.generation,
      }
      entry.state = 'ready'
      progress('ready')
      this.startMonitor(entry)
      return entry.info
    } catch (error) {
      const failure = signal.aborted ? loadCancelledError() : error
      await this.failLoad(entry, failure)
      throw failure
    }
  }

  private checkAborted(signal: AbortSignal): void {
    if (signal.aborted) throw loadCancelledError()
  }

  /** The watchdog must see a live heartbeat from its first poll; `ready` never settles on its own if writes keep failing. */
  private async firstHeartbeat(ticker: HeartbeatTicker, signal: AbortSignal): Promise<void> {
    const limit = deadline(
      this.timings.heartbeatReadyTimeoutMs,
      () =>
        new AtomicCoreError(
          'IO_ERROR',
          'The container heartbeat file could not be written, so the watchdog would stop the engine.',
          `no successful write within ${this.timings.heartbeatReadyTimeoutMs} ms`
        )
    )
    try {
      await raceLoadCancel(Promise.race([ticker.ready, limit.promise]), signal)
    } finally {
      limit.settle()
    }
  }

  private createSpec(
    request: ManagedLoadRequest,
    launch: ManagedEngineLaunch,
    cacheDir: string,
    prepared: PreparedLaunch
  ): ModelContainerCreateSpec {
    return {
      image: request.installation.image,
      gpuUuid: request.gpuUuid,
      selinux: request.selinux,
      ...(request.selinux ? { selinuxDataRoot: this.deps.selinuxDataRoot } : {}),
      mounts: {
        // One resolver for all four mounts: the deployment's, which also resolved `heartbeat`.
        model: { source: this.deps.deployment.mountSource(request.modelPath) },
        engineCache: { source: this.deps.deployment.mountSource(cacheDir) },
        entrypoint: { source: this.deps.deployment.mountSource(this.deps.paths.watchdogScript) },
        heartbeat: { source: prepared.heartbeat.mount_source },
      },
      publication: prepared.publication,
      labels: {
        engine_id: request.installation.engine_id,
        scope: this.deps.scope,
        instance_id: this.deps.instanceId,
      },
      // The watchdog's own settings come last: an adapter can never switch it off or retime it.
      env: {
        ...launch.env,
        ...watchdogEnv({ heartbeatFile: `${CONTAINER_HEARTBEAT_PATH}/${HEARTBEAT_FILE}` }),
      },
      command: ['--', ...launch.argv],
    }
  }

  /**
   * `docker create` + journal + `docker start`. Core picked the host port, so another process can
   * bind it before Docker does; that one failure is retried with a new port (bounded), everything
   * else fails the load. `beforeCreate` runs once, before the first attempt — never repeated on a
   * port-bind retry — since it is about whether the card has room, not about the host port.
   */
  private async createAndStart(
    entry: Entry,
    request: ManagedLoadRequest,
    launch: ManagedEngineLaunch,
    cacheDir: string,
    signal: AbortSignal
  ): Promise<PreparedLaunch> {
    if (request.beforeCreate) {
      await raceLoadCancel(request.beforeCreate(), signal)
      this.checkAborted(signal)
    }
    for (let attempt = 1; ; attempt++) {
      const prepared = await this.deps.deployment.prepareLaunch(launch.engine, entry.heartbeatDir)
      this.checkAborted(signal)
      const spec = this.createSpec(request, launch, cacheDir, prepared)
      const { containerId } = await createContainer(this.deps.exec, spec, this.deps.createContainerDeps)
      entry.containerId = containerId
      try {
        await this.deps.journal.add({
          container_id: containerId,
          engine_id: request.installation.engine_id,
          image_digest: request.installation.image.digest,
          scope: this.deps.scope,
          instance_id: this.deps.instanceId,
          created_at: new Date(this.now()).toISOString(),
        })
      } catch (error) {
        // Never started, and not journalled: remove it now, or nothing would ever find it again.
        await removeContainer(this.deps.exec, containerId).catch((rmError: unknown) =>
          this.log(
            'error',
            `managed-text: container ${containerId} is neither journalled nor removed; remove it by hand ` +
              `(journal: ${String(error)}; rm: ${String(rmError)})`
          )
        )
        entry.containerId = undefined
        throw error
      }
      this.checkAborted(signal)
      try {
        await startContainer(this.deps.exec, containerId)
        return prepared
      } catch (error) {
        if (!isPortBindConflict(error) || attempt >= this.timings.portAttempts) throw error
        this.log(
          'warn',
          `managed-text: host port ${prepared.publication.host_port} was taken before docker could bind it; retrying on another`
        )
        await removeContainer(this.deps.exec, containerId)
        await this.deps.journal.remove(containerId)
        entry.containerId = undefined
      }
    }
  }

  private async waitReady(
    entry: Entry,
    target: BackendTarget,
    timeoutMs: number,
    progress: (stage: SessionLoadStage) => void,
    signal: AbortSignal
  ): Promise<void> {
    const containerId = entry.containerId as string
    const { adapter } = entry
    const deadlineAt = this.now() + timeoutMs
    let stage: EngineLoadStage = advanceStage('starting-container', adapter.stageMarkers, '')
    let redirectWarned = false
    for (;;) {
      this.checkAborted(signal)
      const state = await inspectContainer(this.deps.exec, containerId)
        .then(readContainerState)
        .catch((error: unknown) => {
          // A docker hiccup is not an exit: keep waiting, the timeout still bounds the load.
          this.log(
            'warn',
            `managed-text: docker inspect failed while loading ${entry.modelId}: ${String(error)}`
          )
          return { exited: false, exitCode: null }
        })
      if (state.exited) throw await this.exitFailure(containerId, adapter, state.exitCode)

      if (stage !== 'initializing-engine') {
        stage = advanceStage(stage, adapter.stageMarkers, await this.tail(containerId).catch(() => ''))
      }
      progress(stage)

      const outcome = await probeReadiness(
        this.fetchFn,
        target,
        adapter.readiness,
        this.timings.probeTimeoutMs
      )
      if (outcome === 'ready') return
      if (outcome === 'redirect' && !redirectWarned) {
        redirectWarned = true
        this.log(
          'warn',
          `managed-text: ${entry.modelId}'s readiness probe answered a redirect; not following it`
        )
      }
      if (this.now() >= deadlineAt) {
        const tail = await this.tail(containerId).catch(() => '')
        throw new ManagedLoadError(
          'MODEL_LOAD_TIMED_OUT',
          `The engine did not become ready within ${Math.round(timeoutMs / 1000)} s.`,
          tail
        )
      }
      await this.sleep(this.timings.pollIntervalMs, signal)
    }
  }

  private async exitFailure(
    containerId: string,
    adapter: ManagedTextAdapter,
    exitCode: number | null
  ): Promise<ManagedLoadError> {
    const tail = await this.tail(containerId).catch(() => '')
    const classification = adapter.classifyExit(tail, exitCode)
    return new ManagedLoadError(
      exitErrorCode(classification.kind),
      classification.message,
      tail,
      classification,
      exitCode
    )
  }

  private async tail(containerId: string): Promise<string> {
    return stripDockerTimestamps(await containerLogs(this.deps.exec, containerId, this.timings.logTailLines))
  }

  private async failLoad(entry: Entry, failure: unknown): Promise<void> {
    let logTail = failure instanceof ManagedLoadError ? (failure.details ?? '') : ''
    if (!(failure instanceof ManagedLoadError) && entry.containerId !== undefined) {
      logTail = await this.tail(entry.containerId).catch(() => '')
    }
    const error =
      failure instanceof AtomicCoreError
        ? { code: failure.code, message: failure.message }
        : { code: 'MODEL_LOAD_FAILED' as ErrorCode, message: String(failure) }
    this.lastAttempts.set(entry.modelId, {
      model_id: entry.modelId,
      generation: entry.generation,
      log_tail: logTail,
      error,
      at: this.now(),
    })
    await this.end(entry)
  }

  // ── stop ──────────────────────────────────────────────────────────────────────────────────────

  private stopUnconfirmed(entry: Entry, reason: string): AtomicCoreError {
    return new AtomicCoreError(
      'MANAGED_STOP_UNCONFIRMED',
      'Docker did not confirm the model container stopped; its GPU stays reserved. Unload again to retry.',
      `${entry.containerId ?? 'no container'}: ${reason}`
    )
  }

  /**
   * Gateway closed, heartbeat stopped, container stopped (confirmed) and removed, journal record
   * dropped. `null` when there was no container to stop. An unconfirmed stop leaves the entry in
   * `stop-unconfirmed` with its container id, for a later retry and for residency to see.
   *
   * The heartbeat stops either way: if Docker merely lost track of an engine that is still running,
   * the watchdog inside then ends it within its stale limit.
   */
  /**
   * The one way an entry is stopped: `stopping` while the teardown runs, then gone (confirmed, or no
   * container at all) or `stop-unconfirmed`. Concurrent callers share the same promise. A teardown
   * that throws counts as unconfirmed — nothing proved the container stopped. The entry leaves the
   * table only if it is still the one there, never a newer load's.
   *
   * `beforeStop` runs once the session is withdrawn but before the container is stopped and removed:
   * a crash reads its log tail there, while the entry is already `stopping`, so no load in the
   * meantime can be handed the dead session.
   */
  private end(entry: Entry, beforeStop?: () => Promise<void>): Promise<StopOutcome | null> {
    if (entry.ending) return entry.ending
    entry.state = 'stopping'
    entry.ending = this.teardown(entry, beforeStop)
      .catch((error: unknown): StopOutcome => {
        this.log('error', `managed-text: stopping ${entry.modelId} failed: ${String(error)}`)
        return { confirmed: false, reason: String(error) }
      })
      .then((outcome) => {
        if (outcome !== null && !outcome.confirmed) entry.state = 'stop-unconfirmed'
        else if (this.entries.get(entry.modelId) === entry) this.entries.delete(entry.modelId)
        entry.ending = undefined
        return outcome
      })
    return entry.ending
  }

  private async teardown(entry: Entry, beforeStop?: () => Promise<void>): Promise<StopOutcome | null> {
    entry.monitor?.abort()
    entry.monitor = undefined
    entry.info = undefined
    if (entry.gateway) {
      const gateway = entry.gateway
      entry.gateway = undefined
      await gateway.close().catch(() => {})
    }
    entry.ticker?.stop()
    entry.ticker = undefined
    await beforeStop?.().catch((error: unknown) =>
      this.log('warn', `managed-text: before stopping ${entry.modelId}: ${String(error)}`)
    )

    if (entry.containerId === undefined) {
      await rm(entry.heartbeatDir, { recursive: true, force: true }).catch(() => {})
      return null
    }
    const containerId = entry.containerId
    const outcome = await stopContainer(this.deps.exec, containerId, this.timings.stopTimeoutSecs)
    if (!outcome.confirmed) return outcome
    try {
      await removeContainer(this.deps.exec, containerId)
      await this.deps.journal.remove(containerId)
    } catch (error) {
      // The engine has exited, so the session is over; the journal keeps the record and the next
      // startup's reconcile removes whatever is left.
      this.log(
        'warn',
        `managed-text: container ${containerId} stopped but could not be removed: ${String(error)}`
      )
    }
    entry.containerId = undefined
    await rm(entry.heartbeatDir, { recursive: true, force: true }).catch(() => {})
    return outcome
  }

  // ── crash after ready ─────────────────────────────────────────────────────────────────────────

  private startMonitor(entry: Entry): void {
    const monitor = new AbortController()
    entry.monitor = monitor
    const containerId = entry.containerId as string
    void (async () => {
      for (;;) {
        try {
          await this.sleep(this.timings.monitorIntervalMs, monitor.signal)
        } catch {
          return
        }
        if (monitor.signal.aborted || entry.state !== 'ready') return
        const state = await inspectContainer(this.deps.exec, containerId)
          .then(readContainerState)
          .catch(() => ({ exited: false, exitCode: null }))
        if (monitor.signal.aborted || entry.state !== 'ready') return
        if (state.exited) {
          await this.onCrash(entry, state.exitCode)
          return
        }
      }
    })()
  }

  /**
   * The entry turns `stopping` synchronously, before its log tail is read: a load arriving while the
   * tail is still being fetched waits for this teardown instead of being handed the dead session.
   */
  private async onCrash(entry: Entry, exitCode: number | null): Promise<void> {
    if (entry.state !== 'ready' || this.entries.get(entry.modelId) !== entry) return
    const containerId = entry.containerId as string
    let message = ''
    await this.end(entry, async () => {
      const tail = await this.tail(containerId).catch(() => '')
      const classification = entry.adapter.classifyExit(tail, exitCode)
      message = classification.message
      this.lastAttempts.set(entry.modelId, {
        model_id: entry.modelId,
        generation: entry.generation,
        log_tail: tail,
        error: { code: exitErrorCode(classification.kind), message: classification.message },
        at: this.now(),
      })
    })
    this.deps.emit('session:died', {
      provider: this.deps.provider,
      pid: null,
      model_id: entry.modelId,
      exit_code: exitCode,
      signal: null,
      message,
    })
  }
}
