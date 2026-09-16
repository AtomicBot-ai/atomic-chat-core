/**
 * `AtomicCore` — the owner process assembled from its parts (PLAN.md §3.3, §3.4, §3.6).
 *
 * Creating one *is* taking ownership of a data folder: it acquires the instance lock, mints the
 * control token, cleans up backend processes the previous owner left behind, starts the control
 * listener and only then publishes its endpoint. A client that sees `state: "ready"` in the lock can
 * dial the port and expect an answer.
 *
 * The public `/v1` listener is deliberately not started here — it is a separate, optional listener
 * whose stop must never take control down with it.
 */

import { AtomicCoreError, CONTROL_PROTOCOL_VERSION } from './contracts/index.js'
import type { ReadyLine } from './contracts/index.js'
import type { LocalApiServerState, LocalProviderId, SessionInfo, UnloadResult } from './contracts/index.js'
import { dataLayout, nodeDataFolderEnv, resolveDataFolder } from './config/index.js'
import { writeFile } from 'node:fs/promises'
import type { DataLayout } from './config/index.js'
import { CoreEmitter } from './events/index.js'
import {
  InstanceLock,
  ProcessJournal,
  assertNotLoadedByLegacy,
  acquireModelClaim,
  isProcessAlive,
  verifyProcessIdentity,
  writeControlToken,
} from './lock/index.js'
import type { ChildProcessRecord } from './lock/index.js'
import type { ModelClaimHandle } from './lock/index.js'
import { EmbedService, ModelCapabilityService, ModelRegistry } from './models/index.js'
import { ensureBackend, readRuntimeSettings } from './backend/runtime-backend.js'
import { LlamacppRuntime } from './runtime/llamacpp/index.js'
import type { LoadOptions } from './runtime/llamacpp/index.js'
import { SettingsStore } from './settings/index.js'
import type { SettingsScope } from './settings/index.js'
import { HardwareOverrideStore } from './hardware/index.js'
import {
  BackendService,
  ManifestSessionCache,
  OptimalBackendStore,
  fetchLiveManifest,
  manifestTransportFromFetch,
  selectInstalledBackend,
} from './backend/index.js'
import { Downloader, createPolicyFetch } from './downloads/index.js'
import type { CtxIncreaseResult } from './runtime/llamacpp/runtime.js'
import {
  ClientRegistry,
  ControlServer,
  DEFAULT_PUBLIC_HOST,
  DEFAULT_PUBLIC_PORT,
  DEFAULT_PUBLIC_PREFIX,
  PublicServer,
  stoppedState,
} from './server/index.js'
import type { SessionSummary } from './server/index.js'
import { CORE_VERSION } from './version.js'

export { CORE_VERSION }

export type CoreLogger = (level: 'info' | 'warn' | 'error', message: string) => void

export interface AtomicCoreOptions {
  /** Explicit data folder; otherwise resolved like the app does (PLAN.md §8.2 "Папка данных"). */
  dataFolder?: string
  /** Where the app's bundled sidecar binaries live (`resources/bin`); needed for MLX and Foundation Models. */
  resourcesDir?: string
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** 'owner' takes the instance lock; 'auto' is the same today — attaching is the CLI's job. */
  role?: 'owner' | 'auto'
  controlHost?: string
  /** 0 (the default) picks a free port and publishes it in the lock. */
  controlPort?: number
  logger?: CoreLogger
}

export interface PublicServerStartOptions {
  host?: string
  port?: number
  prefix?: string
  apiKey?: string
  trustedHosts?: string[]
  corsEnabled?: boolean
}

interface NormalizedPublicServerOptions {
  host: string
  port: number
  prefix: string
  apiKey: string
  trustedHosts: string[]
  corsEnabled: boolean
}

export const LOCAL_PROVIDER: LocalProviderId = 'llamacpp-upstream'

