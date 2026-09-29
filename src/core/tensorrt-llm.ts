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
 * and, the other way round, `unloadEngineSessions`: a removal of the engine unloads its loaded model
 * first, through `tensorrtLlmSessionUnloader`.
 */
import type { CoreEvents } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { reconcileExecutions } from '../runtime/container/index.js'
import type {
  ExecutionReconcileResult,
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
  containerPlatformFor,
  probeTensorrtLlmHost,
  readTensorrtLlmModel,
  resolveReadyInstallation,
  tensorrtLlmAdapter,
} from '../runtime/tensorrt-llm/index.js'
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
  containers: Pick<ManagedContainersHandle, 'resolve' | 'current'>
  /** The machine the managed environment probes: `nvidia-smi` runs through it. */
  host: Pick<LinuxHost, 'probeDeps'>
  /** The public server's live trusted hosts: the same array, so a restart reaches every gateway. */
  trustedHosts: string[]
  settings: () => Record<string, unknown>
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  log: CoreLogger
  /** Core's GPU residency (task 2.15): the provider's `stopping-previous` stage. */
  claimGpu?: GpuClaimHook
}

/** The provider, or null where it is not offered: everywhere but Linux. */
export function wireTensorrtLlm(options: WireTensorrtLlmOptions): TensorrtLlmRuntime | null {
  if (options.platform !== 'linux') return null
  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(tensorrtLlmAdapter)
  const deployment = createDesktopManagedDeployment()
  let built: ManagedTextLifecycle | null = null
  // Asked at every load, through the handle: a host with no docker CLI when core started gets one
  // from the setup's privileged step, and the next load finds it (the handle wires it then).
  const lifecycle = async (): Promise<ManagedTextLifecycle | null> => {
    if (built !== null) return built
    const containers = await options.containers.resolve()
    if (containers === null) return null
    // Two loads that raced here built nothing twice: the first to resume assigns, the second reuses.
    built ??= new ManagedTextLifecycle({
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
    })
    return built
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
    hostFacts: async () =>
      probeTensorrtLlmHost({
        exec: options.host.probeDeps.exec,
        // Only ever asked after the lifecycle resolved non-null, so the executor is there.
        docker:
          options.containers.current()?.exec ??
          (async () => ({ code: null, stdout: '', stderr: 'no docker CLI' })),
        nvidiaSmi: 'nvidia-smi',
      }),
    model: (modelId) => readTensorrtLlmModel(options.layout.provider('tensorrt-llm').modelsDir, modelId),
    settings: options.settings,
    ...(options.claimGpu ? { claimGpu: options.claimGpu } : {}),
  })
}

/**
 * What GPU residency must see of the containers a previous core left (task 2.15; carry-forward from
 * 2.12/2.14): startup reconcile could not confirm them stopped — the stop went unconfirmed, a docker
 * call failed, or its time budget ran out — so they may still be running and holding a GPU. Which one
 * is not recorded, so each holds every card, as `stop-unconfirmed`, under its engine id and container
 * id. Evicting one runs the reconcile again (this scope's journal only; this instance's own records
 * are never touched), and it is released only once Docker confirms it gone.
 */
export function leftoverContainers(options: {
  containers: Pick<ManagedContainersHandle, 'current'>
  instanceId: string
  log: ReconcileLogger
}): () => ResidencyOccupant[] {
  let latest: ExecutionReconcileResult | null = null
  const unresolved = (result: ExecutionReconcileResult) => [
    ...result.unconfirmed,
    ...result.failed,
    ...result.skipped,
  ]
  return () => {
    const wired = options.containers.current()
    if (wired === null) return []
    return unresolved(latest ?? wired.reconciled).map((record) => ({
      provider: record.engine_id,
      model_id: record.container_id,
      cards: 'all',
      auxiliary: false,
      state: 'stop-unconfirmed',
      evict: async () => {
        latest = await reconcileExecutions(wired.journal, options.instanceId, wired.exec, options.log)
        if (unresolved(latest).some((left) => left.container_id === record.container_id)) {
          throw new Error(`Docker did not confirm container ${record.container_id} stopped.`)
        }
      },
    }))
  }
}

/**
 * The managed environment's `unloadEngineSessions` (spec "Удаление при загруженной модели"): before
 * a removal touches the engine's image, every loaded or loading `tensorrt-llm` model is unloaded with
 * its container's stop confirmed (`TensorrtLlmRuntime.unloadAll`); an unconfirmed stop rejects with
 * `MANAGED_STOP_UNCONFIRMED`, which fails the removal with nothing removed. `runtime` is read at
 * removal time: the provider is registered after the environment is wired.
 */
export function tensorrtLlmSessionUnloader(runtime: () => LocalRuntime | undefined): UnloadEngineSessions {
  return async (engineId) => {
    if (engineId !== TENSORRT_LLM_ENGINE_ID) return { unloaded: 0 }
    const provider = runtime()
    return provider instanceof TensorrtLlmRuntime ? provider.unloadAll() : { unloaded: 0 }
  }
}
