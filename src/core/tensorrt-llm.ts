/**
 * Composition of the `tensorrt-llm` provider for `create.ts` (task 2.14): offered only on Linux, on
 * the managed-text lifecycle built over the core's one Docker executor and journal (the ones core
 * startup wires and reconciles — never a second pair), the desktop deployment, this scope's managed
 * paths, `selinuxDataRoot = <data>`, and the public server's live trusted-hosts array.
 *
 * `ATOMIC_MANAGED_TEST_HOST` is a test hook only, like `ATOMIC_CHATGPT_*`; production never sets it.
 * It names a folder standing in for a whole Linux machine — `bin/docker`, `bin/nvidia-smi` — so the
 * compiled core's e2e suite can load a model through a fake container on any host. The managed
 * environment's own probe (task 2.6) reads the same variable and the same folder layout.
 */
import { join } from 'node:path'
import type { CoreEvents } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import type { ManagedContainers } from '../runtime/container/index.js'
import { hostExec } from '../runtime/environment/index.js'
import type { RuntimeDescriptorProvider } from '../runtime/environment/index.js'
import {
  ManagedTextAdapterRegistry,
  ManagedTextLifecycle,
  createDesktopManagedDeployment,
} from '../runtime/managed-text/index.js'
import {
  TensorrtLlmRuntime,
  containerPlatformFor,
  listInstallations,
  probeTensorrtLlmHost,
  readTensorrtLlmModel,
  resolveReadyInstallation,
  tensorrtLlmAdapter,
} from '../runtime/tensorrt-llm/index.js'
import type { CoreLogger } from './types.js'

const TEST_HOST_ENV = 'ATOMIC_MANAGED_TEST_HOST'

export interface ManagedTestHost {
  dir: string
  dockerPath: string
  nvidiaSmi: string
}

/** The e2e stand-in machine, or null — always null outside tests. */
export function managedTestHost(env: Record<string, string | undefined>): ManagedTestHost | null {
  const dir = env[TEST_HOST_ENV]
  if (dir === undefined || dir.trim() === '') return null
  return { dir, dockerPath: join(dir, 'bin', 'docker'), nvidiaSmi: join(dir, 'bin', 'nvidia-smi') }
}

export interface WireTensorrtLlmOptions {
  /** Injected, never `process.platform` read here; the test host counts as Linux. */
  platform: NodeJS.Platform
  /** `process.arch`: which of the descriptor's images this host runs. */
  arch: string
  layout: DataLayout
  instanceId: string
  scope: string
  /** The shared per-user managed root (`managedSharedRoot`): installation records live there. */
  managedRoot: string
  descriptors: Pick<RuntimeDescriptorProvider, 'forInstallation'>
  /** Resolves once core startup has wired and reconciled Docker; null without a docker CLI. */
  containers: Promise<Pick<ManagedContainers, 'exec' | 'journal'> | null>
  /** The public server's live trusted hosts: the same array, so a restart reaches every gateway. */
  trustedHosts: string[]
  settings: () => Record<string, unknown>
  emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) => void
  log: CoreLogger
  /** The test host's `nvidia-smi`; `nvidia-smi` by name otherwise. */
  nvidiaSmi?: string
}

/** The provider, or null where it is not offered: everywhere but Linux. */
export function wireTensorrtLlm(options: WireTensorrtLlmOptions): TensorrtLlmRuntime | null {
  if (options.platform !== 'linux') return null
  const adapters = new ManagedTextAdapterRegistry()
  adapters.register(tensorrtLlmAdapter)
  const deployment = createDesktopManagedDeployment()
  const lifecycle = options.containers.then((containers) =>
    containers === null
      ? null
      : new ManagedTextLifecycle({
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
  )
  const exec = hostExec()
  const platform = containerPlatformFor(options.arch)
  return new TensorrtLlmRuntime({
    lifecycle,
    readyInstallation: () =>
      resolveReadyInstallation({
        installations: () => listInstallations(options.managedRoot),
        descriptors: options.descriptors,
        platform,
      }),
    hostFacts: async () => {
      // Only ever asked after the lifecycle resolved non-null, so the executor is there.
      const containers = await options.containers
      return probeTensorrtLlmHost({
        exec,
        docker: containers?.exec ?? (async () => ({ code: null, stdout: '', stderr: 'no docker CLI' })),
        nvidiaSmi: options.nvidiaSmi ?? 'nvidia-smi',
      })
    },
    model: (modelId) => readTensorrtLlmModel(options.layout.provider('tensorrt-llm').modelsDir, modelId),
    settings: options.settings,
  })
}
