/**
 * `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`, design D12/D13/D17/D18):
 * whether a Hugging Face checkpoint can run on TensorRT-LLM on this host, computed entirely from
 * what the caller already has — `config.json`, `hf_quant_config.json` when the repository carries
 * one, the revision's file listing, the pinned `RuntimeDescriptor`, the host's `GpuFacts[]` and its
 * `MemAvailable` — before a single byte of the checkpoint is downloaded.
 *
 * This is the pure verdict only. It does not read the pinned descriptor from disk, does not probe
 * the host for `GpuFacts`, does not read `<data>/tensorrt-llm/models/*`, and — like every file in
 * this module — never touches the network or the filesystem; those are the route handler's and the
 * `ModelRegistry`'s job, wired up once the provider (task 2.14) exists. `selectLaunchGpu` is
 * exported on its own because task 2.14's load path picks the same card the same way.
 *
 * Check order: GGUF is rejected outright before anything else (spec: "for GGUF there is
 * llama.cpp"), then a curated match's `inventory_digest` is verified — an integrity gate that is
 * independent of whether the checkpoint would otherwise load, so a tampered curated listing is
 * reported as `MANAGED_METADATA_INVALID` rather than whatever compatibility error the tampered
 * files happen to also trigger. Only then: quantization format recognised, architecture supported,
 * format present in this descriptor's own matrix, the file listing has at least one weight file,
 * the format's compute-capability rule (minimum and exclusion list), and finally weight bytes plus
 * the KV-cache reserve against the selected card's free memory.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, ModelCompatibility, RuntimeDescriptor } from '../../contracts/index.js'
import { inventoryDigest } from '../environment/index.js'
import { describeUnrecognizedQuantization, isGgufCheckpoint, quantizationFormat } from './quant-format.js'
import type { JsonObject } from './quant-format.js'

/** One file of the revision's listing, as the route contract carries it (spec `tensorrt-llm-models`). */
export interface CheckpointFile {
  /** Repository-relative, forward slashes, as Hugging Face spells it. */
  path: string
  size: number
  /** The repository's own published digest, or `null` when it has none (a non-LFS file). */
  sha256: string | null
}

/** Input to `checkModelCompatibility`, matching what `POST /models/tensorrt-llm/check` accepts. */
export interface ModelCheckInput {
  repository: string
  revision: string
  config_json: JsonObject
  /** `null` when the repository does not carry the file at all. */
  hf_quant_config_json: JsonObject | null
  files: CheckpointFile[]
  /** Omitted or not found on this host falls back to `selectLaunchGpu`'s "most memory" rule. */
  gpu_id?: string
}

/**
 * The card a launch would pick (task 2.14 reuses this): `gpu_id` when given and present on the
 * host, otherwise the card with the most total memory. `null` only when the host has no GPU at all.
 *
 * "Most memory" ranks by `total_vram_bytes`, the card's own nominal size, not `free_vram_bytes` —
 * placement should not change moment to moment as other sessions load and unload. A unified-memory
 * card (`total_vram_bytes: null`, design D13) ranks alongside a `0`-byte card rather than an
 * infinite one: with no dedicated VRAM figure to compare, assuming it is host memory large would be
 * a guess this function has no evidence for; a host with exactly one GPU (the only case a
 * unified-memory descriptor covers today, GB10/DGX Spark) still selects it as the sole candidate.
 */
export function selectLaunchGpu(gpus: readonly GpuFacts[], gpuId?: string): GpuFacts | null {
  if (gpuId !== undefined) {
    const requested = gpus.find((gpu) => gpu.gpu_id === gpuId)
    if (requested !== undefined) return requested
  }
  if (gpus.length === 0) return null
  return gpus.reduce((best, gpu) => ((gpu.total_vram_bytes ?? 0) > (best.total_vram_bytes ?? 0) ? gpu : best))
}

const SAFETENSORS_SUFFIX = '.safetensors'
const CONSOLIDATED_PREFIX = 'consolidated'
const LEGACY_WEIGHT_SUFFIXES = ['.bin', '.pth']
/** `model.safetensors`, or a sharded `model-00001-of-00003.safetensors` (any digit width). */
const MODEL_SHARD_PATTERN = /^model(-\d+-of-\d+)?\.safetensors$/i

/** A file at the root of the listing: a variant subfolder, an ONNX export, ... never counts as a weight. */
function isRootLevel(path: string): boolean {
  return !path.includes('/')
}

