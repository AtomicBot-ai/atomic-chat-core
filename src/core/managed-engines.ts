/**
 * Composition of the managed providers for `create.ts` (change `add-vllm-runtime`, design D3; before
 * it, the `tensorrt-llm` provider of change `add-tensorrt-llm-linux`, task 2.14): every engine of the
 * managed engine registry is wired by `wireManagedEngine` from its `ManagedEngineSpec`, the same way —
 * offered on Linux and on Windows with Atomic Chat's WSL distribution, on the managed-text lifecycle
 * built over the core's one Docker executor and journal (the startup handle the managed environment
 * wires, reconciles and hands its setup and removal too, never a second pair), the desktop or WSL
 * deployment, this scope's managed paths, `selinuxDataRoot = <data>`, and the public server's live
 * trusted-hosts array. No branch here names an engine.
 *
 * What it shares with the managed environment rather than duplicating: the installation records
 * (`InstallationStore`, the one reader of that format), the Linux machine (`LinuxHost`, which is the
 * `ATOMIC_MANAGED_TEST_HOST` stand-in machine in the e2e suite, so that hook is read in one place),
 * and, the other way round, `unloadEngineSessions`: a removal of an engine holds its loads off and
 * unloads its loaded model first, through `managedSessionUnloader` and the facade's own unload.
 *
 * `wireManagedModelCheck` composes `POST /models/:provider/check`'s deps separately from the runtime:
 * it shares the installation records, the descriptor provider and `LinuxHost.probeDeps`, but
 * deliberately never touches `containers`/Docker and is offered even when the runtime itself would
 * refuse every load.
 *
 * `managedModelDeleter` is the deletion of a downloaded model: the same hold-and-unload through the
 * facade as the engine removal's unloader, for one model in whichever managed provider holds it, then
 * its files.
 */
import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents, LocalProviderId } from '../contracts/index.js'
import type {
  ModelCompatibility,
  ManagedModelDeletion,
  ManagedModelLocation,
  ManagedStoreMigration,
} from '../contracts/index.js'
import type { DataLayout, ManagedScopePaths } from '../config/index.js'
import {
  RECONCILE_BUDGET_MS,
  RECONCILE_CALL_TIMEOUT_MS,
  RECONCILE_STARTUP_STOP_TIMEOUT_SECONDS,
  createDockerExec,
  guestRealpath,
  reconcileExecutions,
} from '../runtime/container/index.js'
import type {
  ContainerUser,
  DockerExec,
  ExecutionReconcileResult,
  ManagedContainers,
  ManagedContainersHandle,
  ReconcileLogger,
} from '../runtime/container/index.js'
import { guestProbeDeps, localhostForwardingError, parseWslConfig } from '../runtime/environment/index.js'
import type {
  InstallationStore,
  LinuxHost,
  RuntimeDescriptorProvider,
  UnloadEngineSessions,
  WindowsEnvironmentRecord,
  WindowsHost,
} from '../runtime/environment/index.js'
import {
  ManagedTextAdapterRegistry,
  ManagedTextLifecycle,
  createDesktopManagedDeployment,
  createWslManagedDeployment,
} from '../runtime/managed-text/index.js'
import type { GpuClaimHook } from '../runtime/shared/index.js'
import { checkManagedModel } from '../runtime/managed-models/index.js'
import {
  ManagedEngineRegistry,
  ManagedTextRuntime,
  managedModelCheckOf,
} from '../runtime/managed-engines/index.js'
import type { ManagedEngineSettings, ManagedEngineSpec } from '../runtime/managed-engines/index.js'
import {
  TENSORRT_LLM_ENGINE,
  containerPlatformFor,
  probeTensorrtLlmGpus,
  probeTensorrtLlmGpusAndMemory,
  probeTensorrtLlmHost,
  resolveReadyInstallation,
} from '../runtime/tensorrt-llm/index.js'
import {
  ManagedModelRegistry,
  deleteManagedModelFiles,
  guestModelFiles,
  guestModelsRoot,
  guestStoreMigrationFs,
  legacyGuestModelsRoot,
  linuxModelLocation,
  migrateTensorrtLlmModels,
  readManagedModel,
  windowsModelLocation,
} from '../runtime/managed-models/index.js'
import type { ModelFileOps } from '../runtime/managed-models/index.js'
import {
  ensureGuestScope,
  guestScopePaths,
  WSL_LOCALHOST_MOUNT,
  type DistributionKeeper,
  type GuestMount,
  type Wsl,
  type WslDistributionTransport,
} from '../runtime/wsl/index.js'
import type { AtomicCore } from './atomic-core.js'
import type { ResidencyOccupant } from './gpu/index.js'
import type { CoreLogger } from './types.js'

