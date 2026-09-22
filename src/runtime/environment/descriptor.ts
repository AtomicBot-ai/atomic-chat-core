/**
 * Reading a runtime descriptor: the metadata that says which container image an engine runs, what
 * the host needs first, and what that release can load.
 *
 * It arrives over the network, so it is parsed rather than trusted. Two rules shape this file.
 * A descriptor carries data and only data — no command, no argv, no script — because the argv
 * belongs to the compiled adapter inside this binary; the descriptor may only name which adapter,
 * and an adapter nobody compiled in makes the runtime unavailable rather than loadable. And the
 * image is pinned by digest: a descriptor that names a tag is refused, because `:1.3.0rc27` can be
 * repointed by whoever owns the registry, and a qualification result is about exact bytes.
 */

import { AtomicCoreError, EXECUTOR_KINDS } from '../../contracts/index.js'
import type {
  ExecutorKind,
  QuantizationSupport,
  RuntimeDescriptor,
  Sha256Digest,
} from '../../contracts/index.js'

/** The compiled adapters this binary has. Injected, so parsing is testable without a registry. */
export interface AdapterCatalog {
  /** The adapter's contract version, or `undefined` when no such adapter is compiled in. */
  contractVersion(adapterId: string): number | undefined
}

const DIGEST = /^sha256:[0-9a-f]{64}$/
/** NVML's `major.minor`, e.g. `8.9` or `12.0`. */
const CAPABILITY = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/

const fail = (why: string, details?: string): never => {
  throw new AtomicCoreError('MANAGED_METADATA_INVALID', `Invalid runtime descriptor: ${why}`, details)
}

const object = (value: unknown, at: string): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : (fail(`${at} is not an object`) as never)

const known = (source: Record<string, unknown>, at: string, keys: readonly string[]): void => {
  const extra = Object.keys(source).filter((key) => !keys.includes(key))
  // A newer catalog announces itself with `schema_version`, never with a field this build would
  // ignore: silently dropping a field could mean ignoring an exclusion that matters.
  if (extra.length > 0) fail(`${at} has unknown fields`, extra.sort().join(', '))
}

const text = (value: unknown, at: string): string =>
  typeof value === 'string' && value.trim() !== ''
    ? value
    : (fail(`${at} is not a non-empty string`) as never)

const digest = (value: unknown, at: string): Sha256Digest =>
  typeof value === 'string' && DIGEST.test(value)
    ? (value as Sha256Digest)
    : (fail(`${at} is not a sha256 digest`, typeof value === 'string' ? value : undefined) as never)

const capability = (value: unknown, at: string): string =>
  typeof value === 'string' && CAPABILITY.test(value)
    ? value
    : (fail(
        `${at} is not a major.minor compute capability`,
        typeof value === 'string' ? value : undefined
      ) as never)

