/**
 * How the owner builds the managed-runtime service, and what the control API sees of it.
 *
 * Two things live here that the service itself deliberately does not know about. Which host recipe
 * applies, because that is a fact about the machine the core is running on rather than about an
 * operation; and the in-memory view the snapshot answers from, because a snapshot is synchronous
 * and the record it describes is on a disk shared with another core. The view is refreshed on
 * startup, on every probe of the host (availability, GPUs, blockers, SELinux) and whenever an
 * operation this core runs ends (the installations), which is exactly what a client needs to
 * rebuild from a snapshot and then follow events.
 *
 * On Linux, with the host-side pieces the owner passes in (`linux`: the machine, the privileged
 * recipe, the startup Docker executor, the scope's caches), the environment is driven by the Linux
 * provisioner (task 2.6). Everywhere else, and on Linux without them, `provisionerFor` answers null
 * and the environment reports itself unsupported: an operation started there fails with an
 * actionable blocker rather than appearing to install something.
 *
 * The descriptor provider (task 2.3) and the Linux environment manifest provider (change
 * `extract-environment-manifest`) are built here too, over this same `env` and `fetch`, and shared
 * with the provisioner. `EnvironmentSnapshot.minimum_app_version` is resolved from it
 * network-free (`resolveMinimumAppVersion`): the TensorRT-LLM installation's own pinned descriptor
 * where one exists, otherwise the latest descriptor ever accepted into the cache.
 */

import { readFile as nodeReadFile } from 'node:fs/promises'
import { managedSharedPaths, managedSharedRoot } from '../../config/index.js'
import { CORE_VERSION } from '../../version.js'
import type { DataFolderEnv } from '../../config/index.js'
import { ENGINE_IDS } from '../../contracts/index.js'
import type {
  EngineId,
  CoreEvents,
  EnvironmentOperation,
  EnvironmentSnapshot,
  ExecutorKind,
  ManagedAvailability,
  ManagedStoreMigration,
  RuntimeInstallation,
} from '../../contracts/index.js'
import { processStartId } from '../../lock/index.js'
import { compareVersions } from '../../backend/index.js'
import {
  createRuntimeDescriptorProvider,
  descriptorFetchFromFetch,
  runtimeDescriptorUrlEnvs,
} from './descriptor-provider.js'
import type { DescriptorSource, RuntimeDescriptorProvider } from './descriptor-provider.js'
import { buildEnvironmentDiagnostics, sourceOverrides } from './diagnostics.js'
import {
  createEnvironmentManifestProvider,
  DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL,
  DEFAULT_WINDOWS_ARM64_ENVIRONMENT_MANIFEST_URL,
  DEFAULT_WINDOWS_ENVIRONMENT_MANIFEST_URL,
  ENVIRONMENT_MANIFEST_URL_ENV,
  environmentManifestFetchFromFetch,
} from './environment-manifest-provider.js'
import { normalizeWindowsArchitecture } from './windows-probe.js'
import { InstallationStore } from './installations.js'
import { createLinuxProvisioner, type HostView, type LinuxProvisionerDeps } from './linux-provisioner.js'
import { EnvironmentService, type EnvironmentProvisioner } from './service.js'
import { createWindowsProvisioner, type WindowsProvisionerDeps } from './windows-provisioner.js'
import { OperationStore, type OwnerIdentity } from './store.js'

/** The one environment a machine user has, per scope. Its id is fixed: there is only ever one. */
export const DEFAULT_ENVIRONMENT_ID = 'default'

/**
 * Which container engine this platform would drive: Docker on the Linux host, Docker inside Atomic
 * Chat's own WSL distribution on Windows (change `add-tensorrt-llm-windows`). Null where none applies
 * (`darwin`: there is no container engine for it).
 */
export function executorFor(platform: NodeJS.Platform): ExecutorKind | null {
  if (platform === 'linux') return 'linux-docker'
  if (platform === 'win32') return 'wsl-docker'
  return null
}

/**
 * What the owner supplies for the Linux recipe: everything that lives outside this module (the
 * machine, the privileged recipe from `src/host`, the startup Docker executor, this scope's engine
 * caches and models, and the managed-text sessions to unload). The rest is built here.
 */