/**
 * The managed engines this core can run, in priority order: every one is wired, checked and removed
 * the same way. Registration checks the registry's invariants (`engine_id` is the provider id).
 */
export function managedEngineRegistry(): ManagedEngineRegistry {
  const registry = new ManagedEngineRegistry()
  registry.register(TENSORRT_LLM_ENGINE)
  return registry
}

/**
 * What the Windows wiring of a managed engine reaches Atomic Chat's WSL distribution through (change
 * `add-tensorrt-llm-windows`, task 2.8), built by the managed environment on Windows: the environment
 * record (which distribution, if any yet), the WSL transport, the one keeper per distribution, this
 * scope's `scope_key`, and the Windows machine (its `.wslconfig`, its volumes).
 */
export interface WindowsManagedContext {
  records: { read(): Promise<WindowsEnvironmentRecord | null> }
  wsl: Wsl
  keeper: (distribution: string) => DistributionKeeper
  scopeKey: () => Promise<string>
  host: WindowsHost
  /** How core reaches the guest's files; `\\wsl.localhost` unless the managed test hook says otherwise. */
  mount?: GuestMount
}

/** The distribution as it stands now, and this scope's place in it; null before the import. */
interface WindowsGuest {
  record: WindowsEnvironmentRecord
  transport: WslDistributionTransport
  key: string
  paths: ManagedScopePaths
  /** The models root as Windows opens it (`\\wsl.localhost\…`). */
  modelsRoot: string
}

/** The recorded distribution and its transport; null before the import. */
async function windowsDistribution(
  context: WindowsManagedContext
): Promise<{ record: WindowsEnvironmentRecord; transport: WslDistributionTransport } | null> {
  const record = await context.records.read()
  return record === null ? null : { record, transport: context.wsl.distribution(record.distribution.name) }
}

/**
 * The move of this scope's TensorRT-LLM models into the store in the guest (change `add-vllm-runtime`,
 * design D5), once per core, before the first look at the store: run in the guest, with the
 * distribution held for it. No distribution, nothing to move.
 */
const windowsMigrations = new WeakMap<WindowsManagedContext, Promise<ManagedStoreMigration | null>>()

export function windowsStoreMigration(
  context: WindowsManagedContext,
  onResult?: (result: ManagedStoreMigration) => void
): Promise<ManagedStoreMigration | null> {
  const known = windowsMigrations.get(context)
  if (known !== undefined) return known
  const run = (async (): Promise<ManagedStoreMigration | null> => {
    const record = await context.records.read()
    if (record === null) return null
    const name = record.distribution.name
    const key = await context.scopeKey()
    const lease = context.keeper(name).acquire('moving models into the managed model store')
    try {
      const result = await migrateTensorrtLlmModels({
        from: legacyGuestModelsRoot(key),
        to: guestModelsRoot(key),
        fs: guestStoreMigrationFs(context.wsl.distribution(name)),
      })
      onResult?.(result)
      return result
    } finally {
      lease.release()
    }
  })()
  // A failure is tried again on the next look, never cached.
  windowsMigrations.set(
    context,
    run.catch((error: unknown) => {
      windowsMigrations.delete(context)
      throw error
    })
  )
  return windowsMigrations.get(context) as Promise<ManagedStoreMigration | null>
}

async function windowsGuest(
  context: WindowsManagedContext,
  layout: DataLayout
): Promise<WindowsGuest | null> {
  const record = await context.records.read()
  if (record === null) return null
  await windowsStoreMigration(context)
  const name = record.distribution.name
  const key = await context.scopeKey()
  return {
    record,
    transport: context.wsl.distribution(name),
    key,
    paths: guestScopePaths(layout.managed, name, key, context.mount),
    modelsRoot: (context.mount ?? WSL_LOCALHOST_MOUNT).hostPath(name, guestModelsRoot(key)),
  }
}

