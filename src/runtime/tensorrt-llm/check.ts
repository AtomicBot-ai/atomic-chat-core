/**
 * `POST /atomic/v1/models/tensorrt-llm/check` (task 2.16, spec `tensorrt-llm-models`, "Проверка
 * совместимости без сети"): wires the pure `checkModelCompatibility` (`compatibility.ts`) to the
 * pinned descriptor of the ready installation — or, "если движок не установлен", the latest accepted
 * cached descriptor (`descriptors.cachedForNewSetup()`) — and to the host's GPUs and `MemAvailable`.
 * Never fetches: `descriptorForCheck` below only ever reads `forInstallation`/`cachedForNewSetup`,
 * both cache-only (`descriptor-provider.ts`), and `hostFacts` is the check route's own Docker-free
 * probe (`probeTensorrtLlmGpusAndMemory`, `host-facts.ts`) — matching the spec's "Core MUST NOT
 * обращаться в сеть при проверке".
 *
 * Body validation lives here, not in the pure module: `checkModelCompatibility` trusts its typed
 * input completely, so an HTTP body that does not even shape up as one is refused with
 * `INVALID_ARGUMENT` before it ever reaches that function, the same way `routes/environments.ts`
 * validates its own request bodies.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, ModelCompatibility, RuntimeDescriptor } from '../../contracts/index.js'
import { TENSORRT_LLM_ENGINE_ID } from '../environment/index.js'
import type { InstallationStore, RuntimeDescriptorProvider } from '../environment/index.js'
import { checkModelCompatibility } from './compatibility.js'
import type { CheckpointFile, ModelCheckInput } from './compatibility.js'
import type { JsonObject } from './quant-format.js'
import { tensorrtLlmSettings } from './settings.js'

export interface ModelCheckHostFacts {
  gpus: GpuFacts[]
  memAvailableBytes: number
}

export interface ModelCheckDeps {
  /** The setup operation's installation records; a torn or foreign file is skipped there. */
  installations: Pick<InstallationStore, 'list'>
  descriptors: Pick<RuntimeDescriptorProvider, 'forInstallation' | 'cachedForNewSetup'>
  /** Never asks Docker anything (see the file banner); a card can disappear between two checks. */
  hostFacts: () => Promise<ModelCheckHostFacts>
  /** The provider's stored settings (`settings.get('tensorrt-llm')`), for `kv_cache_free_gpu_memory_fraction`. */
  settings: () => Record<string, unknown>
}

const invalid = (why: string, details?: string): never => {
  throw new AtomicCoreError('INVALID_ARGUMENT', why, details)
}

const object = (value: unknown, at: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : (invalid(`${at} must be an object.`) as never)

const known = (source: Record<string, unknown>, at: string, keys: readonly string[]): void => {
  const extra = Object.keys(source).filter((key) => !keys.includes(key))
  if (extra.length > 0) invalid(`${at} has fields this core does not know.`, extra.sort().join(', '))
}

const nonEmptyString = (value: unknown, at: string): string =>
  typeof value === 'string' && value !== '' ? value : (invalid(`${at} must be a non-empty string.`) as never)

const jsonObject = (value: unknown, at: string): JsonObject => object(value, at)

const nullableJsonObject = (value: unknown, at: string): JsonObject | null =>
  value === null || value === undefined ? null : object(value, at)

const fileSize = (value: unknown, at: string): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : (invalid(`${at} must be a non-negative number.`) as never)

const fileSha256 = (value: unknown, at: string): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  return invalid(`${at} must be a string or null.`) as never
}

const checkpointFile = (value: unknown, at: string): CheckpointFile => {
  const raw = object(value, at)
  return {
    path: nonEmptyString(raw['path'], `${at}.path`),
    size: fileSize(raw['size'], `${at}.size`),
    sha256: fileSha256(raw['sha256'], `${at}.sha256`),
  }
}

const files = (value: unknown, at: string): CheckpointFile[] =>
  Array.isArray(value)
    ? value.map((entry, index) => checkpointFile(entry, `${at}[${index}]`))
    : (invalid(`${at} must be an array.`) as never)

const optionalGpuId = (value: unknown): string | undefined => {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value
  return invalid('gpu_id must be a string.') as never
}

/** `INVALID_ARGUMENT` for anything that does not shape up as `ModelCheckInput`; every field the spec names. */
export function parseModelCheckInput(body: unknown): ModelCheckInput {
  const raw = object(body, 'the request')
  known(raw, 'the request', [
    'repository',
    'revision',
    'config_json',
    'hf_quant_config_json',
    'files',
    'gpu_id',
  ])
  const gpuId = optionalGpuId(raw['gpu_id'])
  return {
    repository: nonEmptyString(raw['repository'], 'repository'),
    revision: nonEmptyString(raw['revision'], 'revision'),
    config_json: jsonObject(raw['config_json'], 'config_json'),
    hf_quant_config_json: nullableJsonObject(raw['hf_quant_config_json'], 'hf_quant_config_json'),
    files: files(raw['files'], 'files'),
    ...(gpuId === undefined ? {} : { gpu_id: gpuId }),
  }
}

/**
 * The descriptor to check against: the `ready` `tensorrt-llm` installation's pinned descriptor when
 * there is one, else the latest accepted cached descriptor — spec "по закреплённому дескриптору
 * установки (или по актуальному, если движок не установлен)". Throws the descriptor provider's own
 * `MANAGED_METADATA_INVALID` when neither is available (nothing has ever been cached).
 */
async function descriptorForCheck(
  deps: Pick<ModelCheckDeps, 'installations' | 'descriptors'>
): Promise<RuntimeDescriptor> {
  const ours = (await deps.installations.list())
    .map((record) => record.installation)
    .filter((installation) => installation.engine_id === TENSORRT_LLM_ENGINE_ID)
  const ready = ours.find(
    (installation) => installation.status === 'ready' && installation.active_descriptor_id !== null
  )
  const resolved =
    ready !== undefined
      ? await deps.descriptors.forInstallation(ready.active_descriptor_id as string)
      : await deps.descriptors.cachedForNewSetup()
  if (resolved.kind !== 'available') throw resolved.error
  return resolved.descriptor
}

/**
 * The full route: validate, resolve the descriptor and host facts (in parallel), then the pure
 * check. Without an explicit `gpu_id` in the request, checks against the card a real load would
 * pick — the provider's own stored `gpu_id` setting, falling back to `selectLaunchGpu`'s "most
 * memory" rule only when nothing is saved either (task 2.16w round 1, finding 3) — never just
 * "most memory" outright, which could silently check a different card than the one that would load.
 */
export async function checkTensorrtLlmModel(
  body: unknown,
  deps: ModelCheckDeps
): Promise<ModelCompatibility> {
  const input = parseModelCheckInput(body)
  const [descriptor, facts] = await Promise.all([descriptorForCheck(deps), deps.hostFacts()])
  const settings = tensorrtLlmSettings(deps.settings())
  const gpuId = input.gpu_id ?? settings.gpu_id ?? undefined
  return checkModelCompatibility(
    { ...input, ...(gpuId === undefined ? {} : { gpu_id: gpuId }) },
    descriptor,
    facts.gpus,
    facts.memAvailableBytes,
    {
      contextLength: settings.context_length,
      kvCacheFreeGpuMemoryFraction: settings.kv_cache_free_gpu_memory_fraction,
    }
  )
}