export type LinuxProvisionerParts = Omit<
  LinuxProvisionerDeps,
  'descriptors' | 'environmentManifests' | 'installations' | 'environmentId' | 'onAssessment' | 'newId'
>

/**
 * What the owner supplies for the Windows recipe (change `add-tensorrt-llm-windows`): the Windows
 * machine and WSL, the environment record, the elevated and the guest recipes, the rootfs download,
 * the journal, the guest file commands for caches and models. The rest is built here.
 */
export type WindowsProvisionerParts = Omit<
  WindowsProvisionerDeps,
  'descriptors' | 'environmentManifests' | 'installations' | 'environmentId' | 'onAssessment' | 'newId'
>

/**
 * The host recipe for this platform, or null when there is none: Linux or Windows, when the owner
 * supplied the parts it needs. Null is not a placeholder a later card quietly fills: a caller gets an
 * environment that says it is unsupported and an operation that fails with an actionable blocker.
 */
export function provisionerFor(
  platform: NodeJS.Platform,
  linux?: LinuxProvisionerDeps,
  windows?: WindowsProvisionerDeps
): EnvironmentProvisioner | null {
  if (platform === 'linux' && linux !== undefined) return createLinuxProvisioner(linux)
  if (platform === 'win32' && windows !== undefined) return createWindowsProvisioner(windows)
  return null
}

/**
 * `EnvironmentSnapshot.minimum_app_version`: the highest of the descriptors currently in effect, one
 * per engine, network-free (spec `runtime-descriptor-catalog`, "Минимальные версии соблюдаются";
 * change `add-vllm-runtime`, D12). For each engine the provider has a source for, its installation
 * pinned to a descriptor wins — that is the release actually running — otherwise the latest
 * descriptor of that engine this core has ever accepted into its cache; `null` when no engine
 * resolves. Never calls `fetch` or `readFile`: both `forInstallation` and `cachedForNewSetup` are
 * cache-only, so this is safe to call on every refresh.
 */
export async function resolveMinimumAppVersion(
  descriptors: RuntimeDescriptorProvider,
  installations: readonly RuntimeInstallation[]
): Promise<string | null> {
  let highest: string | null = null
  for (const { engine_id: engineId } of descriptors.engines) {
    const pinned = installations.find(
      (installation): installation is RuntimeInstallation & { active_descriptor_id: string } =>
        installation.engine_id === engineId && installation.active_descriptor_id !== null
    )
    const resolved =
      pinned !== undefined
        ? await descriptors.forInstallation(pinned.active_descriptor_id)
        : await descriptors.cachedForNewSetup(engineId)
    if (resolved.kind !== 'available') continue
    const version = resolved.descriptor.minimum_app_version
    if (highest === null || compareVersions(version, highest) > 0) highest = version
  }
  return highest
}

/**
 * The environment's availability for the snapshot: what the last probe of the host said, upgraded
 * to `supported` once an engine installation is ready (carry item 5). A blocked host stays blocked
 * whatever is installed; no recipe at all is `unsupported`.
 */
export function environmentAvailability(
  hasRecipe: boolean,
  assessed: ManagedAvailability | null,
  installations: readonly RuntimeInstallation[],
  unprobed: ManagedAvailability = 'setup-required'
): ManagedAvailability {
  if (!hasRecipe) return 'unsupported'
  const base = assessed ?? unprobed
  const ready = installations.some((installation) => installation.status === 'ready')
  // A ready installation was set up on this machine: supported, even before this core probed it.
  return (base === 'setup-required' || assessed === null) && ready ? 'supported' : base
}