const notImported = (label = 'TensorRT-LLM'): AtomicCoreError =>
  new AtomicCoreError(
    'MANAGED_ADAPTER_UNAVAILABLE',
    `${label} runs in Atomic Chat’s WSL distribution, which is not set up on this computer yet.`
  )

/**
 * Windows with the WSL context, on a CPU the descriptor publishes an image for: x64, and arm64 since
 * Windows on Arm got its own environment manifest (`windows-arm64-r<N>`) and the provisioner pulls
 * the `linux/arm64` images (NVIDIA RTX Spark N1X, 2026-10-06). The runtime picks the same image by
 * `containerPlatformFor(arch)`.
 */
const windowsWsl = (platform: NodeJS.Platform, arch: string, context: WindowsManagedContext | undefined) =>
  platform === 'win32' && containerPlatformFor(arch) !== null && context !== undefined

export interface WireManagedEngineOptions {
  /** Injected, never `process.platform` read here; the managed environment's (the test host is Linux). */
  platform: NodeJS.Platform
  /** `process.arch`: which of the descriptor's images this host runs. */
  arch: string
  layout: DataLayout
  instanceId: string
  scope: string
  descriptors: Pick<RuntimeDescriptorProvider, 'forInstallation'>
  /** The setup operation's installation records, under the shared per-user root. */
  installations: Pick<InstallationStore, 'list'>
  /** The one Docker executor of this core (`wireManagedEnvironment`'s handle). */
  containers: Pick<ManagedContainersHandle, 'resolve'>
  /** The machine the managed environment probes: `nvidia-smi` runs through it. */
  host: Pick<LinuxHost, 'probeDeps'>
  /** The public server's live trusted hosts: the same array, so a restart reaches every gateway. */
  trustedHosts: string[]
  settings: () => Record<string, unknown>
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  log: CoreLogger
  /** Core's GPU residency (spec `gpu-residency`): the provider's `stopping-previous` stage. */
  claimGpu?: GpuClaimHook
  /** One store model, one managed provider (`managedModelExclusivity`, design D11). */
  releaseModelElsewhere?: (modelId: string, signal: AbortSignal) => Promise<void>
  /**
   * The uid:gid this core runs as (`process.getuid`/`getgid`, read by `create.ts`, never here): every
   * model container runs as it, so the engine cache stays removable (final review I-1). Null where the
   * platform has no numeric user, which leaves the image's own user.
   */
  containerUser: ContainerUser | null
  /** Windows (change `add-tensorrt-llm-windows`): the WSL context; without it Windows offers nothing. */
  windows?: WindowsManagedContext
}

/**
 * One managed engine's provider, or null where it is not offered: everywhere but Linux and Windows
 * (x64, arm64). `options.settings` is that provider's stored settings.
 */
