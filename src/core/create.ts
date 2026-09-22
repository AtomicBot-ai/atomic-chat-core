/**
 * The dependency wiring behind `AtomicCore.create()`: take the instance lock, open every store, build
 * the runtimes and backend services, start the control listener, construct the facade, reap what a
 * previous owner left running and only then publish the endpoint.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LocalProviderId } from '../contracts/index.js'
import { dataLayout, nodeDataFolderEnv, resolveCliDataFolder, resolveDataFolder } from '../config/index.js'
import { CoreEmitter } from '../events/index.js'
import { InstanceLock, ProcessJournal, writeControlToken } from '../lock/index.js'
import { EmbedService, ModelCapabilityService, ModelRegistry } from '../models/index.js'
import { LlamacppRuntime } from '../runtime/llamacpp/index.js'
import { ExternalSessions } from '../runtime/index.js'
import type { LocalRuntime } from '../runtime/index.js'
import { FoundationModelsRuntime } from '../runtime/foundation-models/index.js'
import { MlxRuntime } from '../runtime/mlx/index.js'
import { SettingsStore } from '../settings/index.js'
import type { SettingsScope } from '../settings/index.js'
import { ApiKeyStore, ChatGptAuth } from '../credentials/index.js'
import { CloudRegistry, listSubscriptionModels } from '../cloud/index.js'
import type { ChatGptBackend } from '../cloud/index.js'
import { HardwareOverrideStore } from '../hardware/index.js'
import {
  BackendService,
  ensureBackend,
  ensureTurboquantCudart,
  ensureUpstreamCudart,
  ManifestSessionCache,
  OptimalBackendStore,
  fetchLiveManifest,
  manifestTransportFromFetch,
  readRuntimeSettings,
  selectInstalledBackend,
} from '../backend/index.js'
import { wireDiffusion } from '../diffusion/index.js'
import { Downloader, availableDiskSpace, createPolicyFetch } from '../downloads/index.js'
import { lanAddresses, reapTunnelOrphan, wireRemoteAccess } from '../remote-access/index.js'
import { ClientRegistry, CLIENT_EXPIRY_MS, ControlServer } from '../server/index.js'
import {
  captureReport,
  createCoreReporter,
  processFailureReport,
  reportCoreEvents,
} from '../telemetry/index.js'
import { CORE_VERSION } from '../version.js'
import type { AtomicCore, AtomicCoreParts } from './atomic-core.js'
import { reapOrphans } from './reap-orphans.js'
import { sessionsOf } from './sessions.js'
import { LOCAL_PROVIDER } from './types.js'
import type { AtomicCoreOptions, CoreLoadOptions } from './types.js'

/**
 * Take ownership of a data folder and start the control listener. `construct` builds the facade
 * from the wired parts; `AtomicCore.create` passes its private constructor.
 */