export interface WireManagedRuntimesOptions {
  env: DataFolderEnv
  instanceId: string
  platform: NodeJS.Platform
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  newId: () => string
  /** Test seam: a recipe to use instead of the one this platform would get. */
  provisioner?: EnvironmentProvisioner | null
  /** The Linux recipe's host-side parts (see `LinuxProvisionerParts`); without them, no recipe. */
  linux?: LinuxProvisionerParts
  /** The Windows recipe's parts (see `WindowsProvisionerParts`); without them, no recipe on Windows. */
  windows?: WindowsProvisionerParts
  /**
   * Test seam: whose identity this core stamps on what it writes to the shared store
   * (`OperationStore.ownerIdentity`), instead of this real process's own pid. A test simulating a
   * second, dead core gives it a pid that really existed and really is gone; simulating the same
   * core again (the ordinary case) needs nothing, since the real pid stays the real pid.
   */
  ownerPid?: number
  /** What the descriptor and environment manifest providers fetch with; defaults to the global `fetch`. */
  fetch?: typeof fetch
  /**
   * The managed engines whose descriptors this core reads, one source each (change
   * `add-vllm-runtime`, D2); defaults to TensorRT-LLM alone. The owner passes its engine registry's.
   */
  engines?: readonly DescriptorSource[] | undefined
  /** The move of TensorRT-LLM's models into the managed model store, for the diagnostics (D5). */
  storeMigration?: (() => ManagedStoreMigration | null) | undefined
  /** Where both providers report a rejected source or a non-fatal cache write failure. */
  onWarn?: (message: string) => void
}

export interface ManagedRuntimes {
  service: EnvironmentService
  /** What the snapshot answers with, without going to disk. */
  environments: () => EnvironmentSnapshot[]
  operations: () => EnvironmentOperation[]
  /** Reconcile whatever the previous core left behind, then publish the result. */
  recover: () => Promise<void>
  shutdown: (signal: AbortSignal) => Promise<void>
  /** Gets and caches the TensorRT-LLM runtime descriptor (task 2.3): a host recipe consumes this. */
  descriptors: RuntimeDescriptorProvider
  /** The engine installations of this user's environment (task 2.6), shared by both scopes. */
  installations: InstallationStore
}