export function wireManagedEngine<S extends ManagedEngineSettings>(
  engine: ManagedEngineSpec<S>,
  options: WireManagedEngineOptions
): ManagedTextRuntime<S> | null {
  if (options.windows !== undefined && windowsWsl(options.platform, options.arch, options.windows)) {
    return wireWindowsManagedEngine(engine, options, options.windows)
  }
  if (options.platform !== 'linux') return null
  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(engine.adapter)
  const deployment = createDesktopManagedDeployment()
  /** The lifecycle and the executor it was built over: the load path's probe asks the same one. */
  let built: { lifecycle: ManagedTextLifecycle; exec: DockerExec } | null = null
  // Asked at every load, through the handle: a host with no docker CLI when core started gets one
  // from the setup's privileged step, and the next load finds it (the handle wires it then).
  const lifecycle = async (): Promise<ManagedTextLifecycle | null> => {
    if (built !== null) return built.lifecycle
    const containers = await options.containers.resolve()
    if (containers === null) return null
    // Two loads that raced here built nothing twice: the first to resume assigns, the second reuses.
    built ??= {
      exec: containers.exec,
      lifecycle: new ManagedTextLifecycle({
        provider: engine.provider as LocalProviderId,
        adapters,
        exec: containers.exec,
        deployment,
        journal: containers.journal,
        paths: options.layout.managed,
        instanceId: options.instanceId,
        scope: options.scope,
        allowedHosts: options.trustedHosts,
        selinuxDataRoot: options.layout.root,
        emit: options.emit,
        log: options.log,
        ...(options.containerUser === null ? {} : { containerUser: options.containerUser }),
      }),
    }
    return built.lifecycle
  }
  const platform = containerPlatformFor(options.arch)
  return new ManagedTextRuntime(engine, {
    lifecycle,
    readyInstallation: () =>
      resolveReadyInstallation({
        engineId: engine.engine_id,
        label: engine.label,
        installations: options.installations,
        descriptors: options.descriptors,
        platform,
      }),
    // Probed fresh at every load, never read off the environment snapshot: that view is only as new
    // as the last setup or removal probe (and empty after a restart), while a card can disappear
    // between two loads (spec "Выбранная карта исчезла"). An unanswered `docker info` refuses the load.
    // Through the lifecycle's own executor: `ManagedTextRuntime` asks for host facts only once the
    // lifecycle resolved, so it is always there (final review T-288 removed a dead fallback).
    hostFacts: () =>
      probeTensorrtLlmHost({
        exec: options.host.probeDeps.exec,
        docker: (built as NonNullable<typeof built>).exec,
        nvidiaSmi: 'nvidia-smi',
        readFile: options.host.probeDeps.readFile,
      }),
    model: (modelId) => readManagedModel(options.layout.managedModelsDir, modelId),
    settings: options.settings,
    ...(options.claimGpu ? { claimGpu: options.claimGpu } : {}),
    ...(options.releaseModelElsewhere ? { releaseModelElsewhere: options.releaseModelElsewhere } : {}),
  })
}

/**
 * A managed engine's Windows provider (change `add-tensorrt-llm-windows`, tasks 2.6–2.8): the same
 * lifecycle and runtime as Linux, over the WSL guest — the core's one executor (the guest's docker, from the handle),
 * this scope's folder in the guest for heartbeats, caches and the watchdog, the WSL deployment (a port
 * Docker picks, forwarding checked), `realpath` in the guest, uid 1000 for the container, the
 * distribution held while a model loads or is loaded; the host facts of a load read in the guest
 * (its `nvidia-smi`, the VM's memory); models under the scope's guest root.
 */
function wireWindowsManagedEngine<S extends ManagedEngineSettings>(
  engine: ManagedEngineSpec<S>,
  options: WireManagedEngineOptions,
  context: WindowsManagedContext
): ManagedTextRuntime<S> {
  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(engine.adapter)
  let built: { lifecycle: ManagedTextLifecycle; exec: DockerExec; guest: WindowsGuest } | null = null
  const lifecycle = async (): Promise<ManagedTextLifecycle | null> => {
    if (built !== null) return built.lifecycle
    const guest = await windowsGuest(context, options.layout)
    if (guest === null) throw notImported(engine.label)
    const containers = await options.containers.resolve()
    if (containers === null) return null
    await ensureGuestScope(guest.transport, guest.key)
    const deployment = windowsDeployment(context, guest, containers.exec)
    const name = guest.record.distribution.name
    built ??= {
      exec: containers.exec,
      guest,
      lifecycle: new ManagedTextLifecycle({
        provider: engine.provider as LocalProviderId,
        adapters,
        exec: containers.exec,
        deployment,
        journal: containers.journal,
        paths: guest.paths,
        instanceId: options.instanceId,
        scope: options.scope,
        allowedHosts: options.trustedHosts,
        // SELinux is not enforcing in Atomic Chat's Ubuntu guest; never used, but must be in the guest.
        selinuxDataRoot: guest.paths.root,
        emit: options.emit,
        log: options.log,
        createContainerDeps: { realpath: guestRealpath(guest.transport) },
        containerUser: { uid: 1000, gid: 1000 },
        keeper: context.keeper(name),
      }),
    }
    return built.lifecycle
  }
  const platform = containerPlatformFor(options.arch)
  return new ManagedTextRuntime(engine, {
    lifecycle,
    readyInstallation: () =>
      resolveReadyInstallation({
        engineId: engine.engine_id,
        label: engine.label,
        installations: options.installations,
        descriptors: options.descriptors,
        platform,
      }),
    hostFacts: () => {
      const current = built as NonNullable<typeof built>
      const deps = guestProbeDeps(current.guest.transport)
      return probeTensorrtLlmHost({
        exec: deps.exec,
        docker: current.exec,
        nvidiaSmi: 'nvidia-smi',
        readFile: deps.readFile,
      })
    },
    model: async (modelId) => {
      const guest = await windowsGuest(context, options.layout)
      if (guest === null) throw notImported(engine.label)
      return readManagedModel(guest.modelsRoot, modelId)
    },
    settings: options.settings,
    ...(options.claimGpu ? { claimGpu: options.claimGpu } : {}),
    ...(options.releaseModelElsewhere ? { releaseModelElsewhere: options.releaseModelElsewhere } : {}),
  })
}

