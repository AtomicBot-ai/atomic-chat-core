/**
 * Reading a runtime descriptor: the metadata that says which container image an engine runs, what
 * the host needs first, and what that release can load. Shape follows
 * `atomic-chat-conf/runtimes/schema.json`, the source of truth for what a published descriptor
 * contains; this parser is the core's own trust boundary for it (conf CI enforces the schema, this
 * enforces it again on the wire, since a descriptor arrives over HTTPS and is never trusted blind).
 *
 * Two rules shape this file, both from the schema's own description. A descriptor carries data and
 * only data — no command, no argv, no script — because the argv belongs to the compiled adapter
 * inside this binary; the descriptor may only name an adapter id. (Which distributions core may
 * install a container runtime on is the environment manifest's, `environment-manifest.ts`.) And every image is pinned by digest: a descriptor that names a tag is
 * refused, because a tag can be repointed by whoever owns the registry and a qualification result
 * is about exact bytes.
 *
 * Scope for this task (openspec change `add-tensorrt-llm-linux`, task 2.1): only the pure shape
 * validator that proves the parser accepts the real `runtimes/tensorrt-llm.json` fixture. It does
 * not yet check a descriptor's `adapter_id` against a compiled adapter registry (design D9's
 * `ManagedTextAdapter` registry does not exist until task 2.12) — that check, HTTPS fetching,
 * on-disk caching and `descriptor_id` pinning are task 2.2's `src/runtime/environment/*`.
 */

import type {
  CuratedModel,
  ModelFamilySupport,
  PlatformImage,
  PlatformImageMap,
  QuantizationSupport,
  RuntimeDescriptor,
  RuntimeDescriptorSummary,
  Sha256Digest,
} from '../../contracts/index.js'
import { DOCUMENT_ID, DOCUMENT_ID_LABEL, DOCUMENT_SEMVER, documentFields } from './document-fields.js'

const DIGEST = /^sha256:[0-9a-f]{64}$/
/** NVML's `major.minor`, e.g. `8.9` or `12.0`. */
const CAPABILITY = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/
/** NVIDIA display driver version: 2 or 3 dot-separated components, e.g. `590.44.01`. */
const DRIVER_VERSION = /^[0-9]+\.[0-9]+(\.[0-9]+)?$/
/** HF `config.json` `architectures` entries and `model_families` keys, e.g. `LlamaForCausalLM`. */
const ARCHITECTURE_NAME = /^[A-Z][A-Za-z0-9]*$/
/** A bare parser name: no flags, no paths, no leading dash — the adapter passes it as one argv value. */
const PARSER_NAME = /^[a-z0-9][a-z0-9_.-]*$/

// The patterns below are copied character-for-character from
// `atomic-chat-conf/runtimes/schema.json`'s `definitions`, so this parser's trust boundary is at
// least as strict as what conf CI already enforced on the published document. Do not relax one of
// these without updating the schema first — the descriptor is untrusted network input, and a field
// like a repository ends up in `docker` argv (task 2.8), so a pattern miss here is not cosmetic.
// `id` and `semver` are shared with the environment manifest (`document-fields.ts`).

/** `#/definitions/imageRepository`: no `@digest`, no `:tag` after the last path segment. */
const IMAGE_REPOSITORY = /^[a-z0-9.-]+(:[0-9]+)?(\/[a-z0-9._-]+)+$/
/** `curatedModel.repository`: a Hugging Face `owner/name`. */
const CURATED_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/
/** `curatedModel.revision`: an immutable 40-character Hugging Face commit sha. */
const REVISION = /^[0-9a-f]{40}$/
/** `quantizationEntry.format`: lowercase with underscores, e.g. `fp8_block_scales`. */
const QUANTIZATION_FORMAT = /^[a-z0-9_]+$/

// A newer catalog announces itself with `schema_version`, never with a field this build would
// ignore: silently dropping a field could mean ignoring an exclusion that matters. That is also why
// a descriptor still carrying `recipes` (the `r1` shape) is refused outright, not read around: the
// distribution list moved to the environment manifest (change `extract-environment-manifest`, D6).
const { fail, object, known, text, boolean, pattern, list, strings, unique, bytes } =
  documentFields('runtime descriptor')

const digest = (value: unknown, at: string): Sha256Digest =>
  pattern(DIGEST, 'a sha256 digest')(value, at) as Sha256Digest

const capability = pattern(CAPABILITY, 'a major.minor compute capability')
const driverVersion = pattern(DRIVER_VERSION, 'a driver version')
const architectureName = pattern(ARCHITECTURE_NAME, 'an architecture class name')
const id = pattern(DOCUMENT_ID, DOCUMENT_ID_LABEL)
const semver = pattern(DOCUMENT_SEMVER, 'a semver version (major.minor.patch)')
const imageRepository = pattern(IMAGE_REPOSITORY, 'a bare image repository')
const curatedRepository = pattern(CURATED_REPOSITORY, 'a Hugging Face owner/name repository')
const revision = pattern(REVISION, 'a 40-character hex commit sha')
const quantizationFormat = pattern(QUANTIZATION_FORMAT, 'a lowercase quantization format')