export function wireManagedRuntimes(options: WireManagedRuntimesOptions): ManagedRuntimes {
  const executor = executorFor(options.platform)
  const managedRoot = managedSharedRoot(options.env)

  const ownerPid = options.ownerPid ?? process.pid
  // Resolved once and cached: a process's start identity never changes while it runs, and
  // re-probing it on every write would mean an `exec` per commit on macOS and Windows.
  let ownerIdentityCache: Promise<OwnerIdentity> | undefined
  const ownerIdentity = (): Promise<OwnerIdentity> => {
    ownerIdentityCache ??= processStartId(ownerPid).then((startId) => ({
      pid: ownerPid,
      startId: startId ?? null,
    }))
    return ownerIdentityCache
  }

  // The providers' warnings (a document source overridden, a fetch that fell back to the cache) go to
  // the log as before, and the last few are kept for the diagnostics report.
  const recentWarnings: string[] = []
  const warn = (message: string): void => {
    recentWarnings.push(`${new Date().toISOString()} ${message}`)
    if (recentWarnings.length > RECENT_WARNINGS_KEPT) recentWarnings.shift()
    options.onWarn?.(message)
  }

  const store = new OperationStore({
    root: managedRoot,
    instanceId: options.instanceId,
    newOperationId: options.newId,
    newEffectId: options.newId,
    ownerIdentity,
  })

  const descriptors = createRuntimeDescriptorProvider({
    engines: options.engines,
    env: options.env.env,
    fetch: descriptorFetchFromFetch(options.fetch ?? fetch),
    readFile: (path) => nodeReadFile(path, 'utf8'),
    root: managedRoot,
    onWarn: warn,
  })
  // Linux's manifest only: the provisioner that reads it exists only on Linux, and this provider's
  // source is `runtimes/environments/linux.json` — another platform's manifest is never fetched.
  const environmentManifests = createEnvironmentManifestProvider({
    platform: 'linux',
    env: options.env.env,
    fetch: environmentManifestFetchFromFetch(options.fetch ?? fetch),
    readFile: (path) => nodeReadFile(path, 'utf8'),
    root: managedRoot,
    onWarn: warn,
  })
  // Windows' own manifest (change `add-tensorrt-llm-windows`): only a Windows core asks for it, and
  // Windows on Arm asks for its own file (`windows-arm64.json`).
  const windowsManifests = createEnvironmentManifestProvider({
    platform: 'windows',
    arch:
      options.windows === undefined
        ? null
        : normalizeWindowsArchitecture(options.windows.host.probeDeps.machine()),
    env: options.env.env,
    fetch: environmentManifestFetchFromFetch(options.fetch ?? fetch),
    readFile: (path) => nodeReadFile(path, 'utf8'),
    root: managedRoot,
    onWarn: warn,
  })
  const installations = new InstallationStore(managedRoot)
  const sharedPaths = managedSharedPaths(managedRoot)
  // The manifest this core's own platform reads by default, for the diagnostics report.
  const manifestDefaultUrl =
    options.platform !== 'win32'
      ? DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL
      : options.windows !== undefined &&
          normalizeWindowsArchitecture(options.windows.host.probeDeps.machine()) === 'aarch64'
        ? DEFAULT_WINDOWS_ARM64_ENVIRONMENT_MANIFEST_URL
        : DEFAULT_WINDOWS_ENVIRONMENT_MANIFEST_URL

  // The view a snapshot is built from. A machine with no executor has no environment at all, which
  // is different from having one that cannot be set up.
  const view: EnvironmentSnapshot[] =
    executor === null
      ? []
      : [
          {
            schema_version: 1,
            environment_id: DEFAULT_ENVIRONMENT_ID,
            instance_id: options.instanceId,
            revision: 0,
            executor,
            availability: 'unsupported',
            gpus: [],
            blockers: [],
            selinux: null,
            installations: [],
            active_operation_id: null,
            // Resolved for real in `recover()`, network-free, from `descriptors` below.
            minimum_app_version: null,
            // Only a Windows environment runs in a distribution of its own.
            distribution: null,
            source_overrides: sourceOverrides(options.env.env),
          },
        ]
  let assessed: ManagedAvailability | null = null

  /** Bump the snapshot's revision and say so: a client applies only a strictly newer revision. */
  const publish = (): void => {
    const environment = view[0]
    if (environment === undefined) return
    environment.revision += 1
    options.emit('environment:changed', { ...environment })
  }

  /** What the last probe of the host saw; applied to the snapshot with the installations it re-reads. */
  let seenHost: HostView | null = null
  const onAssessment = (seen: HostView): void => {
    assessed = seen.availability
    seenHost = seen
    // Installations are shared with the other scope's core, which may have finished (or removed)
    // one since this core last looked: re-read them with every look at the host (review r1, item 10).
    void refreshInstallations().then(publish, publish)
  }

  const provisioner =
    options.provisioner !== undefined
      ? options.provisioner
      : provisionerFor(
          options.platform,
          options.linux === undefined
            ? undefined
            : {
                ...options.linux,
                descriptors,
                environmentManifests,
                installations,
                environmentId: DEFAULT_ENVIRONMENT_ID,
                onAssessment,
                newId: options.newId,
              },
          options.windows === undefined
            ? undefined
            : {
                ...options.windows,
                descriptors,
                environmentManifests: windowsManifests,
                installations,
                environmentId: DEFAULT_ENVIRONMENT_ID,
                onAssessment,
                newId: options.newId,
              }
        )
  // Windows says nothing until a probe has seen the machine (change `add-tensorrt-llm-windows`, D14):
  // without `windows.json` in conf the provider must stay hidden, and only a probe can tell.
  const unprobed: ManagedAvailability = executor === 'wsl-docker' ? 'unsupported' : 'setup-required'
  if (view[0] !== undefined)
    view[0].availability = environmentAvailability(provisioner !== null, null, [], unprobed)

  /** Re-read the installations (shared with the other scope's core) and what they pin. */
  const refreshInstallations = async (): Promise<void> => {
    const environment = view[0]
    if (environment === undefined) return
    if (seenHost !== null) {
      environment.gpus = seenHost.gpus
      environment.blockers = seenHost.blockers
      environment.selinux = seenHost.selinux
      // Only a Windows probe says anything about a distribution (change `add-tensorrt-llm-windows`).
      if (seenHost.distribution !== undefined) environment.distribution = seenHost.distribution
    }
    environment.installations = (await installations.list().catch(() => [])).map(
      (record) => record.installation
    )
    environment.availability = environmentAvailability(
      provisioner !== null,
      assessed,
      environment.installations,
      unprobed
    )
    environment.minimum_app_version = await resolveMinimumAppVersion(descriptors, environment.installations)
  }

  const operations = new Map<string, EnvironmentOperation>()

  const service = new EnvironmentService({
    store,
    environmentId: DEFAULT_ENVIRONMENT_ID,
    instanceId: options.instanceId,
    newEffectId: options.newId,
    provisioner,
    // `GET …/environments/descriptors/:id` (task 2.22) reads this cache, never the network.
    descriptors,
    readSnapshot: async () => view,
    // A reinstall's start and end change what is installed for every client (change
    // `unify-engine-lifecycle`, design D6, D8): one event for any engine's set of builds.
    onReinstall: (engineId) => {
      if ((ENGINE_IDS as readonly string[]).includes(engineId))
        options.emit('engine:changed', { engine: engineId as EngineId, reason: 'reinstall' })
    },
    onInstallationChanged: (engineId, change) => {
      if ((ENGINE_IDS as readonly string[]).includes(engineId))
        options.emit('engine:changed', { engine: engineId as EngineId, reason: change })
    },
    onReset: (archivedIds) => {
      for (const id of archivedIds) operations.delete(id)
      publish()
    },
    diagnostics: () =>
      buildEnvironmentDiagnostics({
        now: () => new Date(),
        coreVersion: CORE_VERSION,
        platform: options.platform,
        arch: process.arch,
        environment: view[0] === undefined ? null : { ...view[0] },
        env: options.env.env,
        documents: [
          // One source per engine (change `add-vllm-runtime`, D12): where each engine's descriptor
          // comes from and which one it last accepted.
          ...descriptors.engines.map((source) => ({
            document: 'runtime-descriptor' as const,
            engineId: source.engine_id,
            defaultUrl: source.url,
            variables: runtimeDescriptorUrlEnvs(source.engine_id),
            cacheDir: sharedPaths.descriptorsDir,
            idField: 'descriptor_id',
          })),
          {
            document: 'environment-manifest',
            defaultUrl: manifestDefaultUrl,
            variables: [ENVIRONMENT_MANIFEST_URL_ENV],
            cacheDir: sharedPaths.environmentManifestsDir,
            idField: 'manifest_id',
          },
        ],
        operations: () => store.listAll(),
        recentWarnings: () => [...recentWarnings],
        storeMigration: options.storeMigration,
      }),
    emit: (name, payload) => {
      // Keep the snapshot and the event stream describing the same thing: a client that reconnects
      // must not see a snapshot older than the events it then receives.
      const previous = operations.get(payload.operation_id)
      operations.set(payload.operation_id, payload)
      const environment = view[0]
      const finished = TERMINAL.includes(payload.phase)
      if (environment !== undefined) {
        environment.active_operation_id = finished ? null : payload.operation_id
      }
      options.emit(name, payload)
      // An operation that just ended may have written or deleted an installation.
      if (finished && previous?.phase !== payload.phase) {
        void refreshInstallations()
          .then(publish)
          .catch(() => undefined)
      }
    },
  })

  return {
    service,
    environments: () => view,
    operations: () => [...operations.values()],
    recover: async () => {
      // Whatever the previous core was doing is read back before anything is served, so the first
      // snapshot a client sees already includes it.
      for (const record of await store.listRecoverable().catch(() => [])) {
        operations.set(record.machine.operation.operation_id, record.machine.operation)
      }
      await refreshInstallations()
      await service.recover(options.instanceId)
    },
    shutdown: (signal) => service.shutdown(signal),
    descriptors,
    installations,
  }
}

const TERMINAL: readonly EnvironmentOperation['phase'][] = ['ready', 'removed', 'cancelled', 'failed']

/** How many of the providers' warnings the diagnostics report keeps. */
const RECENT_WARNINGS_KEPT = 30