/**
 * The WSL deployment of one guest (task 2.7): its mounts through the context's mount, the engine probed
 * inside the guest as root, and the forwarding error built from `.wslconfig` as it reads at that moment.
 */
export function windowsDeployment(
  context: Pick<WindowsManagedContext, 'host' | 'mount'>,
  guest: { record: WindowsEnvironmentRecord; transport: WslDistributionTransport },
  exec: DockerExec
): ReturnType<typeof createWslManagedDeployment> {
  return createWslManagedDeployment({
    distribution: guest.record.distribution.name,
    ...(context.mount === undefined ? {} : { mount: context.mount }),
    exec,
    runInGuest: (argv) => guest.transport.exec(argv, { user: 'root', timeoutMs: 10_000 }),
    forwardingError: async () =>
      localhostForwardingError(
        parseWslConfig(await context.host.probeDeps.readWslConfig().catch(() => null))
      ),
  })
}

/** The retried reconcile's executor where the wired one already is the guest's (Windows). */
export const wiredExec = (wired: { exec: DockerExec }): DockerExec => wired.exec

/**
 * `GET /managed-models/location` (spec `managed-model-store`): `<data>/managed-models` on Linux; the
 * scope's store in the WSL guest on Windows (`MANAGED_ADAPTER_UNAVAILABLE` before the import).
 */
export function managedModelLocation(
  platform: NodeJS.Platform,
  layout: DataLayout,
  windows?: WindowsManagedContext
): () => Promise<ManagedModelLocation> {
  if (platform === 'win32' && windows !== undefined) {
    return async () => {
      await windowsStoreMigration(windows).catch(() => null)
      return windowsModelLocation({
        records: windows.records,
        scopeKey: windows.scopeKey,
        transport: (name) => windows.wsl.distribution(name),
        volumeFreeBytes: (path) => windows.host.freeDiskBytes(path),
        ...(windows.mount === undefined ? {} : { mount: windows.mount }),
      })
    }
  }
  return () => linuxModelLocation(layout.managedModelsDir)
}

/** The managed model store's registry: the data folder's root on Linux, the guest root (once it exists) on Windows. */
export function managedModelRegistry(
  platform: NodeJS.Platform,
  layout: DataLayout,
  windows?: WindowsManagedContext
): ManagedModelRegistry {
  if (platform === 'win32' && windows !== undefined) {
    return new ManagedModelRegistry(async () => (await windowsGuest(windows, layout))?.modelsRoot ?? null)
  }
  return new ManagedModelRegistry(layout.managedModelsDir)
}

/** `windowsModelFiles` bound to one context and layout: the deleter's `windowsFiles` on Windows. */
export function windowsModelFilesFor(
  windows: WindowsManagedContext,
  layout: DataLayout
): () => Promise<{ paths: ManagedScopePaths; files: ModelFileOps }> {
  return () => windowsModelFiles(windows, layout)
}

/** Windows: where a model's files and caches are, and how to size and remove them (in the guest). */
export async function windowsModelFiles(
  windows: WindowsManagedContext,
  layout: DataLayout
): Promise<{ paths: ManagedScopePaths; files: ModelFileOps }> {
  const guest = await windowsGuest(windows, layout)
  if (guest === null) throw notImported()
  return { paths: guest.paths, files: guestModelFiles(guest.transport, windows.mount) }
}

