/**
 * Which TensorRT-LLM installation a load runs (spec `tensorrt-llm-runtime`, "Загрузка без готовой
 * установки"; design D7): only a `ready` one, only with the descriptor it was pinned to
 * (`active_descriptor_id`, read from the descriptor cache — never fetched, so a release published
 * since cannot change what runs), and only with that descriptor's image for this host's CPU. Anything
 * short of that refuses the load with `MANAGED_ADAPTER_UNAVAILABLE` before a container exists.
 *
 * The installations themselves are read by the setup operation's own store (`InstallationStore`,
 * `../environment/installations.ts`): the records under the shared per-user root that both scopes
 * read, so a setup finished by the app is `ready` for the CLI core too. There is one reader of that
 * format; this file only decides which of its installations a load may run.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { PlatformImage, RuntimeDescriptor, RuntimeInstallation } from '../../contracts/index.js'
import type { InstallationStore, RuntimeDescriptorProvider } from '../environment/index.js'

/** The engine a `tensorrt-llm` load needs an installation of (the descriptor's own `engine_id`). */
const ENGINE_ID = 'tensorrt-llm'

export type ContainerPlatform = 'linux/amd64' | 'linux/arm64'

/** `process.arch` to the descriptor's image key; null for a CPU no image is published for. */
export function containerPlatformFor(arch: string): ContainerPlatform | null {
  if (arch === 'x64') return 'linux/amd64'
  if (arch === 'arm64') return 'linux/arm64'
  return null
}

export interface ReadyInstallation {
  installation: RuntimeInstallation
  descriptor: RuntimeDescriptor
  /** The descriptor's image for this host's platform, pinned by digest. */
  image: PlatformImage
}

export interface ResolveReadyInstallationDeps {
  /** The setup operation's installation records (`InstallationStore`); a torn or foreign file is skipped there. */
  installations: Pick<InstallationStore, 'list'>
  descriptors: Pick<RuntimeDescriptorProvider, 'forInstallation'>
  /** This host's container platform; null when the CPU has no published image. */
  platform: ContainerPlatform | null
}

function unavailable(message: string, details?: string): AtomicCoreError {
  return new AtomicCoreError('MANAGED_ADAPTER_UNAVAILABLE', message, details)
}

export async function resolveReadyInstallation(
  deps: ResolveReadyInstallationDeps
): Promise<ReadyInstallation> {
  const ours = (await deps.installations.list())
    .map((record) => record.installation)
    .filter((i) => i.engine_id === ENGINE_ID)
  const ready = ours.find((i) => i.status === 'ready' && i.active_descriptor_id !== null)
  if (ready === undefined) {
    const status = ours.map((i) => `${i.installation_id}: ${i.status}`).join(', ')
    throw unavailable(
      ours.length === 0
        ? 'The TensorRT-LLM engine is not installed; set it up before loading a model.'
        : 'The TensorRT-LLM engine is not ready; finish or repair its setup before loading a model.',
      status === '' ? undefined : status
    )
  }
  const resolved = await deps.descriptors.forInstallation(ready.active_descriptor_id as string)
  if (resolved.kind !== 'available') throw resolved.error
  const { descriptor } = resolved
  if (descriptor.engine_id !== ENGINE_ID) {
    throw new AtomicCoreError(
      'MANAGED_METADATA_INVALID',
      'The installation is pinned to a descriptor of another engine.',
      `${descriptor.descriptor_id}: ${descriptor.engine_id}`
    )
  }
  if (deps.platform === null) {
    throw unavailable('TensorRT-LLM publishes no image for this CPU architecture.')
  }
  return { installation: ready, descriptor, image: descriptor.image[deps.platform] }
}