export async function createAtomicCore(
  options: AtomicCoreOptions,
  construct: (parts: AtomicCoreParts) => AtomicCore
): Promise<AtomicCore> {
  const log = options.logger ?? (() => {})
  const warn = (message: string) => log('warn', message)
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
    const reporter =
      options.errorReporter ??
      (options.telemetry === false
        ? undefined
        : await createCoreReporter({
            host: options.telemetry?.host ?? 'library',
            hostVersion: options.telemetry?.hostVersion,
            enabled: options.telemetry?.enabled,
            ownerScope: scope,
            dataFolder: layout.root,
            telemetryFile: layout.core.telemetry,
            homeDir: homedir(),
            env: options.env ?? process.env,
            platform: options.platform ?? process.platform,
            arch: process.arch,
            version: CORE_VERSION,
            warn,
            fetch: options.fetch,
          }))
    const emitter = new CoreEmitter({
      instanceId: lock.instanceId,
      onListenerError: (event, error) =>
        captureReport(reporter, processFailureReport('event_listener', error, { event })),
    })
    if (reporter) reportCoreEvents(emitter, reporter, options.platform ?? process.platform)
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
    // argument rules and Windows CUDA runtime repair — is decided by the provider it is given.
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
            (repairBackend, repairVersion) => {
              const backendDir = join(layout.provider(provider).backendsDir, repairVersion, repairBackend)
              const taskId = `${provider}-cudart-${repairVersion}/${repairBackend}`.replace(
                /[^A-Za-z0-9_/:-]/g,
                '_'
              )
              const deps = { layout, downloader, platform, log: (message: string) => log('warn', message) }
              const repair =
                provider === 'llamacpp'
                  ? ensureTurboquantCudart(repairBackend, backendDir, taskId, deps)
                  : ensureUpstreamCudart(repairVersion, repairBackend, backendDir, taskId, deps)
              return repair.then(
                () => {},
                (e: unknown) =>
                  log('warn', `cudart pre-flight for ${repairVersion}/${repairBackend} failed: ${String(e)}`)
              )
            }
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
        sessionsOf(runtimes).find((session) => session.provider === provider && session.model_id === modelId),
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

    const diffusion = wireDiffusion({
      layout,
      journal,
      instanceId: lock.instanceId,
      emit: (name, payload) => emitter.emit(name, payload),
      log: (level, msg) => (level === 'debug' ? undefined : log(level, msg)),
      platform,
      env,
      ...(options.diffusion ? { overrides: options.diffusion } : {}),
    })

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
        cancelModelLoad: (provider: string, modelId: string) =>
          (core as AtomicCore).cancelLoad(provider as LocalProviderId, modelId),
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
            backendService(provider as LocalProviderId).remove(
              version,
              backend,
              String(settings.get(provider as LocalProviderId)['version_backend'] ?? '')
            ),
          cancel: (taskId) => downloader.cancel(taskId),
          getOptimal: (provider) => backendService(provider as LocalProviderId).getOptimalCache(),
          setOptimal: (provider, record, expectedRevision) =>
            backendService(provider as LocalProviderId).setOptimalCache(record, expectedRevision),
          optimalSnapshot: () => optimalStore.snapshot(),
        },
        disk: { available: (path) => availableDiskSpace(layout.root, path) },
        remoteAccess: {
          lanAddresses,
          status: () => (core as AtomicCore).remoteAccessStatus(),
          start: () => (core as AtomicCore).startRemoteAccess(),
          stop: () => (core as AtomicCore).stopRemoteAccess(),
        },
        diffusion,
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
        ...(reporter ? { telemetry: reporter } : {}),
      },
      {
        host: options.controlHost ?? '127.0.0.1',
        ...(options.controlPort !== undefined ? { port: options.controlPort } : {}),
      }
    )

    let appLeaseTimer: NodeJS.Timeout | undefined
    if (scope === 'app') {
      const startupDeadline = Date.now() + CLIENT_EXPIRY_MS
      let appEverRegistered = false
      // An app that crashes cannot detach. Its registration expires after missed heartbeats;
      // unlike the CLI daemon, this owner then unloads models and releases its lock.
      appLeaseTimer = setInterval(() => {
        if (clients.count() > 0) appEverRegistered = true
        else if (appEverRegistered || Date.now() > startupDeadline) void core!.shutdown()
      }, 5_000)
      appLeaseTimer.unref()
    }
    core = construct({
      layout,
      events: emitter,
      settings,
      clients,
      lock,
      runtimes,
      registries,
      control,
      log,
      controlToken: token,
      apiKeys,
      cloud,
      chatgpt,
      chatgptBackend,
      externalSessions,
      appLeaseTimer,
      diffusion,
      errors: reporter,
      telemetry: reporter,
      remoteAccess: await wireRemoteAccess({
        overrides: options.remoteAccess,
        cloudflaredPath: options.cloudflaredPath,
        resourcesDir: options.resourcesDir,
        env,
        platform,
        journalPath: layout.core.remoteAccessTunnel,
        emptyConfigPath: layout.core.cloudflaredEmptyConfig,
        instanceId: lock.instanceId,
        warn,
      }),
    })
    await reapOrphans(journal, lock.instanceId, log)
    // A tunnel is worse to orphan than a backend: it keeps a public URL pointed at a local port.
    await reapTunnelOrphan(layout.core.remoteAccessTunnel, { log: warn })
    // Atomic Chat 2.0.40 journalled its tunnel at the data root and reaped it at its own startup; the
    // app that replaced it does not. Same checks, and the file is consumed. Only the app owner's folder
    // can hold it: a CLI owner refuses the app's folder, and one app instance runs at a time.
    await reapTunnelOrphan(layout.legacyRemoteAccessTunnel, { log: warn })
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
