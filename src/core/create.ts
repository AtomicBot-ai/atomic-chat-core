/**
 * The dependency wiring behind `AtomicCore.create()`: take the instance lock, open every store, build
 * the runtimes and backend services, start the control listener, construct the facade, reap what a
 * previous owner left running and only then publish the endpoint.
 */

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { LlamacppProviderId, LocalProviderId, ModelCompatibility } from '../contracts/index.js'
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
import { TRANSCRIPTION_MODEL_ID } from '../speculative/index.js'
import type { SettingsScope } from '../settings/index.js'
import { ApiKeyStore, ChatGptAuth } from '../credentials/index.js'
import { CloudRegistry, listSubscriptionModels } from '../cloud/index.js'
import type { ChatGptBackend } from '../cloud/index.js'
import { HardwareService, nodeProbeDeps, probeSystemInfo, probeUnifiedMemory } from '../hardware/index.js'
import {
  BackendAdvisor,
  BackendService,
  TurboquantCatalogService,
  ensureBackend,
  ensureTurboquantCudart,
  ensureUpstreamCudart,
  ManifestSessionCache,
  OptimalBackendStore,
  fetchLiveManifest,
  manifestTransportFromFetch,
  readRuntimeSettings,
  resolveBackendExe,
  selectInstalledBackend,
} from '../backend/index.js'
import { noticeEngineInstall, wireDecision } from '../decision/index.js'
import { wireDiffusion } from '../diffusion/index.js'
import type { ManagedModelRegistry } from '../runtime/managed-models/index.js'
import type { ManagedTextRuntime } from '../runtime/managed-engines/index.js'
import { Downloader, availableDiskSpace, policyFetchFor } from '../downloads/index.js'
import type { ProxyConfig } from '../downloads/index.js'
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
import { wireManagedEnvironment } from './managed-environment.js'
import { DIFFUSION_GPU_PROVIDER, wireGpuResidency } from './gpu-residency.js'
import { reapOrphans } from './reap-orphans.js'
import { sessionsOf, unknownProvider } from './sessions.js'
import {
  leftoverContainers,
  managedEngineRegistry,
  managedModelDeleter,
  managedModelExclusivity,
  managedSessionUnloader,
  managedModelLocation,
  managedModelRegistry,
  createStoreMigration,
  windowsModelFilesFor,
  wiredExec,
  wireManagedEngine,
  wireManagedModelCheck,
} from './managed-engines.js'
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
  // The core logger as the local runtimes and diffusion take it: they may also say `debug`, which is
  // dropped here, because the host's `logger` only understands three levels.
  const runtimeLog = (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
    if (level !== 'debug') log(level, message)
  }
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
    const platform = options.platform ?? process.platform
    // One per core process, in memory: hardware changes between runs, and a stale file claiming
    // a GPU that is gone would pick a backend that cannot start. The same service is deliberately
    // shared by control and the runtime: accepting an override that load never reads is worse
    // than rejecting the endpoint, because it tells the app a hardware handover succeeded. The
    // probe starts now and runs while the rest is wired; the first load waits for it.
    const hardware = new HardwareService({
      probe:
        options.hardware?.probe ??
        (() =>
          probeSystemInfo(nodeProbeDeps({ platform, arch: process.arch, env: options.env ?? process.env }))),
      arch: process.arch,
      platform,
      log,
    })
    hardware.start()

    // One downloader per core process: it owns the active-task table that `cancel` works from, so
    // two of them would each know only half of what is running.
    const downloader = new Downloader({
      dataFolder: layout.root,
      platform: process.platform,
      fetch: options.fetch ?? fetch,
      emit: (name, payload) => emitter.emit(name, payload),
    })
    const registries = new Map<LocalProviderId, ModelRegistry | ManagedModelRegistry>([
      [LOCAL_PROVIDER, new ModelRegistry(layout, LOCAL_PROVIDER)],
      ['llamacpp', new ModelRegistry(layout, 'llamacpp')],
    ])
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
          // Unknown flags stay `undefined`: the no-AVX preflight fires on a positive signal only.
          const facts = await hardware.facts()
          return facts.cpuExtensions ? { arch: facts.arch, extensions: facts.cpuExtensions } : undefined
        },
        // The voice model the app loads next to a chat model: auxiliary, like an embedding model —
        // never auto-unloaded, never evicted by GPU residency, never evicting.
        transcriptionModelId: TRANSCRIPTION_MODEL_ID,
        claimGpu: (claim, signal) => gpuResidency.hook(provider)(claim, signal),
        unifiedMemory: async () =>
          probeUnifiedMemory(
            nodeProbeDeps({ platform, arch: process.arch, env: options.env ?? process.env })
          ),
        log: runtimeLog,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
      })
    // The managed engines this core can run (change `add-vllm-runtime`, design D3).
    const managedEngines = managedEngineRegistry()
    const runtimes = new Map<LocalProviderId, LocalRuntime>([
      [LOCAL_PROVIDER, llamacppRuntime('llamacpp-upstream')],
      ['llamacpp', llamacppRuntime('llamacpp')],
    ])
    // The facade, constructed last: what GPU residency and an engine removal stop a session through,
    // exactly as a client's unload would. Read when they act, never before.
    const facade = (): AtomicCore => core as AtomicCore
    // GPU residency (task 2.15, spec `gpu-residency`): one resident model per card across every local
    // engine of this core. Every part is read at claim time — image generation, the Docker executor's
    // leftovers and the facade are wired further down.
    const gpuResidency = wireGpuResidency({
      runtimes,
      diffusion: () => diffusion,
      leftovers: () => managedLeftovers(),
      sessions: facade,
    })

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
          claimGpu: gpuResidency.hook('mlx'),
          log: runtimeLog,
          ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
        })
      )
      runtimes.set(
        'foundation-models',
        new FoundationModelsRuntime({
          instanceId: lock.instanceId,
          resourcesDir: options.resourcesDir,
          journal,
          emit: (name, payload) => emitter.emit(name, payload),
          log: runtimeLog,
          ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
        })
      )
    }

    // The public server's trusted hosts, kept in this one array for every session gateway to read.
    const managedTrustedHosts: string[] = []

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
    // The proxy policy of one request decides that request's fetch; nothing about it is kept.
    const fetchFor = (proxy?: ProxyConfig | null): typeof fetch =>
      policyFetchFor({ proxy: proxy ?? null }, options.fetch ?? fetch)
    // One release-index service for the fork: its memory TTL and in-flight coalescing only help
    // when every caller shares them.
    const turboquantCatalog = new TurboquantCatalogService({
      layout,
      fetchFor,
      platform,
      log: (level, message) => log(level, message),
    })
    const advisors = new Map<LlamacppProviderId, BackendAdvisor>()
    const backendAdvisor = (provider: LlamacppProviderId): BackendAdvisor => {
      const existing = advisors.get(provider)
      if (existing) return existing
      const created = new BackendAdvisor({
        provider,
        layout,
        hardware: () => hardware.facts(),
        currentVersionBackend: () => String(settings.get(provider)['version_backend'] ?? ''),
        optimalStore,
        emit: (name, payload) => emitter.emit(name, payload),
        fetchFor,
        manifestCache,
        turboquantCatalog,
        // The Windows tier check runs `--list-devices` on the installed pack of that tier.
        listDevices: async (installed) => {
          const exePath = await resolveBackendExe(layout, provider, installed.version, installed.backend)
          if (!exePath) return []
          const runtime = (core as AtomicCore).runtime(provider)
          return runtime instanceof LlamacppRuntime ? runtime.getDevices(exePath) : []
        },
        platform,
        log: (level, message) => log(level, message),
      })
      advisors.set(provider, created)
      return created
    }
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
          return fetchLiveManifest({
            cache: manifestCache,
            transports: [manifestTransportFromFetch('core fetch', fetchFor(proxy))],
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
      hardware,
      emit: (name, payload) => emitter.emit(name, payload),
      log: runtimeLog,
      platform,
      env,
      claimGpu: gpuResidency.hook(DIFFUSION_GPU_PROVIDER),
      ...(options.diffusion ? { overrides: options.diffusion } : {}),
      ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
    })

    // The managed container environment and the one Docker executor of this core (task 2.6). The
    // `tensorrt-llm` provider (task 2.14) takes `managedContainers`, never a second executor, and the
    // environment's machine (`managedHost`: the e2e stand-in under `ATOMIC_MANAGED_TEST_HOST`, whose
    // platform counts as Linux). A removal unloads the provider's loaded model first.
    // TensorRT-LLM's models move into the managed model store before anything lists or loads one
    // (change `add-vllm-runtime`, design D5), under this core's lock on its data folder. On Linux the
    // old root is in the data folder; on Windows it is in the guest and moves on first use (below).
    const storeMigration = createStoreMigration(log)
    if (process.platform !== 'win32') await storeMigration.onLinux(layout)
    const {
      managed,
      containers: managedContainers,
      platform: managedPlatform,
      host: managedHost,
      arch: managedArch,
      windows: managedWindows,
    } = wireManagedEnvironment({
      env,
      platform,
      layout,
      instanceId: lock.instanceId,
      emit: (name, payload) => emitter.emit(name, payload),
      newId: () => randomUUID(),
      log,
      onWarn: (message) => log('warn', message),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.dockerPath !== undefined ? { dockerPath: options.dockerPath } : {}),
      engines: managedEngines.descriptorSources(),
      storeMigration: storeMigration.current,
      unloadEngineSessions: managedSessionUnloader(() => managedRuntimes, facade),
    })
    // Containers a previous core left that startup reconcile could not confirm stopped: they hold every
    // card for GPU residency until a retried stop is confirmed.
    const managedLeftovers = leftoverContainers({
      containers: managedContainers,
      instanceId: lock.instanceId,
      log,
      dockerConfigDir: layout.managed.dockerConfigDir,
      // On Windows the executor is the guest's docker through WSL: its retries go the same way.
      ...(managedWindows === undefined ? {} : { exec: wiredExec }),
    })

    // Every engine of the managed engine registry, wired the same way (change `add-vllm-runtime`,
    // design D3): offered on Linux and on Windows with Atomic Chat's WSL distribution, absent elsewhere.
    // `engine_id` is the provider id, so each runtime registers under its own engine id.
    const managedRuntimes = new Map<string, ManagedTextRuntime>()
    const releaseElsewhere = managedModelExclusivity(() => managedRuntimes, facade)
    const managedModelChecks: Record<string, (body: unknown) => Promise<ModelCompatibility>> = {}
    for (const engine of managedEngines.list()) {
      const provider = engine.provider as LocalProviderId
      // Shared by the runtime and its model check: one settings reader, not two.
      const settingsOf = (): Record<string, unknown> => settings.get(provider)
      const runtime = wireManagedEngine(engine, {
        platform: managedPlatform,
        arch: managedArch,
        ...(managedWindows === undefined ? {} : { windows: managedWindows }),
        layout,
        instanceId: lock.instanceId,
        scope,
        descriptors: managed.descriptors,
        installations: managed.installations,
        containers: managedContainers,
        host: managedHost,
        trustedHosts: managedTrustedHosts,
        settings: settingsOf,
        emit: (name, payload) => emitter.emit(name, payload),
        log,
        claimGpu: gpuResidency.hook(provider),
        // One store model, one managed provider (design D11): another engine lets it go first.
        releaseModelElsewhere: releaseElsewhere(engine.provider),
        // The engine container runs as this core's own user (final review I-1, ADR
        // 2026-09-29-the-engine-container-runs-as-the-invoking-user).
        containerUser:
          process.getuid !== undefined && process.getgid !== undefined
            ? { uid: process.getuid(), gid: process.getgid() }
            : null,
      })
      if (runtime !== null) {
        runtimes.set(provider, runtime)
        managedRuntimes.set(engine.provider, runtime)
      }
      // `POST /models/<engine>/check`: composed apart from the runtime (its own deps, never Docker), so
      // a compatibility question answers the same whether or not the engine is even installed yet.
      const check = wireManagedModelCheck(managedPlatform, engine, {
        descriptors: managed.descriptors,
        installations: managed.installations,
        host: managedHost,
        settings: settingsOf,
        arch: managedArch,
        ...(managedWindows === undefined ? {} : { windows: managedWindows }),
      })
      if (check !== null) managedModelChecks[engine.provider] = check
    }
    // The managed models' registry: the same gate as the runtimes, so the two are never offered one
    // without the other.
    const storeRegistry = managedModelRegistry(managedPlatform, layout, managedWindows)
    for (const provider of managedRuntimes.keys()) registries.set(provider as LocalProviderId, storeRegistry)
    // Windows moves this scope's TensorRT-LLM models into the store in the guest before the first look
    // at it (`windowsStoreMigration`); the outcome goes to the environment diagnostics.
    if (managedWindows !== undefined && managedRuntimes.size > 0) storeMigration.onWindows(managedWindows)
    /** A managed runtime, or `PROVIDER_NOT_FOUND` where this core does not offer it. */
    const managedOr = (provider: string): ManagedTextRuntime => {
      const runtime = managedRuntimes.get(provider)
      if (runtime === undefined) throw unknownProvider(provider, runtimes.keys())
      return runtime
    }
    // Deleting a downloaded model: wherever a managed provider is offered.
    const managedModelDelete =
      managedRuntimes.size === 0
        ? null
        : managedModelDeleter({
            runtimes: () => managedRuntimes,
            sessions: facade,
            registry: storeRegistry,
            paths: layout.managed,
            ...(managedWindows === undefined
              ? {}
              : { windowsFiles: windowsModelFilesFor(managedWindows, layout) }),
          })

    // The decision model: its own process outside the sessions registry. Started (in the background,
    // nothing waits for it) only once the facade exists, below.
    const decision = wireDecision({
      layout,
      settings,
      journal,
      instanceId: lock.instanceId,
      hardware,
      emit: (name, payload) => emitter.emit(name, payload),
      on: (name, listener) => emitter.on(name, listener),
      log: runtimeLog,
      platform,
      env,
      ...(options.decision ? { overrides: options.decision } : {}),
      ...(options.backendOutput ? { backendOutput: options.backendOutput } : {}),
    })

    const control = await ControlServer.start(
      {
        token,
        instanceId: lock.instanceId,
        version: CORE_VERSION,
        ownerScope: scope,
        dataFolder: layout.root,
        environments: managed.service,
        environmentsSnapshot: managed.environments,
        environmentOperations: managed.operations,
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
          capabilities: async (provider, modelId) =>
            managedEngines.has(provider)
              ? managedOr(provider).capabilities(modelId)
              : capabilities.capabilities(provider as LocalProviderId, modelId),
          logs: async (provider, modelId) => {
            if (managedEngines.has(provider)) return managedOr(provider).logs(modelId)
            if (!runtimes.has(provider as LocalProviderId)) throw unknownProvider(provider, runtimes.keys())
            throw new AtomicCoreError(
              'INVALID_ARGUMENT',
              `The provider "${provider}" runs no container, so it keeps no model logs.`,
              provider
            )
          },
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
        managedModelChecks,
        ...(managedModelDelete !== null ? { managedModelDelete } : {}),
        // Where clients put tensorrt-llm models (change `add-tensorrt-llm-windows`, task 2.8): wherever
        // the provider itself is offered.
        ...(managedRuntimes.size > 0
          ? { managedModelLocation: managedModelLocation(managedPlatform, layout, managedWindows) }
          : {}),
        backends: {
          list: (provider, current) => backendService(provider as LocalProviderId).listInstalled(current),
          install: async (provider, version, backend, opts) => {
            const result = await backendService(provider as LocalProviderId).install(version, backend, opts)
            // The core emits no `backend:download-finished` for its own installs, so the decision
            // module hears about a new TurboQuant build here: it may be the first to serve `--decision`.
            noticeEngineInstall(decision, provider, result.installed)
            return result
          },
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
          catalog: (provider, request) => backendAdvisor(provider as LlamacppProviderId).catalog(request),
          recommend: (provider, request) => backendAdvisor(provider as LlamacppProviderId).recommend(request),
          checkUpdates: (provider, request) =>
            backendAdvisor(provider as LlamacppProviderId).checkUpdates(request),
        },
        disk: { available: (path) => availableDiskSpace(layout.root, path) },
        remoteAccess: {
          lanAddresses,
          status: () => (core as AtomicCore).remoteAccessStatus(),
          start: () => (core as AtomicCore).startRemoteAccess(),
          stop: () => (core as AtomicCore).stopRemoteAccess(),
        },
        diffusion,
        decision: {
          status: () => decision.getStatus(),
          config: () => decision.getConfig(),
          configure: (patch) => decision.configure(patch),
          load: () => decision.load(),
          unload: () => decision.unload(),
          score: (request) =>
            decision.scoreCandidates(request.task, request.criterion, request.candidates, {
              ...(request.timeout_ms !== undefined ? { timeoutMs: request.timeout_ms } : {}),
              ...(request.truncation !== undefined ? { truncation: request.truncation } : {}),
            }),
          decide: (request) =>
            decision.decide(request.state, request.questions, {
              ...(request.timeout_ms !== undefined ? { timeoutMs: request.timeout_ms } : {}),
              ...(request.truncation !== undefined ? { truncation: request.truncation } : {}),
            }),
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
      managed,
      managedTrustedHosts,
      decision,
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
    // Model containers a previous core left running are stopped and removed before the first load is
    // served, like `reapOrphans` above does for native backends. Linux with a docker CLI only. This
    // wires the executor first, so a setup recovered just below (a pull in flight) finds it; the
    // `tensorrt-llm` provider uses the same handle. A failure here is not "no docker": the handle
    // tries again at the next load, which says the runtime failed to initialise, and why.
    await managedContainers
      .resolve()
      .catch((e: unknown) => warn(`managed runtime container reconcile: ${String(e)}`))
    // A setup the previous core was in the middle of is reconciled against the machine before the
    // endpoint is published, so the first snapshot a client sees already describes it.
    await managed.recover().catch((e: unknown) => warn(`managed runtime recovery: ${String(e)}`))
    // A tunnel is worse to orphan than a backend: it keeps a public URL pointed at a local port.
    await reapTunnelOrphan(layout.core.remoteAccessTunnel, { log: warn })
    // Atomic Chat 2.0.40 journalled its tunnel at the data root and reaped it at its own startup; the
    // app that replaced it does not. Same checks, and the file is consumed. Only the app owner's folder
    // can hold it: a CLI owner refuses the app's folder, and one app instance runs at a time.
    await reapTunnelOrphan(layout.legacyRemoteAccessTunnel, { log: warn })
    // An enabled and configured decision model starts now; its shutdown belongs to the facade.
    decision.start()
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