const parserName = (value: unknown, at: string): string | null => {
  if (value === null) return null
  return pattern(PARSER_NAME, 'a bare parser name')(value, at)
}

const PLATFORM_IMAGE_KEYS = ['repository', 'digest'] as const
const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const

/**
 * `imageRepository` (schema): a bare repository — no `:tag`, no `@digest`, lowercase, one or more
 * `/`-separated path segments, an optional `:port` right after the host. The digest field pins the
 * bytes; the pattern alone is what stops a value like `-v /:/host` from reaching `docker` argv
 * (task 2.8) disguised as a repository — the old ad hoc "does it contain `@`/`:`" check missed it.
 */
const platformImage = (value: unknown, at: string): PlatformImage => {
  const entry = object(value, at)
  known(entry, at, PLATFORM_IMAGE_KEYS)
  return {
    repository: imageRepository(entry['repository'], `${at}.repository`),
    digest: digest(entry['digest'], `${at}.digest`),
  }
}

/** Required for every platform this release supports: `linux/amd64` and `linux/arm64`, no more. */
const platformImageMap = (value: unknown, at: string): PlatformImageMap => {
  const map = object(value, at)
  known(map, at, PLATFORMS)
  for (const platform of PLATFORMS) {
    if (!(platform in map)) fail(`${at} is missing ${platform}`)
  }
  return {
    'linux/amd64': platformImage(map['linux/amd64'], `${at}["linux/amd64"]`),
    'linux/arm64': platformImage(map['linux/arm64'], `${at}["linux/arm64"]`),
  }
}

/**
 * A compute-capability string as an `[major, minor]` tuple, comparable with `<`/`>` the way the
 * schema's own driver-version comparison is defined: componentwise, not lexicographically (`"9.0"`
 * must sort below `"12.0"`).
 */
const capabilityTuple = (value: string): [number, number] => {
  const [major = '0', minor = '0'] = value.split('.')
  return [Number(major), Number(minor)]
}

const capabilityBelowOrEqual = (a: [number, number], b: [number, number]): boolean =>
  a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1])

const QUANTIZATION_KEYS = ['format', 'min_compute_capability', 'excluded_compute_capabilities'] as const

const quantizationEntry = (value: unknown, at: string): QuantizationSupport => {
  const entry = object(value, at)
  known(entry, at, QUANTIZATION_KEYS)
  const format = quantizationFormat(entry['format'], `${at}.format`)
  const minCapability = capability(entry['min_compute_capability'], `${at}.min_compute_capability`)
  const excluded = strings(entry['excluded_compute_capabilities'], `${at}.excluded_compute_capabilities`).map(
    (value, i) => capability(value, `${at}.excluded_compute_capabilities[${i}]`)
  )
  unique(excluded, `${at}.excluded_compute_capabilities`, 'a compute capability')
  const min = capabilityTuple(minCapability)
  for (const excludedValue of excluded) {
    // design D17 / conf task 1.4: an excluded capability that is not above the format's own
    // minimum is not a gap in the support matrix, it is a contradiction — the format would need to
    // be unsupported at its own floor.
    if (capabilityBelowOrEqual(capabilityTuple(excludedValue), min)) {
      fail(
        `${at}.excluded_compute_capabilities has an entry not above min_compute_capability`,
        `${excludedValue} <= ${minCapability}`
      )
    }
  }
  return { format, min_compute_capability: minCapability, excluded_compute_capabilities: excluded }
}

const MODEL_FAMILY_KEYS = ['tool_parser', 'reasoning_parser', 'structured_output'] as const

const modelFamilyEntry = (value: unknown, at: string): ModelFamilySupport => {
  const entry = object(value, at)
  known(entry, at, MODEL_FAMILY_KEYS)
  return {
    tool_parser: parserName(entry['tool_parser'], `${at}.tool_parser`),
    reasoning_parser: parserName(entry['reasoning_parser'], `${at}.reasoning_parser`),
    structured_output: boolean(entry['structured_output'], `${at}.structured_output`),
  }
}

const modelFamilies = (value: unknown, at: string): Record<string, ModelFamilySupport> => {
  const map = object(value, at)
  const result: Record<string, ModelFamilySupport> = {}
  for (const [key, entry] of Object.entries(map)) {
    architectureName(key, `${at} key "${key}"`)
    result[key] = modelFamilyEntry(entry, `${at}["${key}"]`)
  }
  return result
}

const CURATED_MODEL_KEYS = ['repository', 'revision', 'inventory_digest', 'vram_tier_bytes', 'note'] as const