const bytes = (value: unknown, at: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${at} is not a whole number of bytes`, typeof value === 'number' ? String(value) : undefined)
  }
  return value as number
}

const optionalBytes = (value: unknown, at: string): number | null =>
  value === null || value === undefined ? null : bytes(value, at)

const list = (value: unknown, at: string): unknown[] =>
  Array.isArray(value) ? value : (fail(`${at} is not an array`) as never)

const strings = (value: unknown, at: string): string[] =>
  list(value, at).map((item, i) => text(item, `${at}[${i}]`))

const unique = (values: string[], at: string, what: string): void => {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) fail(`${at} lists ${what} twice`, value)
    seen.add(value)
  }
}

/**
 * An image reference must be a bare repository: no `:tag`, no `@digest`. The digest field pins the
 * bytes. A registry host may carry a port, so only a colon after the last `/` is a tag.
 */
const repository = (value: unknown, at: string): string => {
  const name = text(value, at)
  if (name.includes('@')) fail(`${at} pins a digest inside the repository name`, name)
  const last = name.slice(name.lastIndexOf('/') + 1)
  if (last.includes(':')) fail(`${at} names a mutable tag; the image is pinned by digest`, name)
  return name
}

const executor = (value: unknown, at: string): ExecutorKind =>
  EXECUTOR_KINDS.includes(value as ExecutorKind)
    ? (value as ExecutorKind)
    : (fail(`${at} is not a known executor`, typeof value === 'string' ? value : undefined) as never)

const IMAGE_KEYS = ['repository', 'digest', 'platform'] as const
const QUANT_KEYS = ['format', 'min_compute_capability'] as const
const RECIPE_KEYS = ['executor', 'recipe_id', 'digest'] as const
const MODEL_KEYS = ['repository', 'revision', 'inventory_digest', 'vram_tier_bytes', 'note'] as const
const DESCRIPTOR_KEYS = [
  'schema_version',
  'descriptor_id',
  'engine_id',
  'adapter_id',
  'adapter_contract_version',
  'image',
  'entrypoint_digest',
  'minimum_core_version',
  'minimum_app_version',
  'minimum_compute_capability',
  'supported_architectures',
  'quantization',
  'recipes',
  'curated_models',
  'download_bytes',
  'required_disk_bytes',
  'notices',
  'exclusions',
] as const

/**
 * Validate one descriptor. Throws `AtomicCoreError`: `MANAGED_ADAPTER_UNAVAILABLE` when this build
 * has no adapter that can serve it, `MANAGED_METADATA_INVALID` for everything else.
 */
export function parseRuntimeDescriptor(input: unknown, catalog: AdapterCatalog): RuntimeDescriptor {
  const raw = object(input, 'the descriptor')
  known(raw, 'the descriptor', DESCRIPTOR_KEYS)

  if (raw['schema_version'] !== 1) {
    fail('schema_version is not 1', JSON.stringify(raw['schema_version']))
  }

  const adapterId = text(raw['adapter_id'], 'adapter_id')
  const contractVersion = raw['adapter_contract_version']
  if (contractVersion !== 1) fail('adapter_contract_version is not 1', JSON.stringify(contractVersion))
  const compiled = catalog.contractVersion(adapterId)
  if (compiled === undefined) {
    throw new AtomicCoreError(
      'MANAGED_ADAPTER_UNAVAILABLE',
      `No compiled adapter is registered for "${adapterId}".`
    )
  }
  if (compiled !== contractVersion) {
    throw new AtomicCoreError(
      'MANAGED_ADAPTER_UNAVAILABLE',
      `Adapter "${adapterId}" implements contract version ${compiled}, the descriptor asks for ${String(contractVersion)}.`
    )
  }

  const image = object(raw['image'], 'image')
  known(image, 'image', IMAGE_KEYS)
  if (image['platform'] !== 'linux/amd64') {
    fail('image.platform is not linux/amd64', JSON.stringify(image['platform']))
  }

  const architectures = strings(raw['supported_architectures'], 'supported_architectures')
  if (architectures.length === 0) fail('supported_architectures is empty')
  unique(architectures, 'supported_architectures', 'an architecture')

  const quantization: QuantizationSupport[] = list(raw['quantization'], 'quantization').map((item, i) => {
    const entry = object(item, `quantization[${i}]`)
    known(entry, `quantization[${i}]`, QUANT_KEYS)
    return {
      format: text(entry['format'], `quantization[${i}].format`),
      min_compute_capability: capability(
        entry['min_compute_capability'],
        `quantization[${i}].min_compute_capability`
      ),
    }
  })
  unique(
    quantization.map((q) => q.format),
    'quantization',
    'a format'
  )

  const recipes = list(raw['recipes'], 'recipes').map((item, i) => {
    const entry = object(item, `recipes[${i}]`)
    known(entry, `recipes[${i}]`, RECIPE_KEYS)
    return {
      executor: executor(entry['executor'], `recipes[${i}].executor`),
      recipe_id: text(entry['recipe_id'], `recipes[${i}].recipe_id`),
      digest: digest(entry['digest'], `recipes[${i}].digest`),
    }
  })
  unique(
    recipes.map((r) => r.recipe_id),
    'recipes',
    'a recipe id'
  )
  // Two recipes for one executor would leave the host preparation to pick one at random.
  unique(
    recipes.map((r) => r.executor),
    'recipes',
    'an executor'
  )

  const curated = list(raw['curated_models'], 'curated_models').map((item, i) => {
    const entry = object(item, `curated_models[${i}]`)
    known(entry, `curated_models[${i}]`, MODEL_KEYS)
    return {
      repository: text(entry['repository'], `curated_models[${i}].repository`),
      revision: text(entry['revision'], `curated_models[${i}].revision`),
      inventory_digest: digest(entry['inventory_digest'], `curated_models[${i}].inventory_digest`),
      vram_tier_bytes: bytes(entry['vram_tier_bytes'], `curated_models[${i}].vram_tier_bytes`),
      note: text(entry['note'], `curated_models[${i}].note`),
    }
  })
  unique(
    curated.map((m) => `${m.repository}@${m.revision}`),
    'curated_models',
    'a model revision'
  )

  return {
    schema_version: 1,
    descriptor_id: text(raw['descriptor_id'], 'descriptor_id'),
    engine_id: text(raw['engine_id'], 'engine_id'),
    adapter_id: adapterId,
    adapter_contract_version: 1,
    image: {
      repository: repository(image['repository'], 'image.repository'),
      digest: digest(image['digest'], 'image.digest'),
      platform: 'linux/amd64',
    },
    entrypoint_digest: digest(raw['entrypoint_digest'], 'entrypoint_digest'),
    minimum_core_version: text(raw['minimum_core_version'], 'minimum_core_version'),
    minimum_app_version: text(raw['minimum_app_version'], 'minimum_app_version'),
    minimum_compute_capability: capability(raw['minimum_compute_capability'], 'minimum_compute_capability'),
    supported_architectures: architectures,
    quantization,
    recipes,
    curated_models: curated,
    download_bytes: optionalBytes(raw['download_bytes'], 'download_bytes'),
    required_disk_bytes: optionalBytes(raw['required_disk_bytes'], 'required_disk_bytes'),
    notices: strings(raw['notices'], 'notices'),
    exclusions: strings(raw['exclusions'], 'exclusions'),
  }
}