/**
 * A root-level `*.safetensors` file that is not a `consolidated*` redundant export. Some
 * repositories (Mistral's own releases are the common case) ship both the standard HF
 * `model-NNNNN-of-MMMMM.safetensors` shards *and* a `consolidated.safetensors` covering the exact
 * same weights in one file, for their own inference stack; treating both as weights would
 * double-count the checkpoint's real size.
 */
export function isWeightFile(path: string): boolean {
  return (
    isRootLevel(path) &&
    path.toLowerCase().endsWith(SAFETENSORS_SUFFIX) &&
    !path.toLowerCase().startsWith(CONSOLIDATED_PREFIX)
  )
}

function isPreferredShard(path: string): boolean {
  return isRootLevel(path) && MODEL_SHARD_PATTERN.test(path)
}

function isAnySafetensors(path: string): boolean {
  return isRootLevel(path) && path.toLowerCase().endsWith(SAFETENSORS_SUFFIX)
}

function isLegacyWeightFile(path: string): boolean {
  if (!isRootLevel(path)) return false
  const lower = path.toLowerCase()
  return LEGACY_WEIGHT_SUFFIXES.some((suffix) => lower.endsWith(suffix))
}

const sumSizes = (files: readonly CheckpointFile[]): number => files.reduce((sum, file) => sum + file.size, 0)

/**
 * Weight bytes for the memory check. Root-level files only. Prefers the standard
 * `model[-NNNNN-of-MMMMM].safetensors` shard naming when present — which also excludes a
 * `consolidated*.safetensors` sitting next to it (the Mistral double-count case above) — because
 * that naming alone identifies the checkpoint's real weights unambiguously. When no file matches
 * that preferred naming, every other root-level `*.safetensors` file is summed instead (covers a
 * repository that ships only `consolidated.safetensors`, or any other single-file naming). Only
 * when there is no safetensors file at all does a legacy `*.bin`/`*.pth` checkpoint count, so a
 * checkpoint this engine cannot load (it only reads safetensors) still gets an honest, non-zero
 * `weight_bytes` rather than a silent `0` that would let `checkModelCompatibility` report `ok` on
 * any card. A listing with no weight file under any of these rules yields `0`, which
 * `checkModelCompatibility` itself turns into `MODEL_INCOMPATIBLE`, never a false `ok`.
 */
export function weightBytes(files: readonly CheckpointFile[]): number {
  const preferredShards = files.filter((file) => isPreferredShard(file.path))
  if (preferredShards.length > 0) return sumSizes(preferredShards)

  const anySafetensors = files.filter((file) => isAnySafetensors(file.path))
  if (anySafetensors.length > 0) return sumSizes(anySafetensors)

  const legacy = files.filter((file) => isLegacyWeightFile(file.path))
  return sumSizes(legacy)
}

/**
 * Fraction of weight bytes reserved on top of them when checking whether a checkpoint fits a
 * card's free memory: headroom for the engine build step and a minimal KV cache. `trtllm-serve`'s
 * actual KV-cache budget is `kv_cache_free_gpu_memory_fraction` of memory still free *after*
 * weights load, applied once a session starts with a known context length (provider setting, task
 * 2.14); that fraction cannot be reused here because this check runs with no context length at all
 * — applying a large fraction to *remaining* free memory would make the check nearly always pass
 * regardless of card size, defeating its purpose. This is a documented, conservative placeholder
 * scaled to the checkpoint itself instead, refined once task 2.14 threads the real setting and a
 * context length through a pre-launch re-check.
 */
export const KV_CACHE_RESERVE_FRACTION_OF_WEIGHTS = 0.1

export function kvCacheReserveBytes(weightBytesTotal: number): number {
  return Math.ceil(weightBytesTotal * KV_CACHE_RESERVE_FRACTION_OF_WEIGHTS)
}

/** Free memory to compare against for one card: `MemAvailable` for a unified-memory card (design D13). */
function freeMemoryBytes(gpu: GpuFacts, hostMemAvailableBytes: number): number {
  return gpu.total_vram_bytes === null ? hostMemAvailableBytes : (gpu.free_vram_bytes ?? 0)
}

/**
 * Numeric compare of two `"major.minor[.patch...]"` compute-capability strings, `a - b`'s sign.
 * `NaN` when either side has a non-numeric component (an unparseable `compute_capability`) —
 * callers must never treat a `NaN` result as "not less than", which would fail open.
 */