const curatedModel = (value: unknown, at: string): CuratedModel => {
  const entry = object(value, at)
  known(entry, at, CURATED_MODEL_KEYS)
  return {
    repository: curatedRepository(entry['repository'], `${at}.repository`),
    revision: revision(entry['revision'], `${at}.revision`),
    inventory_digest: digest(entry['inventory_digest'], `${at}.inventory_digest`),
    // Schema minimum is 1: a curated entry with 0 would claim every card, however small, fits it.
    vram_tier_bytes: bytes(entry['vram_tier_bytes'], `${at}.vram_tier_bytes`, 1),
    note: text(entry['note'], `${at}.note`),
  }
}

const DESCRIPTOR_KEYS = [
  'schema_version',
  'descriptor_id',
  'engine_id',
  'adapter_id',
  'adapter_contract_version',
  'image',
  'probe_image',
  'minimum_core_version',
  'minimum_app_version',
  'minimum_driver_version',
  'minimum_compute_capability',
  'supported_architectures',
  'quantization',
  'model_families',
  'curated_models',
  'download_bytes',
  'required_disk_bytes',
  'notices',
  'exclusions',
] as const

/**
 * Validate one descriptor's shape against `atomic-chat-conf/runtimes/schema.json`. Throws
 * `AtomicCoreError('MANAGED_METADATA_INVALID', ...)` naming the first field that does not fit.
 *
 * Does not check `adapter_id` against a compiled adapter registry. A descriptor carrying `recipes`
 * is refused as an unknown field: install recipes are the environment manifest's.
 */
export function parseRuntimeDescriptor(input: unknown): RuntimeDescriptor {
  const raw = object(input, 'the descriptor')
  known(raw, 'the descriptor', DESCRIPTOR_KEYS)

  if (raw['schema_version'] !== 1) {
    fail('schema_version is not 1', JSON.stringify(raw['schema_version']))
  }
  if (raw['adapter_contract_version'] !== 1) {
    fail('adapter_contract_version is not 1', JSON.stringify(raw['adapter_contract_version']))
  }

  const architectures = strings(raw['supported_architectures'], 'supported_architectures').map((value, i) =>
    architectureName(value, `supported_architectures[${i}]`)
  )
  if (architectures.length === 0) fail('supported_architectures is empty')
  unique(architectures, 'supported_architectures', 'an architecture')

  const quantization = list(raw['quantization'], 'quantization').map((item, i) =>
    quantizationEntry(item, `quantization[${i}]`)
  )
  if (quantization.length === 0) fail('quantization is empty')
  unique(
    quantization.map((q) => q.format),
    'quantization',
    'a format'
  )

  const curated = list(raw['curated_models'], 'curated_models').map((item, i) =>
    curatedModel(item, `curated_models[${i}]`)
  )
  unique(
    curated.map((m) => `${m.repository}@${m.revision}`),
    'curated_models',
    'a model revision'
  )

  return {
    schema_version: 1,
    descriptor_id: id(raw['descriptor_id'], 'descriptor_id'),
    engine_id: id(raw['engine_id'], 'engine_id'),
    adapter_id: id(raw['adapter_id'], 'adapter_id'),
    adapter_contract_version: 1,
    image: platformImageMap(raw['image'], 'image'),
    probe_image: platformImageMap(raw['probe_image'], 'probe_image'),
    minimum_core_version: semver(raw['minimum_core_version'], 'minimum_core_version'),
    minimum_app_version: semver(raw['minimum_app_version'], 'minimum_app_version'),
    minimum_driver_version: driverVersion(raw['minimum_driver_version'], 'minimum_driver_version'),
    minimum_compute_capability: capability(raw['minimum_compute_capability'], 'minimum_compute_capability'),
    supported_architectures: architectures,
    quantization,
    model_families: modelFamilies(raw['model_families'], 'model_families'),
    curated_models: curated,
    download_bytes: bytes(raw['download_bytes'], 'download_bytes'),
    required_disk_bytes: bytes(raw['required_disk_bytes'], 'required_disk_bytes'),
    notices: strings(raw['notices'], 'notices'),
    exclusions: strings(raw['exclusions'], 'exclusions'),
  }
}

/**
 * The client-facing part of a descriptor (task 2.22): its id and engine, the notices exactly as
 * published, the curated checkpoints and the supported architectures. Fresh copies, so nothing that
 * holds the summary can reach into the descriptor it came from.
 */
export function summarizeRuntimeDescriptor(descriptor: RuntimeDescriptor): RuntimeDescriptorSummary {
  return {
    descriptor_id: descriptor.descriptor_id,
    engine_id: descriptor.engine_id,
    notices: [...descriptor.notices],
    curated_models: descriptor.curated_models.map((model) => ({ ...model })),
    supported_architectures: [...descriptor.supported_architectures],
  }
}
