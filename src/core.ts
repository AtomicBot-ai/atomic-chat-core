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
import { dataLayout, nodeDataFolderEnv, resolveCliDataFolder, resolveDataFolder } from './config/index.js'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
import { ExternalSessions } from './runtime/index.js'
import type { CtxIncreaseResult, LocalLoadOptions, LocalRuntime, RecreateResult } from './runtime/index.js'
import { FoundationModelsRuntime } from './runtime/foundation-models/index.js'
import { MlxRuntime } from './runtime/mlx/index.js'
import { SettingsStore } from './settings/index.js'
import { ApiKeyStore, ChatGptAuth } from './credentials/index.js'
import { CloudRegistry, listSubscriptionModels } from './cloud/index.js'
import type { ChatGptBackend } from './cloud/index.js'
import type { SettingsScope } from './settings/index.js'
import { HardwareOverrideStore } from './hardware/index.js'
import {
  BackendService,
  ensureTurboquantCudart,
  ManifestSessionCache,
  OptimalBackendStore,
  fetchLiveManifest,
  manifestTransportFromFetch,
  selectInstalledBackend,
} from './backend/index.js'
import { Downloader, createPolicyFetch } from './downloads/index.js'
import {
  ClientRegistry,
  CLIENT_EXPIRY_MS,
  ControlServer,
  DEFAULT_PROXY_TIMEOUT_SECS,
  DEFAULT_PUBLIC_HOST,
  markServerRunning,
  markServerStopped,
  DEFAULT_PUBLIC_PORT,
  DEFAULT_PUBLIC_PREFIX,
  PublicServer,
  normalizePrefix,
  stoppedState,
} from './server/index.js'
import type { CtxIncreaseOutcome, LocalTarget } from './server/index.js'
import { LOCAL_SEARCH_ORDER, modelIdsMatch } from './router/index.js'
import type { LocalProvider } from './router/index.js'
import type { SessionSummary } from './server/index.js'
import { CORE_VERSION } from './version.js'

export { CORE_VERSION }

export type CoreLogger = (level: 'info' | 'warn' | 'error', message: string) => void

export interface AtomicCoreOptions {
  ownerScope?: 'app' | 'cli'
  /** Explicit data folder; otherwise resolved like the app does (PLAN.md §8.2 "Папка данных"). */
  dataFolder?: string
  /** Where the app's bundled sidecar binaries live (`resources/bin`); needed for MLX and Foundation Models. */
  resourcesDir?: string
  /** The platform runtimes are offered for (macOS-only engines are not registered elsewhere). Test seam. */
  platform?: NodeJS.Platform
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
  proxyTimeoutSecs?: number
  /**
   * Write the app's `<data>/local-api-server.json` while this server runs. Only the owner of the
   * public API writes that file, so the app asks for this when it hands the server to the core, and
   * a core serving on its own leaves the app's file alone.
   */
  writeStateFile?: boolean
  /** Take a free port when the requested one cannot be bound (the app's behaviour); see `PublicServer`. */
  fallbackPort?: boolean
}

interface NormalizedPublicServerOptions {
  host: string
  port: number
  prefix: string
  apiKey: string
  trustedHosts: string[]
  proxyTimeoutSecs: number
  writeStateFile: boolean
  fallbackPort: boolean
  /** What was asked for, which a port fallback may have replaced. */
  requestedPort?: number
}

export const LOCAL_PROVIDER: LocalProviderId = 'llamacpp-upstream'

/** Load options as the control API carries them: the shared ones plus llama.cpp's explicit paths. */
export type CoreLoadOptions = LocalLoadOptions & Omit<LoadOptions, 'overrides'>