function compareComputeCapability(a: string, b: string): number {
  const partsA = a.split('.').map((part) => Number.parseInt(part, 10))
  const partsB = b.split('.').map((part) => Number.parseInt(part, 10))
  const length = Math.max(partsA.length, partsB.length)
  for (let index = 0; index < length; index += 1) {
    const da = partsA[index] ?? 0
    const db = partsB[index] ?? 0
    if (da !== db) return da - db
  }
  return 0
}

/**
 * Whether `actual` meets `min`. `false` whenever `compareComputeCapability` cannot parse either
 * side (`NaN`): an unparseable compute capability is treated as incompatible, never as "compatible
 * by default" — `NaN < 0` is `false`, so comparing the raw sign directly would fail open.
 */
function computeCapabilityAtLeast(actual: string, min: string): boolean {
  const compared = compareComputeCapability(actual, min)
  return !Number.isNaN(compared) && compared >= 0
}

/** Whether `format` is loadable on `gpu` per the descriptor's per-format compute-capability rule. */
function formatAllowedOnGpu(descriptor: RuntimeDescriptor, format: string, gpu: GpuFacts): boolean {
  const support = descriptor.quantization.find((entry) => entry.format === format)
  if (support === undefined) return false
  if (!computeCapabilityAtLeast(gpu.compute_capability, support.min_compute_capability)) return false
  return !support.excluded_compute_capabilities.includes(gpu.compute_capability)
}

/** Every other GPU (not `selected`) the checkpoint would fit on: architecture-independent, format's CC rule plus free memory. */
function fitsOtherGpus(
  gpus: readonly GpuFacts[],
  selected: GpuFacts,
  descriptor: RuntimeDescriptor,
  format: string,
  neededBytes: number,
  hostMemAvailableBytes: number
): string[] {
  return gpus
    .filter((gpu) => gpu.gpu_id !== selected.gpu_id)
    .filter((gpu) => formatAllowedOnGpu(descriptor, format, gpu))
    .filter((gpu) => neededBytes <= freeMemoryBytes(gpu, hostMemAvailableBytes))
    .map((gpu) => gpu.gpu_id)
}

/** `exactOptionalPropertyTypes` needs `sha256` omitted, not set to `undefined`, when there is none. */
function toInventoryFile(file: CheckpointFile): { path: string; bytes: number; sha256?: string } {
  return file.sha256 === null
    ? { path: file.path, bytes: file.size }
    : { path: file.path, bytes: file.size, sha256: file.sha256 }
}

function readArchitectures(configJson: JsonObject): string[] {
  const value = configJson.architectures
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []
}

interface VerdictContext {
  architectures: string[]
  quantizationFormat: string | null
  weightBytesTotal: number
  selected: GpuFacts
  curated: boolean
}

function buildCompatibility(
  context: VerdictContext,
  verdict: ModelCompatibility['verdict'],
  fitsOther: string[]
): ModelCompatibility {
  return {
    architectures: context.architectures,
    quantization_format: context.quantizationFormat,
    weight_bytes: context.weightBytesTotal,
    checked_gpu_id: context.selected.gpu_id,
    curated: context.curated,
    unified_memory: context.selected.total_vram_bytes === null,
    fits_other_gpus: fitsOther,
    verdict,
  }
}

/**
 * The full verdict. Throws `AtomicCoreError('INVALID_ARGUMENT', …)` for two caller-input problems
 * that are never a fact about the checkpoint itself: the host has no GPU at all (`gpus` empty), or
 * the file listing names `hf_quant_config.json` while `hf_quant_config_json` is `null` (the caller
 * said the file exists but did not send its content, so the format naming rule cannot be trusted).
 * `inventoryDigest` can also throw `AtomicCoreError('MANAGED_METADATA_INVALID', …)` for a curated
 * match whose file listing is itself malformed (an empty or repeated path, a NUL byte, a
 * non-integer size — see `src/runtime/environment/inventory.ts`), before this function gets a
 * chance to compare digests. Every other input, however incompatible, is a normal
 * `verdict.ok: false` answer, never a thrown error (design D12: the point of this check is to hand
 * back numbers, not to fail the request).
 */