export interface WireManagedModelCheckOptions {
  descriptors: Pick<RuntimeDescriptorProvider, 'forInstallation' | 'cachedForNewSetup'>
  /** The setup operation's installation records, under the shared per-user root. */
  installations: Pick<InstallationStore, 'list'>
  /** The machine `nvidia-smi`/`/proc/meminfo` are read through; never asked about Docker. */
  host: Pick<LinuxHost, 'probeDeps'>
  settings: () => Record<string, unknown>
  /** Windows x64 (change `add-tensorrt-llm-windows`): the cards and the VM's memory are read in the guest. */
  windows?: WindowsManagedContext
  /** `process.arch`; x64 unless told. */
  arch?: string
}

/**
 * `POST /models/<engine>/check`: `null` where the provider is not offered at all. Available even when
 * the engine is not installed yet — the check falls back to that engine's latest cached descriptor
 * itself (`managed-models/check.ts`) — and never asks Docker anything, unlike `wireManagedEngine`'s
 * own `hostFacts` above.
 */
export function wireManagedModelCheck<S extends ManagedEngineSettings>(
  platform: NodeJS.Platform,
  engine: ManagedEngineSpec<S>,
  options: WireManagedModelCheckOptions
): ((body: unknown) => Promise<ModelCompatibility>) | null {
  const check = managedModelCheckOf(engine)
  const windows = options.windows
  if (windows !== undefined && windowsWsl(platform, options.arch ?? 'x64', windows)) {
    return (body: unknown) =>
      checkManagedModel(check, body, {
        installations: options.installations,
        descriptors: options.descriptors,
        // The guest's cards and the WSL VM's memory once the distribution exists (design D11); before
        // that, the cards Windows sees, with no memory to compare against.
        hostFacts: async () => {
          const guest = await windowsDistribution(windows)
          if (guest === null) {
            const gpus = await probeTensorrtLlmGpus({
              exec: windows.host.probeDeps.exec,
              nvidiaSmi: `${windows.host.probeDeps.systemRoot}\\System32\\nvidia-smi.exe`,
            })
            return { gpus, memory: { availableBytes: 0, totalBytes: 0 } }
          }
          const deps = guestProbeDeps(guest.transport)
          return probeTensorrtLlmGpusAndMemory({
            exec: deps.exec,
            nvidiaSmi: 'nvidia-smi',
            readFile: deps.readFile,
          })
        },
        settings: options.settings,
        wslVm: async () => ({
          memory_setting: parseWslConfig(await windows.host.probeDeps.readWslConfig().catch(() => null))
            .memory,
        }),
      })
  }
  if (platform !== 'linux') return null
  return (body: unknown) =>
    checkManagedModel(check, body, {
      installations: options.installations,
      descriptors: options.descriptors,
      hostFacts: () =>
        probeTensorrtLlmGpusAndMemory({
          exec: options.host.probeDeps.exec,
          nvidiaSmi: 'nvidia-smi',
          readFile: options.host.probeDeps.readFile,
        }),
      settings: options.settings,
    })
}

/**
 * What GPU residency must see of the containers a previous core left (task 2.15; carry-forward from
 * 2.12/2.14): startup reconcile could not confirm them stopped — the stop went unconfirmed, a docker
 * call failed, or its time budget ran out — so they may still be running and holding a GPU. Which one
 * is not recorded, so each holds every card, as `stop-unconfirmed`, under its engine id and container
 * id, with the remedy a refusal names. Evicting one runs the reconcile again, bounded like the startup
 * one (a short deadline per docker call, a short `--time`, a total budget), over this scope's journal
 * only — this instance's own records are never touched — and it is released only once Docker confirms
 * it gone.
 */