export class AtomicCore {
  readonly version = CORE_VERSION
  private publicServer: PublicServer | undefined
  private lastPublicState: LocalApiServerState = stoppedState()
  private lifecycle: 'running' | 'stopping' | 'stopped' = 'running'
  private shutdownPromise: Promise<void> | undefined
  private publicConfig: NormalizedPublicServerOptions | undefined
  private publicTransition: Promise<void> = Promise.resolve()
  private readonly modelClaims = new Map<string, ModelClaimHandle>()
  private readonly claimingModels = new Map<string, Promise<ModelClaimHandle>>()
  private resolveStopped: (() => void) | undefined
  /** Resolves once this core has stopped, however that was triggered (API, signal, or in-process). */
  readonly stopped: Promise<void> = new Promise<void>((resolve) => {
    this.resolveStopped = resolve
  })

  private constructor(
    readonly layout: DataLayout,
    readonly events: CoreEmitter,
    readonly settings: SettingsStore,
    readonly clients: ClientRegistry,
    private readonly lock: InstanceLock,
    private readonly journal: ProcessJournal,
    private readonly runtimes: Map<LocalProviderId, LlamacppRuntime>,
    private readonly registries: Map<LocalProviderId, ModelRegistry>,
    readonly control: ControlServer,
    private readonly log: CoreLogger,
    readonly controlToken: string
  ) {}

  get instanceId(): string {
    return this.lock.instanceId
  }