export class AtomicCore {
  readonly version = CORE_VERSION
  private publicServer: PublicServer | undefined
  private lastPublicState: LocalApiServerState = stoppedState()
  private lifecycle: 'running' | 'stopping' | 'stopped' = 'running'
  private shutdownPromise: Promise<void> | undefined
  private publicConfig: NormalizedPublicServerOptions | undefined
  private publicTransition: Promise<void> = Promise.resolve()
  private appLeaseTimer: NodeJS.Timeout | undefined
  private appEverRegistered = false
  /** Whether the app's API screen is watching; previews are collected only then. */
  inspecting = false
  private readonly modelClaims = new Map<string, ModelClaimHandle>()
  private readonly claimingModels = new Map<string, Promise<ModelClaimHandle>>()
  private readonly modelTransitions = new Map<string, Promise<void>>()
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
    private readonly runtimes: Map<LocalProviderId, LocalRuntime>,
    private readonly registries: Map<LocalProviderId, ModelRegistry>,
    readonly control: ControlServer,
    private readonly log: CoreLogger,
    readonly controlToken: string,
    /** Cloud provider API keys (`credentials.json`). */
    readonly apiKeys: ApiKeyStore,
    readonly cloud: CloudRegistry,
    /** The ChatGPT subscription session (`atomic-chatgpt-auth.json`). */
    readonly chatgpt: ChatGptAuth,
    private readonly chatgptBackend: ChatGptBackend,
    /** Engines the desktop app still owns, registered for routing only (stage 4d). */
    readonly externalSessions: ExternalSessions
  ) {}

  get instanceId(): string {
    return this.lock.instanceId
  }

  /** Take ownership of a data folder and start the control listener. */
  static async create(options: AtomicCoreOptions = {}): Promise<AtomicCore> {
    const log = options.logger ?? (() => {})
    const scope = options.ownerScope ?? 'cli'
    const root =
      options.dataFolder ??
      (scope === 'app'
        ? resolveDataFolder(nodeDataFolderEnv(options.env))
        : resolveCliDataFolder(nodeDataFolderEnv(options.env)))
    const layout = dataLayout(root)
    const lock = await InstanceLock.acquire(layout, { ownerScope: scope })
    let core: AtomicCore | undefined
    try {
      const token = await writeControlToken(layout)
      const emitter = new CoreEmitter({ instanceId: lock.instanceId })
      const settings = await SettingsStore.open(layout.core.settings, { ownerScope: scope })
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
      const apiKeys = await ApiKeyStore.open(layout.core.credentials)
      const cloud = new CloudRegistry(settings, apiKeys)
      const env = options.env ?? process.env
      // Test hooks only: point sign-in and the subscription at local stubs. Production never sets them.
      const chatgptIssuer = env['ATOMIC_CHATGPT_ISSUER']
      const chatgptBaseUrl = env['ATOMIC_CHATGPT_BASE_URL']
      const chatgptCallbackPort = env['ATOMIC_CHATGPT_CALLBACK_PORT']
      const chatgpt = new ChatGptAuth({
        path: layout.chatgptAuthFile,
        endpoint: {
          ...(chatgptIssuer ? { issuer: chatgptIssuer } : {}),
          ...(options.fetch ? { fetch: options.fetch } : {}),
        },
        ...(chatgptCallbackPort ? { callbackPort: Number(chatgptCallbackPort) } : {}),
      })
      const chatgptBackend: ChatGptBackend = {
        accessToken: (force) => chatgpt.accessToken(force),
        ...(chatgptBaseUrl ? { baseUrl: chatgptBaseUrl } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }
      const externalSessions = new ExternalSessions({ emit: (name, payload) => emitter.emit(name, payload) })
      const journal = await ProcessJournal.open(layout)
      const clients = new ClientRegistry()
      // One per core process, in memory: hardware changes between runs, and a stale file claiming
      // a GPU that is gone would pick a backend that cannot start. The same store is deliberately
      // shared by control and the runtime: accepting an override that load never reads is worse
      // than rejecting the endpoint, because it tells the app a hardware handover succeeded.
      const hardware = new HardwareOverrideStore()

      // One downloader per core process: it owns the active-task table that `cancel` works from, so
      // two of them would each know only half of what is running.
      const downloader = new Downloader({
        dataFolder: layout.root,
        platform: process.platform,
        fetch: options.fetch ?? fetch,
        emit: (name, payload) => emitter.emit(name, payload),
      })
      const registries = new Map<LocalProviderId, ModelRegistry>([
        [LOCAL_PROVIDER, new ModelRegistry(layout, LOCAL_PROVIDER)],
        ['llamacpp', new ModelRegistry(layout, 'llamacpp')],
      ])
      const platform = options.platform ?? process.platform
      // Both llama.cpp providers run through one runtime class; what differs — backend ids, the
      // argument rules, TurboQuant's CUDA runtime repair — is decided by the provider it is given.
      const llamacppRuntime = (provider: 'llamacpp' | 'llamacpp-upstream') =>
        new LlamacppRuntime({
          layout,
          registry: registries.get(provider) as ModelRegistry,
          instanceId: lock.instanceId,
          provider,
          journal,
          emit: (name, payload) => emitter.emit(name, payload),
          readSettings: () => readRuntimeSettings(settings, provider, layout, hardware),
          ensureBackendReady: (backend, version) =>
            ensureBackend(
              layout,
              provider,
              backend,
              version,
              hardware,
              process.arch,
              provider === 'llamacpp'
                ? (repairBackend, repairVersion) =>
                    ensureTurboquantCudart(
                      repairBackend,
                      join(layout.provider('llamacpp').backendsDir, repairVersion, repairBackend),
                      `llamacpp-cudart-${repairVersion}/${repairBackend}`.replace(/[^A-Za-z0-9_/:-]/g, '_'),
                      { layout, downloader, log: (message) => log('warn', message) }
                    ).then(
                      () => {},
                      (e: unknown) =>
                        log(
                          'warn',
                          `cudart pre-flight for ${repairVersion}/${repairBackend} failed: ${String(e)}`
                        )
                    )
                : undefined
            ),
          cpuInfo: async () => {
            const injected = hardware.get()
            if (!injected?.cpu_extensions) return undefined
            return { arch: process.arch, extensions: hardware.cpuExtensions([]) }
          },
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
      const runtimes = new Map<LocalProviderId, LocalRuntime>([
        [LOCAL_PROVIDER, llamacppRuntime('llamacpp-upstream')],
        ['llamacpp', llamacppRuntime('llamacpp')],
      ])

      if (platform === 'darwin') {
        const mlxRegistry = new ModelRegistry(layout, 'mlx')
        registries.set('mlx', mlxRegistry)
        runtimes.set(
          'mlx',
          new MlxRuntime({
            layout,
            registry: mlxRegistry,
            instanceId: lock.instanceId,
            resourcesDir: options.resourcesDir,
            readSettings: async () => settings.get('mlx'),
            journal,
            emit: (name, payload) => emitter.emit(name, payload),
          })
        )
        runtimes.set(
          'foundation-models',
          new FoundationModelsRuntime({
            instanceId: lock.instanceId,
            resourcesDir: options.resourcesDir,
            journal,
            emit: (name, payload) => emitter.emit(name, payload),
          })
        )
      }

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
          ownerScope: scope,
          dataFolder: layout.root,
          emitter,
          clients,
          sessions: () => sessionsOf(runtimes),
          loadModel: (provider: string, modelId: string, body: Record<string, unknown>) =>
            (core as AtomicCore).acquire(provider as LocalProviderId, modelId, body as CoreLoadOptions),
          unloadModel: (provider: string, modelId: string) =>
            (core as AtomicCore).unload(provider as LocalProviderId, modelId),
          increaseCtx: (provider: string, modelId: string, reason?: string) =>
            (core as AtomicCore).increaseCtx(provider as LocalProviderId, modelId, reason),
          recreateSession: (provider: string, modelId: string) =>
            (core as AtomicCore).recreateSession(provider as LocalProviderId, modelId),
          hardware,
          foundationModelsAvailability: (force: boolean) => {
            const runtime = runtimes.get('foundation-models')
            return runtime instanceof FoundationModelsRuntime
              ? runtime.checkAvailability(force)
              : Promise.resolve('unavailable')
          },
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
              const runtime = (core as AtomicCore).runtime(provider as LocalProviderId)
              return runtime instanceof LlamacppRuntime ? runtime.getDevices(resolved.path) : []
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
          externalSessions: {
            publish: (owner, generation, sessions) => externalSessions.publish(owner, generation, sessions),
            heartbeat: (owner, generation) => externalSessions.heartbeat(owner, generation),
            unregister: (owner, generation) => externalSessions.unregister(owner, generation),
            list: () => externalSessions.list().map(({ api_key: _key, ...rest }) => rest),
            answerCtx: (owner, requestId, outcome) =>
              externalSessions.answerCtxIncrease(owner, requestId, outcome),
          },
          cloud: {
            list: () => cloud.list(),
            upsert: (input) => cloud.upsert(input),
            remove: (provider) => cloud.remove(provider),
          },
          chatgpt: {
            status: () => chatgpt.status(),
            reload: () => chatgpt.reload(),
            startLogin: () => chatgpt.startLogin(),
            waitLogin: () => chatgpt.waitLogin(),
            cancelLogin: () => chatgpt.cancelLogin(),
            logout: () => chatgpt.logout(),
            models: () => listSubscriptionModels(chatgptBackend),
          },
          publicServer: {
            setInspecting: (enabled) => {
              ;(core as AtomicCore).inspecting = enabled
            },
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
        token,
        apiKeys,
        cloud,
        chatgpt,
        chatgptBackend,
        externalSessions
      )
      if (scope === 'app') {
        const startupDeadline = Date.now() + CLIENT_EXPIRY_MS
        // An app that crashes cannot detach. Its registration expires after missed heartbeats;
        // unlike the CLI daemon, this owner then unloads models and releases its lock.
        core.appLeaseTimer = setInterval(() => {
          if (clients.count() > 0) core!.appEverRegistered = true
          else if (core!.appEverRegistered || Date.now() > startupDeadline) void core!.shutdown()
        }, 5_000)
        core.appLeaseTimer.unref()
      }
      await core.reapOrphans()
      await lock.publish(control.host, control.port)
      log('info', `core ${CORE_VERSION} owns ${layout.root} (control ${control.url})`)
      return core
    } catch (e) {
      // A failure after the app lease timer or control listener starts must
      // release both; otherwise an unpublished owner can still wake its timer.
      if (core) await core.shutdown().catch(() => {})
      else await lock.release().catch(() => {})
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
    if (!registry) throw unknownProvider(provider, this.registries.keys())
    return registry
  }

  runtime(provider: LocalProviderId = LOCAL_PROVIDER): LocalRuntime {
    const runtime = this.runtimes.get(provider)
    if (!runtime) throw unknownProvider(provider, this.runtimes.keys())
    return runtime
  }

  /** A llama.cpp runtime, for what only llama.cpp has (devices, runtime device info, context size). */
  llamacpp(provider: 'llamacpp' | 'llamacpp-upstream' = 'llamacpp-upstream'): LlamacppRuntime {
    const runtime = this.runtime(provider)
    if (!(runtime instanceof LlamacppRuntime)) throw unknownProvider(provider, this.runtimes.keys())
    return runtime
  }

  sessions(): SessionSummary[] {
    return sessionsOf(this.runtimes)
  }

  async load(
    provider: LocalProviderId,
    modelId: string,
    options: CoreLoadOptions = {}
  ): Promise<SessionInfo> {
    return (await this.acquire(provider, modelId, options)).session
  }

  /** Load or attach without making an attaching client accidentally own the shared session. */
  async acquire(
    provider: LocalProviderId,
    modelId: string,
    options: CoreLoadOptions = {}
  ): Promise<{ session: SessionInfo; created: boolean }> {
    this.assertRunning()
    const key = `${provider}\0${modelId}`
    return this.withModelTransition(key, () => this.acquireNow(provider, modelId, options))
  }

  private async acquireNow(
    provider: LocalProviderId,
    modelId: string,
    options: CoreLoadOptions
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

  private localTarget(provider: LocalProvider, modelId: string): LocalTarget | undefined {
    const session =
      this.runtimes
        .get(provider)
        ?.list()
        .find((s) => modelIdsMatch(s.model_id, modelId)) ??
      this.externalSessions.find(provider, (id) => modelIdsMatch(id, modelId))
    return session ? toLocalTarget(provider, session) : undefined
  }

  /**
   * What the public server asks of a runtime when a request fails for lack of context or on a
   * poisoned engine. Recovery reloads at the same context; everything else grows it one step.
   */
  private async serverCtxRequest(
    provider: LocalProvider,
    modelId: string,
    trigger: string
  ): Promise<CtxIncreaseOutcome> {
    // A session another process owns is grown by that process; the core only asks.
    const ownedHere = this.runtimes
      .get(provider)
      ?.list()
      .some((s) => modelIdsMatch(s.model_id, modelId))
    const external = ownedHere
      ? undefined
      : this.externalSessions.find(provider, (id) => modelIdsMatch(id, modelId))
    if (external)
      return this.externalSessions.requestCtxIncrease(external.owner, provider, external.model_id, trigger)
    if (trigger === 'compute_error_recovery') {
      const result = await this.recreateSession(provider, modelId)
      return result.ok ? { ok: true } : { ok: false, reason: result.reason }
    }
    const result = await this.increaseCtx(provider, modelId, trigger)
    return result.ok ? { ok: true, new_ctx_len: result.new_ctx_len } : { ok: false, reason: result.reason }
  }

  /** Restart a poisoned engine at its current context; guarded like `load`. */
  async recreateSession(provider: LocalProviderId, modelId: string): Promise<RecreateResult> {
    this.assertRunning()
    await assertNotLoadedByLegacy(this.layout, modelId)
    return this.runtime(provider).recreateSession(modelId)
  }

  async unload(provider: LocalProviderId, modelId: string): Promise<UnloadResult> {
    this.assertRunning()
    const key = `${provider}\0${modelId}`
    return this.withModelTransition(key, async () => {
      this.assertRunning()
      const result = await this.runtime(provider).unload(modelId)
      if (result.success) {
        await this.modelClaims
          .get(key)
          ?.release()
          .catch(() => {})
        this.modelClaims.delete(key)
      }
      return result
    })
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
          findLocal: (provider, modelId) => this.localTarget(provider, modelId),
          listLocal: () =>
            LOCAL_SEARCH_ORDER.flatMap((provider) => [
              ...(this.runtimes.get(provider)?.list() ?? []).map((s) => toLocalTarget(provider, s)),
              ...this.externalSessions
                .list()
                .filter((s) => s.provider === provider)
                .map((s) => toLocalTarget(provider, s)),
            ]),
          providers: () => this.cloud.routing(),
          chatgpt: this.chatgptBackend,
          increaseCtx: (provider, modelId, trigger) => this.serverCtxRequest(provider, modelId, trigger),
          emit: (name, payload) => this.events.emit(name, payload),
          inspecting: () => this.inspecting,
        },
        options
      ).catch((e: unknown) => {
        const error = e as AtomicCoreError
        this.events.emit('server:bind-failed', { port: options.port ?? 0, error: error.message })
        throw error
      })
      this.publicServer = server
      this.publicConfig = { ...requested, port: server.port, requestedPort: requested.port }
      this.lastPublicState = server.state()
      await this.publishServerState(server.state())
      if (requested.writeStateFile) {
        await markServerRunning(
          this.layout.serverStateFile,
          {
            host: server.host,
            port: server.port,
            prefix: server.prefix,
            requiresApiKey: requested.apiKey !== '',
          },
          (message) => this.log('warn', message)
        )
      }
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
    const wroteStateFile = this.publicConfig?.writeStateFile === true
    this.lastPublicState = stoppedState(this.publicServer.state())
    await this.publicServer.close()
    this.publicServer = undefined
    this.publicConfig = undefined
    await this.publishServerState(this.lastPublicState)
    if (wroteStateFile)
      await markServerStopped(this.layout.serverStateFile, (message) => this.log('warn', message))
    this.events.emit('server:stopped', {})
    return { ...this.lastPublicState }
  }

  /**
   * Publish where the public API is, for clients that have no control token — `server status` and
   * the app. This is the core's own copy; the app's `<data>/local-api-server.json` is written only
   * when the app handed the server over (`writeStateFile`), so there is always one writer of it.
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
    if (this.appLeaseTimer) clearInterval(this.appLeaseTimer)
    this.shutdownPromise = (async () => {
      await this.withPublicTransition(() => this.stopPublicServerNow())
      for (const runtime of this.runtimes.values()) await runtime.shutdown()
      await Promise.all([...this.modelTransitions.values()])
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

  private withModelTransition<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.modelTransitions.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(
      () => {},
      () => {}
    )
    this.modelTransitions.set(key, settled)
    void settled.then(() => {
      if (this.modelTransitions.get(key) === settled) this.modelTransitions.delete(key)
    })
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
    proxyTimeoutSecs: options.proxyTimeoutSecs ?? DEFAULT_PROXY_TIMEOUT_SECS,
    writeStateFile: options.writeStateFile ?? false,
    fallbackPort: options.fallbackPort ?? false,
  }
}

function publicOptionsCompatible(
  current: NormalizedPublicServerOptions,
  requested: NormalizedPublicServerOptions,
  requestedPort: number | undefined
): boolean {
  // A server that fell back to a free port still answers a repeat of the request that put it there.
  const portMatches =
    requestedPort === 0 || current.port === requested.port || current.requestedPort === requested.port
  return (
    portMatches &&
    current.host === requested.host &&
    current.prefix === requested.prefix &&
    current.apiKey === requested.apiKey &&
    current.proxyTimeoutSecs === requested.proxyTimeoutSecs &&
    current.writeStateFile === requested.writeStateFile &&
    current.trustedHosts.length === requested.trustedHosts.length &&
    current.trustedHosts.every((host, index) => host === requested.trustedHosts[index])
  )
}

function toLocalTarget(
  provider: LocalProvider,
  session: Pick<SessionInfo, 'model_id' | 'port' | 'api_key' | 'is_embedding'>
): LocalTarget {
  return {
    provider,
    modelId: session.model_id,
    port: session.port,
    apiKey: session.api_key,
    isEmbedding: session.is_embedding,
  }
}

function sessionsOf(runtimes: Map<LocalProviderId, LocalRuntime>): SessionSummary[] {
  const out: SessionSummary[] = []
  for (const [provider, runtime] of runtimes)
    for (const info of runtime.list()) out.push({ ...info, provider })
  return out
}

function unknownProvider(provider: string, available: Iterable<string>): AtomicCoreError {
  return new AtomicCoreError(
    'PROVIDER_NOT_FOUND',
    `Unknown provider "${provider}".`,
    `available: ${[...available].join(', ')}`
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
