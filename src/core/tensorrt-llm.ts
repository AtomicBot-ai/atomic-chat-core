/**
 * Composition of the `tensorrt-llm` provider for `create.ts` (task 2.14): offered only on Linux, on
 * the managed-text lifecycle built over the core's one Docker executor and journal — the startup
 * handle the managed environment (task 2.6) wires, reconciles and hands its setup and removal too,
 * never a second pair — the desktop deployment, this scope's managed paths,
 * `selinuxDataRoot = <data>`, and the public server's live trusted-hosts array.
 *
 * What it shares with the managed environment rather than duplicating: the installation records
 * (`InstallationStore`, the one reader of that format), the Linux machine (`LinuxHost`, which is the
 * `ATOMIC_MANAGED_TEST_HOST` stand-in machine in the e2e suite, so that hook is read in one place),
 * and, the other way round, `unloadEngineSessions`: a removal of the engine holds its loads off and
 * unloads its loaded model first, through `tensorrtLlmSessionUnloader` and the facade's own unload.
 *
 * `wireTensorrtLlmModelCheck` (task 2.16) composes `POST /models/tensorrt-llm/check`'s deps
 * separately from the runtime above: it shares the installation records, the descriptor provider and
 * `LinuxHost.probeDeps`, but deliberately never touches `containers`/Docker (`check.ts`'s own file
 * banner explains why) and is offered even when the runtime itself would refuse every load.
 *
 * `tensorrtLlmModelDeleter` (task 2.24) is `DELETE /models/tensorrt-llm/:id`: the same hold-and-unload
 * through the facade as the engine removal's unloader, for one model, then its files.
 */