  /** Take ownership of a data folder and start the control listener. */
  static async create(options: AtomicCoreOptions = {}): Promise<AtomicCore> {
    const log = options.logger ?? (() => {})
    const root = options.dataFolder ?? resolveDataFolder(nodeDataFolderEnv(options.env))
    const layout = dataLayout(root)
    const lock = await InstanceLock.acquire(layout)
    let core: AtomicCore | undefined
    try {
      const token = await writeControlToken(layout)
      const emitter = new CoreEmitter({ instanceId: lock.instanceId })
      const settings = await SettingsStore.open(layout.core.settings)
      // Settings written through the CLI/control API must reach the attached app immediately so it
      // can refresh the legacy rollback copy before acknowledging the revision. Migration
      // bookkeeping lives under `state`; it is deliberately not a provider event, otherwise an
      // acknowledge would trigger another mirror+acknowledge cycle forever.
      settings.onChange((change) => {
        if (change.scope === 'state') return
        emitter.emit('settings:changed', {
          provider: change.scope,
          key: change.key,
          value: change.value,
        })
      })
      const journal = await ProcessJournal.open(layout)
      const clients = new ClientRegistry()
      // One per core process, in memory: hardware changes between runs, and a stale file claiming
      // a GPU that is gone would pick a backend that cannot start. The same store is deliberately
      // shared by control and the runtime: accepting an override that load never reads is worse
      // than rejecting the endpoint, because it tells the app a hardware handover succeeded.
      const hardware = new HardwareOverrideStore()

      const registries = new Map<LocalProviderId, ModelRegistry>([
        [LOCAL_PROVIDER, new ModelRegistry(layout, LOCAL_PROVIDER)],
      ])
      const runtimes = new Map<LocalProviderId, LlamacppRuntime>([
        [
          LOCAL_PROVIDER,
          new LlamacppRuntime({
            layout,
            registry: registries.get(LOCAL_PROVIDER) as ModelRegistry,
            instanceId: lock.instanceId,
            provider: LOCAL_PROVIDER,
            journal,
            emit: (name, payload) => emitter.emit(name, payload),
            readSettings: () => readRuntimeSettings(settings, LOCAL_PROVIDER, layout, hardware),
            ensureBackendReady: (backend, version) =>
              ensureBackend(layout, LOCAL_PROVIDER, backend, version, hardware),
            cpuInfo: async () => {
              const injected = hardware.get()
              if (!injected?.cpu_extensions) return undefined
              return { arch: process.arch, extensions: hardware.cpuExtensions([]) }
            },
            ...(options.fetch ? { fetch: options.fetch } : {}),
          }),
        ],
      ])

      // One downloader per core process: it owns the active-task table that `cancel` works from, so
      // two of them would each know only half of what is running.
      const downloader = new Downloader({
        dataFolder: layout.root,
        platform: process.platform,
        fetch: options.fetch ?? fetch,
        emit: (name, payload) => emitter.emit(name, payload),
      })
      const optimalStore = await OptimalBackendStore.open(layout.core.optimalBackend, (provider, state) => {
        emitter.emit('backend:optimal-changed', { provider, ...state })
      })
      const manifestCache = new ManifestSessionCache()
      const capabilities = new ModelCapabilityService({
        layout,
        registry: (provider) => registries.get(provider) as ModelRegistry,
      })
      const embeddings = new EmbedService({
        findSession: (provider, modelId) =>
          sessionsOf(runtimes).find(
            (session) => session.provider === provider && session.model_id === modelId
          ),
        load: async (provider, modelId) =>
          (await (core as AtomicCore).acquire(provider, modelId, { isEmbedding: true })).session,
        unload: (provider, modelId) => (core as AtomicCore).unload(provider, modelId),
        fetch: options.fetch ?? fetch,
      })
      const backendServices = new Map<LocalProviderId, BackendService>()
      const backendService = (provider: LocalProviderId): BackendService => {
        const existing = backendServices.get(provider)
        if (existing) return existing
        const created = new BackendService({
          layout,
          provider,
          downloader,
          optimalStore,
          readManifest: async (proxy) => {
            const cached = manifestCache.get()
            if (cached) return cached
            const fetchImpl = proxy
              ? createPolicyFetch({ proxy, ignore_ssl: proxy.ignore_ssl })
              : (options.fetch ?? fetch)
            return fetchLiveManifest({
              cache: manifestCache,
              transports: [manifestTransportFromFetch('core fetch', fetchImpl)],
              onWarn: (message) => log('warn', message),
            })
          },
        })
        backendServices.set(provider, created)
        return created
      }

      const control = await ControlServer.start(
        {
          token,
          instanceId: lock.instanceId,
          version: CORE_VERSION,
          dataFolder: layout.root,
          emitter,
          clients,
          sessions: () => sessionsOf(runtimes),
          loadModel: (provider: string, modelId: string, body: Record<string, unknown>) =>
            (core as AtomicCore).acquire(provider as LocalProviderId, modelId, body as LoadOptions),
          unloadModel: (provider: string, modelId: string) =>
            (core as AtomicCore).unload(provider as LocalProviderId, modelId),
          increaseCtx: (provider: string, modelId: string, reason?: string) =>
            (core as AtomicCore).increaseCtx(provider as LocalProviderId, modelId, reason),
          hardware,
          models: {
            capabilities: (provider, modelId) =>
              capabilities.capabilities(provider as LocalProviderId, modelId),
            validateGguf: (path) => capabilities.validateGguf(path),
            devices: async (provider) => {
              // Asking a backend what devices it sees needs a backend; with none installed the
              // honest answer is an empty list, not an error about a missing binary.
              const resolved = await selectInstalledBackend(
                layout,
                provider as LocalProviderId,
                hardware
              ).catch(() => undefined)
              if (!resolved) return []
              return (core as AtomicCore).runtime(provider as LocalProviderId).getDevices(resolved.path)
            },
            embed: (provider, modelId, input, ubatchSize) =>
              embeddings.embed(provider as LocalProviderId, modelId, input, ubatchSize),
          },
          backends: {
            list: (provider, current) => backendService(provider as LocalProviderId).listInstalled(current),
            install: (provider, version, backend, opts) =>
              backendService(provider as LocalProviderId).install(version, backend, opts),
            remove: (provider, version, backend) =>
              backendService(provider as LocalProviderId).remove(version, backend),
            cancel: (taskId) => downloader.cancel(taskId),
            getOptimal: (provider) => backendService(provider as LocalProviderId).getOptimalCache(),
            setOptimal: (provider, record, expectedRevision) =>
              backendService(provider as LocalProviderId).setOptimalCache(record, expectedRevision),
            optimalSnapshot: () => optimalStore.snapshot(),
          },
          settings: {
            get: (provider) => settings.get(provider),
            revision: () => settings.revision,
            migration: (scope) => settings.migration(scope as SettingsScope),
            update: (provider, patch, opts) => settings.update(provider, patch, opts),
            importProvider: (provider, values, opts) => settings.importProvider(provider, values, opts),
            acknowledge: (scope, revision) => settings.acknowledge(scope as SettingsScope, revision),
          },
          publicServer: {
            status: () => (core as AtomicCore).publicState(),
            start: (opts) => (core as AtomicCore).startPublicServer(opts),
            stop: () => (core as AtomicCore).stopPublicServer(),
          },
          shutdown: async () => {
            await (core as AtomicCore).shutdown()
          },
        },
        {
          host: options.controlHost ?? '127.0.0.1',
          ...(options.controlPort !== undefined ? { port: options.controlPort } : {}),
        }
      )

      core = new AtomicCore(
        layout,
        emitter,
        settings,
        clients,
        lock,
        journal,
        runtimes,
        registries,
        control,
        log,
        token
      )
      await core.reapOrphans()
      await lock.publish(control.host, control.port)
      log('info', `core ${CORE_VERSION} owns ${layout.root} (control ${control.url})`)
      return core
    } catch (e) {
      await lock.release().catch(() => {})
      throw e
    }
  }