export function leftoverContainers(options: {
  containers: Pick<ManagedContainersHandle, 'current'>
  instanceId: string
  log: ReconcileLogger
  /** The core's own empty `DOCKER_CONFIG` (`layout.managed.dockerConfigDir`), as every docker call uses. */
  dockerConfigDir: string
  /** Test seams: the executor of a retried reconcile (default: the startup deadline per call) and its budget. */
  exec?: (wired: ManagedContainers) => DockerExec
  budgetMs?: number
}): () => ResidencyOccupant[] {
  let latest: ExecutionReconcileResult | null = null
  const unresolved = (result: ExecutionReconcileResult) => [
    ...result.unconfirmed,
    ...result.failed,
    ...result.skipped,
  ]
  const boundedExec =
    options.exec ??
    ((wired: ManagedContainers) =>
      createDockerExec({
        dockerPath: wired.dockerPath,
        dockerConfigDir: options.dockerConfigDir,
        timeoutMs: RECONCILE_CALL_TIMEOUT_MS,
      }))
  const retry = async (wired: ManagedContainers): Promise<ExecutionReconcileResult> => {
    const budget = new AbortController()
    const budgetMs = options.budgetMs ?? RECONCILE_BUDGET_MS
    if (budgetMs <= 0) budget.abort()
    const timer = setTimeout(() => budget.abort(), Math.max(budgetMs, 0))
    timer.unref?.()
    try {
      return await reconcileExecutions(
        wired.journal,
        options.instanceId,
        boundedExec(wired),
        options.log,
        RECONCILE_STARTUP_STOP_TIMEOUT_SECONDS,
        budget.signal
      )
    } finally {
      clearTimeout(timer)
    }
  }
  return () => {
    const wired = options.containers.current()
    if (wired === null) return []
    return unresolved(latest ?? wired.reconciled).map((record) => ({
      provider: record.engine_id,
      model_id: record.container_id,
      cards: 'all',
      auxiliary: false,
      state: 'stop-unconfirmed',
      remedy:
        `Start Docker, or remove container ${record.container_id} yourself ` +
        `(docker rm -f ${record.container_id}); the next load retries the stop.`,
      evict: async () => {
        latest = await retry(wired)
        if (unresolved(latest).some((left) => left.container_id === record.container_id)) {
          throw new Error(`Docker did not confirm container ${record.container_id} stopped.`)
        }
      },
    }))
  }
}

/**
 * The managed environment's `unloadEngineSessions` (spec "Удаление при загруженной модели"): before
 * a removal touches an engine's image, loads of that engine's provider are held off (`holdOffLoads`)
 * and every model holding a card is unloaded with its container's stop confirmed — through the
 * facade's own `unload`, as a client's unload or GPU residency would, so each model's cross-process
 * claim is released and a load still pending is cancelled rather than queued behind (final review
 * M-1). The provider is looked up by the engine id among the managed runtimes (`engine_id` is the
 * provider id, design D3), never by its class. The hold lasts until the removal calls `release`. An
 * unconfirmed stop rejects with `MANAGED_STOP_UNCONFIRMED`, which fails the removal with nothing
 * removed, and lifts the hold at once. `runtimes` and `sessions` are read at removal time: the
 * providers are registered after the environment is wired, and the facade after both.
 */
export function managedSessionUnloader(
  runtimes: () => ReadonlyMap<string, ManagedTextRuntime>,
  sessions: () => Pick<AtomicCore, 'cancelLoad' | 'unload'>
): UnloadEngineSessions {
  return async (engineId) => {
    const provider = runtimes().get(engineId)
    if (provider === undefined) return { unloaded: 0 }
    const release = provider.holdOffLoads()
    try {
      const facade = sessions()
      const models = provider.residentModels()
      for (const modelId of models) {
        facade.cancelLoad(provider.engine.provider as LocalProviderId, modelId)
        const result = await facade.unload(provider.engine.provider as LocalProviderId, modelId)
        if (!result.success) {
          throw new AtomicCoreError(
            'MANAGED_STOP_UNCONFIRMED',
            result.error ?? `The unload of ${modelId} failed.`,
            modelId
          )
        }
      }
      return { unloaded: models.length, release }
    } catch (error) {
      release()
      throw error
    }
  }
}

/**
 * One store model, one managed provider (change `add-vllm-runtime`, design D11; spec
 * `managed-model-store`, "Одна модель хранилища загружена не более чем в одном managed-провайдере"):
 * before `provider` loads `modelId`, every other managed provider that has it loaded or loading lets it
 * go — a load cancelled, a session unloaded through the facade with its container's stop confirmed,
 * so its cross-process claim is released as with any client's unload. A stop Docker will not confirm
 * rejects with `MANAGED_STOP_UNCONFIRMED`, and the new load does not start: two live sessions of one
 * id would make `:1337`'s routing by id ambiguous and hold the weights twice.
 */