export function checkModelCompatibility(
  input: ModelCheckInput,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemAvailableBytes: number
): ModelCompatibility {
  if (
    input.files.some((file) => file.path === 'hf_quant_config.json') &&
    input.hf_quant_config_json === null
  ) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'The file listing includes hf_quant_config.json but hf_quant_config_json was not provided.'
    )
  }

  const selected = selectLaunchGpu(gpus, input.gpu_id)
  if (selected === null) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'No GPU is available to check compatibility against.')
  }

  const architectures = readArchitectures(input.config_json)
  const gguf = isGgufCheckpoint(input.files)
  const format = gguf ? null : quantizationFormat(input.config_json, input.hf_quant_config_json)
  const weightBytesTotal = weightBytes(input.files)

  const curatedEntry = descriptor.curated_models.find(
    (model) => model.repository === input.repository && model.revision === input.revision
  )

  const context: VerdictContext = {
    architectures,
    quantizationFormat: format,
    weightBytesTotal,
    selected,
    curated: curatedEntry !== undefined,
  }

  // Integrity gate first: a curated repository/revision match whose files do not hash to the
  // pinned inventory_digest is reported as tampered metadata, not as whatever ordinary
  // compatibility error those files happen to also trigger.
  if (curatedEntry !== undefined) {
    const actualDigest = inventoryDigest(input.files.map(toInventoryFile))
    if (actualDigest !== curatedEntry.inventory_digest) {
      return buildCompatibility(
        { ...context, curated: false },
        {
          ok: false,
          error: {
            code: 'MANAGED_METADATA_INVALID',
            message: 'The submitted file listing does not match the curated inventory digest.',
            details: `expected=${curatedEntry.inventory_digest} actual=${actualDigest}`,
          },
        },
        []
      )
    }
  }

  if (gguf) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: 'GGUF checkpoints are not supported by tensorrt-llm; use the llama.cpp provider for GGUF.',
        },
      },
      []
    )
  }

  if (format === null) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: `Unsupported quantization format: ${describeUnrecognizedQuantization(input.config_json, input.hf_quant_config_json)}.`,
          details: `repository=${input.repository} revision=${input.revision}`,
        },
      },
      []
    )
  }

  const architecture = architectures.length > 0 ? architectures[0] : undefined
  if (architecture === undefined || !descriptor.supported_architectures.includes(architecture)) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message:
            architecture === undefined
              ? 'config.json does not declare an architecture.'
              : `Unsupported architecture: ${architecture}.`,
          ...(architecture !== undefined ? { details: architecture } : {}),
        },
      },
      []
    )
  }

  const formatSupport = descriptor.quantization.find((entry) => entry.format === format)
  if (formatSupport === undefined) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: `Unsupported quantization format: "${format}" is not part of this engine's descriptor.`,
          details: format,
        },
      },
      []
    )
  }

  if (weightBytesTotal === 0) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: 'No checkpoint weight files were found in the file listing.',
        },
      },
      []
    )
  }

  // Known from here on: architecture and format are both fine, so any card whose own CC clears
  // this format and has room is a real alternative — compute it once and reuse it in every
  // remaining branch, including the two CC-failure branches below, so a caller whose selected card
  // fails on CC still sees a card that would work (spec: "report which other host cards it would
  // fit").
  const reserveBytes = kvCacheReserveBytes(weightBytesTotal)
  const neededBytes = weightBytesTotal + reserveBytes
  const freeBytes = freeMemoryBytes(selected, hostMemAvailableBytes)
  const fitsOther = fitsOtherGpus(gpus, selected, descriptor, format, neededBytes, hostMemAvailableBytes)

  if (!computeCapabilityAtLeast(selected.compute_capability, formatSupport.min_compute_capability)) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: `Format ${format} requires compute capability ${formatSupport.min_compute_capability} or newer.`,
          details: `required=${formatSupport.min_compute_capability} actual=${selected.compute_capability}`,
        },
      },
      fitsOther
    )
  }

  if (formatSupport.excluded_compute_capabilities.includes(selected.compute_capability)) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: `Format ${format} is not supported by this engine release on compute capability ${selected.compute_capability}.`,
          details: `format=${format} compute_capability=${selected.compute_capability}`,
        },
      },
      fitsOther
    )
  }

  if (neededBytes > freeBytes) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: 'The checkpoint plus the KV-cache reserve does not fit the selected GPU.',
          details: `weight_bytes=${weightBytesTotal} kv_reserve_bytes=${reserveBytes} needed_bytes=${neededBytes} free_bytes=${freeBytes}`,
        },
      },
      fitsOther
    )
  }

  return buildCompatibility(context, { ok: true }, fitsOther)
}