  readyLine(): ReadyLine {
    return {
      event: 'core:ready',
      pid: process.pid,
      instance_id: this.instanceId,
      protocol: CONTROL_PROTOCOL_VERSION,
      version: CORE_VERSION,
      control_host: this.control.host,
      control_port: this.control.port,
    }
  }

  registry(provider: LocalProviderId = LOCAL_PROVIDER): ModelRegistry {
    const registry = this.registries.get(provider)
    if (!registry) throw unknownProvider(provider)
    return registry
  }

  runtime(provider: LocalProviderId = LOCAL_PROVIDER): LlamacppRuntime {
    const runtime = this.runtimes.get(provider)
    if (!runtime) throw unknownProvider(provider)
    return runtime
  }

  sessions(): SessionSummary[] {
    return sessionsOf(this.runtimes)
  }

  async load(provider: LocalProviderId, modelId: string, options: LoadOptions = {}): Promise<SessionInfo> {
    return (await this.acquire(provider, modelId, options)).session
  }

  /** Load or attach without making an attaching client accidentally own the shared session. */
  async acquire(
    provider: LocalProviderId,
    modelId: string,
    options: LoadOptions = {}
  ): Promise<{ session: SessionInfo; created: boolean }> {
    this.assertRunning()
    // The desktop app can still own this data folder until it becomes a core client. A second copy
    // of a model it already holds would double the VRAM and race for the GPU, so refuse before
    // anything is spawned, and say where the app is already serving it.
    const runtime = this.runtime(provider)
    const key = `${provider}\0${modelId}`
    let claim = this.modelClaims.get(key)
    if (!claim) {
      let pending = this.claimingModels.get(key)
      if (!pending) {
        pending = acquireModelClaim(this.layout, provider, modelId, this.instanceId)
        this.claimingModels.set(key, pending)
      }
      try {
        claim = await pending
        this.modelClaims.set(key, claim)
      } finally {
        if (this.claimingModels.get(key) === pending) this.claimingModels.delete(key)
      }
    }
    const created = !runtime.findSession(modelId) && !runtime.isLoading(modelId)
    try {
      await assertNotLoadedByLegacy(this.layout, modelId)
      const session = await runtime.load(modelId, options)
      await claim.update('ready')
      return { session, created }
    } catch (e) {
      if (created) {
        await claim.release().catch(() => {})
        this.modelClaims.delete(key)
      }
      throw e
    }
  }