export function managedModelExclusivity(
  runtimes: () => ReadonlyMap<string, ManagedTextRuntime>,
  sessions: () => Pick<AtomicCore, 'cancelLoad' | 'unload'>
): (provider: string, modelId: string) => Promise<void> {
  return async (provider, modelId) => {
    for (const [other, runtime] of runtimes()) {
      if (other === provider) continue
      if (!runtime.residentModels().includes(modelId) && !runtime.isLoading(modelId)) continue
      const facade = sessions()
      facade.cancelLoad(other as LocalProviderId, modelId)
      const result = await facade.unload(other as LocalProviderId, modelId)
      if (!result.success || runtime.residentModels().includes(modelId)) {
        throw new AtomicCoreError(
          'MANAGED_STOP_UNCONFIRMED',
          result.error ??
            `${modelId} is loaded in ${other}, and its container did not confirm its stop; it was not loaded in ${provider}.`,
          modelId
        )
      }
    }
  }
}

export interface ManagedModelDeleterOptions {
  /** Read at deletion time, like `managedSessionUnloader`'s: the providers are registered late. */
  runtimes: () => ReadonlyMap<string, ManagedTextRuntime>
  sessions: () => Pick<AtomicCore, 'cancelLoad' | 'unload'>
  registry: Pick<ManagedModelRegistry, 'list'>
  /** This scope's managed paths: where the model's engine caches live. */
  paths: ManagedScopePaths
  /**
   * Windows (change `add-tensorrt-llm-windows`, task 2.8): the guest's paths and its file commands,
   * read at deletion time — the model and its caches are sized and removed in the guest.
   */
  windowsFiles?: () => Promise<{ paths: ManagedScopePaths; files: ModelFileOps }>
}

/**
 * Deleting a downloaded model (design D12a of change `add-tensorrt-llm-linux`; change
 * `add-vllm-runtime`, D4). The id must be one the registry lists — exactly, never percent-decoded or
 * resolved as a path — else `MODEL_NOT_FOUND`: a client's wrong id is an error, not a success. Loads
 * of that model are held off in every managed provider for the whole deletion; a load in flight is
 * cancelled and the model unloaded, in whichever provider holds it, through the facade as a client's
 * unload would be, so its cross-process claim is released. Only once Docker confirmed every stop are
 * the files touched; an unconfirmed stop rejects with `MANAGED_STOP_UNCONFIRMED` and removes nothing.
 */
export function managedModelDeleter(
  options: ManagedModelDeleterOptions
): (modelId: string) => Promise<ManagedModelDeletion> {
  return async (modelId) => {
    const providers = [...options.runtimes().values()]
    if (providers.length === 0) {
      throw new AtomicCoreError(
        'PROVIDER_NOT_FOUND',
        'No managed engine is available in this build.',
        'managed-models'
      )
    }
    const model = (await options.registry.list()).find((entry) => entry.id === modelId)
    if (model === undefined) {
      throw new AtomicCoreError('MODEL_NOT_FOUND', `No managed model has the id '${modelId}'.`, modelId)
    }
    const releases = providers.map((provider) => provider.holdOffModel(modelId))
    try {
      const facade = options.sessions()
      let wasLoaded = false
      for (const provider of providers) {
        const id = provider.engine.provider as LocalProviderId
        const cancelled = facade.cancelLoad(id, modelId)
        const result = await facade.unload(id, modelId)
        if (!result.success || provider.residentModels().includes(modelId)) {
          throw new AtomicCoreError(
            'MANAGED_STOP_UNCONFIRMED',
            result.error ?? `The container of ${modelId} did not confirm its stop; nothing was deleted.`,
            modelId
          )
        }
        wasLoaded ||= cancelled || result.was_loaded === true
      }
      const guest = options.windowsFiles === undefined ? null : await options.windowsFiles()
      const files =
        guest === null
          ? await deleteManagedModelFiles(options.paths, model)
          : await deleteManagedModelFiles(guest.paths, model, guest.files)
      return {
        model_id: modelId,
        was_loaded: wasLoaded,
        freed_bytes: files.freedBytes,
        engine_caches_removed: files.engineCachesRemoved,
      }
    } finally {
      for (const release of releases) release()
    }
  }
}
