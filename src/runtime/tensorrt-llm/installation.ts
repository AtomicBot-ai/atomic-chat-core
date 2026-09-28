/**
 * Which TensorRT-LLM installation a load runs (spec `tensorrt-llm-runtime`, "Загрузка без готовой
 * установки"; design D7): only a `ready` one, only with the descriptor it was pinned to
 * (`active_descriptor_id`, read from the descriptor cache — never fetched, so a release published
 * since cannot change what runs), and only with that descriptor's image for this host's CPU. Anything
 * short of that refuses the load with `MANAGED_ADAPTER_UNAVAILABLE` before a container exists.
 *
 * `listInstallations` is a narrow reader of the records the setup operation (task 2.6) writes under
 * the shared per-user root, `installations/<id>/installation.json` (`docs/contracts.md`): the same
 * files both scopes read, so a setup finished by the app is `ready` for the CLI core too. It reads
 * the `installation` part of a record and nothing else.
 */
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type { PlatformImage, RuntimeDescriptor, RuntimeInstallation } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import type { RuntimeDescriptorProvider } from '../environment/index.js'

/** The engine a `tensorrt-llm` load needs an installation of (the descriptor's own `engine_id`). */
const ENGINE_ID = 'tensorrt-llm'

export type ContainerPlatform = 'linux/amd64' | 'linux/arm64'

/** `process.arch` to the descriptor's image key; null for a CPU no image is published for. */
export function containerPlatformFor(arch: string): ContainerPlatform | null {
  if (arch === 'x64') return 'linux/amd64'
  if (arch === 'arm64') return 'linux/arm64'
  return null
}

function installationOf(value: unknown): RuntimeInstallation | null {
  const record = value as { schema_version?: unknown; installation?: Partial<RuntimeInstallation> } | null
  if (record === null || typeof record !== 'object' || record.schema_version !== 1) return null
  const installation = record.installation
  if (
    installation === undefined ||
    typeof installation.installation_id !== 'string' ||
    typeof installation.engine_id !== 'string' ||
    typeof installation.status !== 'string'
  ) {
    return null
  }
  return installation as RuntimeInstallation
}

/** Every readable installation under `root` (the shared managed root). A torn or foreign file is skipped. */
export async function listInstallations(root: string): Promise<RuntimeInstallation[]> {
  const dir = managedSharedPaths(root).installationsDir
  const names = await readdir(dir).catch(() => [] as string[])
  const found: RuntimeInstallation[] = []
  for (const name of names.sort()) {
    const text = await readFile(join(dir, name, 'installation.json'), 'utf8').catch(() => null)
    if (text === null) continue
    try {
      const installation = installationOf(JSON.parse(text))
      if (installation !== null) found.push(installation)
    } catch {
      // A record being written right now, or not one of ours: never guessed at.
    }
  }
  return found
}

export interface ReadyInstallation {
  installation: RuntimeInstallation
  descriptor: RuntimeDescriptor
  /** The descriptor's image for this host's platform, pinned by digest. */
  image: PlatformImage
}

export interface ResolveReadyInstallationDeps {
  installations: () => Promise<RuntimeInstallation[]>
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
  const ours = (await deps.installations()).filter((i) => i.engine_id === ENGINE_ID)
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