  /**
   * Reload a model with a larger context because a request did not fit. Guarded like `load`: the
   * desktop app may still own this model, and reloading it here would take it from under the app.
   */
  async increaseCtx(provider: LocalProviderId, modelId: string, reason?: string): Promise<CtxIncreaseResult> {
    this.assertRunning()
    await assertNotLoadedByLegacy(this.layout, modelId)
    return this.runtime(provider).autoIncreaseCtx(modelId, reason)
  }

  async unload(provider: LocalProviderId, modelId: string): Promise<UnloadResult> {
    this.assertRunning()
    const result = await this.runtime(provider).unload(modelId)
    const key = `${provider}\0${modelId}`
    await this.modelClaims
      .get(key)
      ?.release()
      .catch(() => {})
    this.modelClaims.delete(key)
    return result
  }

  publicState(): LocalApiServerState {
    return this.publicServer ? this.publicServer.state() : { ...this.lastPublicState }
  }

  /** Start the public listener; an identical start is idempotent, an incompatible one is a conflict. */
  async startPublicServer(options: PublicServerStartOptions = {}): Promise<LocalApiServerState> {
    this.assertRunning()
    return this.withPublicTransition(async () => {
      this.assertRunning()
      const requested = normalizePublicOptions(options)
      if (this.publicServer && this.publicConfig) {
        if (publicOptionsCompatible(this.publicConfig, requested, options.port))
          return this.publicServer.state()
        throw new AtomicCoreError(
          'CORE_ALREADY_RUNNING',
          'The public API server is already running with a different configuration.',
          `${this.publicServer.host}:${this.publicServer.port}${this.publicServer.prefix}`
        )
      }
      const server = await PublicServer.start(
        {
          listModels: () => this.sessions().map((s) => ({ id: s.model_id, owned_by: s.provider })),
          resolveTarget: (model) => {
            const session = this.sessions().find((s) => s.model_id === model)
            return session
              ? { baseUrl: `http://127.0.0.1:${session.port}`, apiKey: session.api_key }
              : undefined
          },
          emit: (name, payload) => this.events.emit(name, payload),
        },
        options
      ).catch((e: unknown) => {
        const error = e as AtomicCoreError
        this.events.emit('server:bind-failed', { port: options.port ?? 0, error: error.message })
        throw error
      })
      this.publicServer = server
      this.publicConfig = { ...requested, port: server.port }
      this.lastPublicState = server.state()
      await this.publishServerState(server.state())
      this.events.emit('server:started', { host: server.host, port: server.port })
      this.log('info', `public API on ${server.url}`)
      return server.state()
    })
  }

  async stopPublicServer(): Promise<LocalApiServerState> {
    this.assertRunning()
    return this.withPublicTransition(() => this.stopPublicServerNow())
  }

  private async stopPublicServerNow(): Promise<LocalApiServerState> {
    if (!this.publicServer) return this.publicState()
    this.lastPublicState = stoppedState(this.publicServer.state())
    await this.publicServer.close()
    this.publicServer = undefined
    this.publicConfig = undefined
    await this.publishServerState(this.lastPublicState)
    this.events.emit('server:stopped', {})
    return { ...this.lastPublicState }
  }

  /**
   * Publish where the public API is, for clients that have no control token — `server status` and,
   * later, the app. Never the app's `<data>/local-api-server.json`: that file belongs to the legacy
   * server until phase 4 hands the writer over, and two writers would race.
   */
  private async publishServerState(state: LocalApiServerState): Promise<void> {
    await writeFile(this.layout.core.publicServerState, `${JSON.stringify(state, null, 2)}\n`).catch(
      (e: Error) => this.log('warn', `could not publish the public server state: ${e.message}`)
    )
  }