import { AtomicCoreError } from '../contracts/index.js'
import type { CoreEvents } from '../contracts/index.js'
import type { ModelCompatibility, TensorrtLlmModelDeletion } from '../contracts/index.js'
import type { DataLayout, ManagedScopePaths } from '../config/index.js'
import {
  RECONCILE_BUDGET_MS,
  RECONCILE_CALL_TIMEOUT_MS,
  RECONCILE_STARTUP_STOP_TIMEOUT_SECONDS,
  createDockerExec,
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
import { TENSORRT_LLM_ENGINE_ID } from '../runtime/environment/index.js'
import type {
  InstallationStore,
  LinuxHost,
  RuntimeDescriptorProvider,
  UnloadEngineSessions,
} from '../runtime/environment/index.js'
import {
  ManagedTextAdapterRegistry,
  ManagedTextLifecycle,
  createDesktopManagedDeployment,
} from '../runtime/managed-text/index.js'
import type { GpuClaimHook, LocalRuntime } from '../runtime/shared/index.js'
import {
  TensorrtLlmRuntime,
  checkTensorrtLlmModel,
  containerPlatformFor,
  deleteTensorrtLlmModelFiles,
  probeTensorrtLlmGpusAndMemory,
  probeTensorrtLlmHost,
  readTensorrtLlmModel,
  resolveReadyInstallation,
  tensorrtLlmAdapter,
} from '../runtime/tensorrt-llm/index.js'
import type { TensorrtLlmModelRegistry } from '../runtime/tensorrt-llm/index.js'
import type { AtomicCore } from './atomic-core.js'
import type { ResidencyOccupant } from './gpu/index.js'
import type { CoreLogger } from './types.js'

export interface WireTensorrtLlmOptions {
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
  /** Core's GPU residency (task 2.15): the provider's `stopping-previous` stage. */
  claimGpu?: GpuClaimHook
  /**
   * The uid:gid this core runs as (`process.getuid`/`getgid`, read by `create.ts`, never here): every
   * model container runs as it, so the engine cache stays removable (final review I-1). Null where the
   * platform has no numeric user, which leaves the image's own user.
   */
  containerUser: ContainerUser | null
}

/** The provider, or null where it is not offered: everywhere but Linux. */
export function wireTensorrtLlm(options: WireTensorrtLlmOptions): TensorrtLlmRuntime | null {
  if (options.platform !== 'linux') return null
  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(tensorrtLlmAdapter)
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
        provider: 'tensorrt-llm',
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
  return new TensorrtLlmRuntime({
    lifecycle,
    readyInstallation: () =>
      resolveReadyInstallation({
        installations: options.installations,
        descriptors: options.descriptors,
        platform,
      }),
    // Probed fresh at every load, never read off the environment snapshot: that view is only as new
    // as the last setup or removal probe (and empty after a restart), while a card can disappear
    // between two loads (spec "Выбранная карта исчезла"). An unanswered `docker info` refuses the load.
    // Through the lifecycle's own executor: `TensorrtLlmRuntime` asks for host facts only once the
    // lifecycle resolved, so it is always there (final review T-288 removed a dead fallback).
    hostFacts: () =>
      probeTensorrtLlmHost({
        exec: options.host.probeDeps.exec,
        docker: (built as NonNullable<typeof built>).exec,
        nvidiaSmi: 'nvidia-smi',
        readFile: options.host.probeDeps.readFile,
      }),
    model: (modelId) => readTensorrtLlmModel(options.layout.provider('tensorrt-llm').modelsDir, modelId),
    settings: options.settings,
    ...(options.claimGpu ? { claimGpu: options.claimGpu } : {}),
  })
}

export interface WireTensorrtLlmModelCheckOptions {
  descriptors: Pick<RuntimeDescriptorProvider, 'forInstallation' | 'cachedForNewSetup'>
  /** The setup operation's installation records, under the shared per-user root. */
  installations: Pick<InstallationStore, 'list'>
  /** The machine `nvidia-smi`/`/proc/meminfo` are read through; never asked about Docker. */
  host: Pick<LinuxHost, 'probeDeps'>
  settings: () => Record<string, unknown>
}

/**
 * `POST /models/tensorrt-llm/check` (task 2.16): `null` off Linux, where the provider is not offered
 * at all. Available even when the engine is not installed yet — the check falls back to the latest
 * cached descriptor itself (`check.ts`) — and never asks Docker anything, unlike `wireTensorrtLlm`'s
 * own `hostFacts` above.
 */
export function wireTensorrtLlmModelCheck(
  platform: NodeJS.Platform,
  options: WireTensorrtLlmModelCheckOptions
): ((body: unknown) => Promise<ModelCompatibility>) | null {
  if (platform !== 'linux') return null
  return (body: unknown) =>
    checkTensorrtLlmModel(body, {
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
 * a removal touches the engine's image, loads of `tensorrt-llm` are held off (`holdOffLoads`) and
 * every model holding a card is unloaded with its container's stop confirmed — through the facade's
 * own `unload`, as a client's unload or GPU residency would, so each model's cross-process claim is
 * released and a load still pending is cancelled rather than queued behind (final review M-1). The
 * hold lasts until the removal calls `release`. An unconfirmed stop rejects with
 * `MANAGED_STOP_UNCONFIRMED`, which fails the removal with nothing removed, and lifts the hold at
 * once. `runtime` and `sessions` are read at removal time: the provider is registered after the
 * environment is wired, and the facade after both.
 */
export function tensorrtLlmSessionUnloader(
  runtime: () => LocalRuntime | undefined,
  sessions: () => Pick<AtomicCore, 'cancelLoad' | 'unload'>
): UnloadEngineSessions {
  return async (engineId) => {
    if (engineId !== TENSORRT_LLM_ENGINE_ID) return { unloaded: 0 }
    const provider = runtime()
    if (!(provider instanceof TensorrtLlmRuntime)) return { unloaded: 0 }
    const release = provider.holdOffLoads()
    try {
      const facade = sessions()
      const models = provider.residentModels()
      for (const modelId of models) {
        facade.cancelLoad(TENSORRT_LLM_ENGINE_ID, modelId)
        const result = await facade.unload(TENSORRT_LLM_ENGINE_ID, modelId)
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

export interface TensorrtLlmModelDeleterOptions {
  /** Read at deletion time, like `tensorrtLlmSessionUnloader`'s: the provider is registered late. */
  runtime: () => LocalRuntime | undefined
  sessions: () => Pick<AtomicCore, 'cancelLoad' | 'unload'>
  registry: Pick<TensorrtLlmModelRegistry, 'list'>
  /** This scope's managed paths: where the model's engine caches live. */
  paths: ManagedScopePaths
}

/**
 * `DELETE /models/tensorrt-llm/:id` (task 2.24, design D12a, spec `tensorrt-llm-models` "Модель
 * удаляется через core"). The id must be one the registry lists — exactly, never percent-decoded or
 * resolved as a path — else `MODEL_NOT_FOUND`: a client's wrong id is an error, not a success. Loads
 * of that model are held off for the whole deletion; a load in flight is cancelled and the model
 * unloaded through the facade, as a client's unload would be, so its cross-process claim is released.
 * Only once Docker confirmed the stop are the files touched; an unconfirmed stop rejects with
 * `MANAGED_STOP_UNCONFIRMED` and removes nothing.
 */
export function tensorrtLlmModelDeleter(
  options: TensorrtLlmModelDeleterOptions
): (modelId: string) => Promise<TensorrtLlmModelDeletion> {
  return async (modelId) => {
    const provider = options.runtime()
    if (!(provider instanceof TensorrtLlmRuntime)) {
      throw new AtomicCoreError(
        'PROVIDER_NOT_FOUND',
        'tensorrt-llm is not available in this build.',
        TENSORRT_LLM_ENGINE_ID
      )
    }
    const model = (await options.registry.list()).find((entry) => entry.id === modelId)
    if (model === undefined) {
      throw new AtomicCoreError('MODEL_NOT_FOUND', `No tensorrt-llm model has the id '${modelId}'.`, modelId)
    }
    const release = provider.holdOffModel(modelId)
    try {
      const facade = options.sessions()
      const cancelled = facade.cancelLoad(TENSORRT_LLM_ENGINE_ID, modelId)
      const result = await facade.unload(TENSORRT_LLM_ENGINE_ID, modelId)
      if (!result.success || provider.residentModels().includes(modelId)) {
        throw new AtomicCoreError(
          'MANAGED_STOP_UNCONFIRMED',
          result.error ?? `The container of ${modelId} did not confirm its stop; nothing was deleted.`,
          modelId
        )
      }
      const files = await deleteTensorrtLlmModelFiles(options.paths, model)
      return {
        model_id: modelId,
        was_loaded: cancelled || result.was_loaded === true,
        freed_bytes: files.freedBytes,
        engine_caches_removed: files.engineCachesRemoved,
      }
    } finally {
      release()
    }
  }
}