  /**
   * Terminate backend processes a previous owner left running. Only processes whose recorded start
   * identity still matches are touched; anything unprovable is left alone and logged.
   */
  private async reapOrphans(): Promise<void> {
    const scan = await this.journal.scanOrphans(this.instanceId, new Set())
    for (const record of scan.confirmed) {
      this.log(
        'warn',
        `stopping orphaned backend pid ${record.pid} (${record.model_id}) from a previous core`
      )
      await terminate(record)
    }
    await this.journal.forget([...scan.confirmed, ...scan.gone])
    for (const skipped of scan.skipped) {
      if (skipped.reason === 'identity-unproven')
        this.log('warn', `leaving pid ${skipped.record.pid} alone: cannot prove it is still our backend`)
    }
  }

  /** Stop everything this core owns and release the lock last. */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.lifecycle = 'stopping'
    this.shutdownPromise = (async () => {
      await this.withPublicTransition(() => this.stopPublicServerNow())
      for (const runtime of this.runtimes.values()) await runtime.shutdown()
      await Promise.all([...this.modelClaims.values()].map((claim) => claim.release().catch(() => {})))
      this.modelClaims.clear()
      await this.control.close()
      await this.lock.release()
      this.lifecycle = 'stopped'
      this.log('info', 'core stopped')
      this.resolveStopped?.()
    })()
    return this.shutdownPromise
  }

  /** Alias so the facade reads the same as the library docs. */
  dispose(): Promise<void> {
    return this.shutdown()
  }

  private assertRunning(): void {
    if (this.lifecycle !== 'running') {
      throw new AtomicCoreError('CORE_NOT_RUNNING', 'The Atomic Chat core is stopping or has stopped.')
    }
  }

  private withPublicTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.publicTransition.then(operation, operation)
    this.publicTransition = result.then(
      () => {},
      () => {}
    )
    return result
  }
}

function normalizePublicOptions(options: PublicServerStartOptions): NormalizedPublicServerOptions {
  return {
    host: options.host ?? DEFAULT_PUBLIC_HOST,
    port: options.port ?? DEFAULT_PUBLIC_PORT,
    prefix: normalizePrefix(options.prefix ?? DEFAULT_PUBLIC_PREFIX),
    apiKey: options.apiKey ?? '',
    trustedHosts: [...(options.trustedHosts ?? [])].sort(),
    corsEnabled: options.corsEnabled ?? false,
  }
}

function publicOptionsCompatible(
  current: NormalizedPublicServerOptions,
  requested: NormalizedPublicServerOptions,
  requestedPort: number | undefined
): boolean {
  const portMatches = requestedPort === 0 || current.port === requested.port
  return (
    portMatches &&
    current.host === requested.host &&
    current.prefix === requested.prefix &&
    current.apiKey === requested.apiKey &&
    current.corsEnabled === requested.corsEnabled &&
    current.trustedHosts.length === requested.trustedHosts.length &&
    current.trustedHosts.every((host, index) => host === requested.trustedHosts[index])
  )
}

function normalizePrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (!trimmed || trimmed === '/') return ''
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash
}

function sessionsOf(runtimes: Map<LocalProviderId, LlamacppRuntime>): SessionSummary[] {
  const out: SessionSummary[] = []
  for (const [provider, runtime] of runtimes)
    for (const info of runtime.list()) out.push({ ...info, provider })
  return out
}

function unknownProvider(provider: string): AtomicCoreError {
  return new AtomicCoreError(
    'PROVIDER_NOT_FOUND',
    `Unknown provider "${provider}".`,
    'llamacpp-upstream is available'
  )
}

async function terminate(record: ChildProcessRecord): Promise<void> {
  const verdict = await verifyProcessIdentity(record.pid, record.process_start_id)
  if (verdict !== 'match') return
  try {
    process.kill(record.pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 5000
  while (isProcessAlive(record.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  if (isProcessAlive(record.pid)) {
    try {
      process.kill(record.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
