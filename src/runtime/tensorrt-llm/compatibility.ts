/**
 * `POST /atomic/v1/models/tensorrt-llm/check` (spec `tensorrt-llm-models`, design D12/D13/D17/D18):
 * whether a Hugging Face checkpoint can run on TensorRT-LLM on this host, computed entirely from
 * what the caller already has — `config.json`, `hf_quant_config.json` when the repository carries
 * one, the revision's file listing, the pinned `RuntimeDescriptor`, the host's `GpuFacts[]`, its
 * `MemAvailable` and the provider's `kv_cache_free_gpu_memory_fraction` setting — before a single
 * byte of the checkpoint is downloaded.
 *
 * This is the pure verdict only. It does not read the pinned descriptor from disk, does not probe
 * the host for `GpuFacts`, does not read `<data>/tensorrt-llm/models/*`, does not read stored
 * settings, and — like every file in this module — never touches the network or the filesystem;
 * those are `check.ts`'s, `prelaunch.ts`'s and `registry.ts`'s job (task 2.16), wired up once the
 * provider (task 2.14) exists. `selectLaunchGpu` is exported on its own because the load path
 * (`runtime.ts`) picks the same card the same way.
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
const LEGACY_WEIGHT_SUFFIXES = ['.bin', '.pth']
/** `model.safetensors`, or a sharded `model-00001-of-00003.safetensors` (any digit width). */
const MODEL_SHARD_PATTERN = /^model(-\d+-of-\d+)?\.safetensors$/i

/** A file at the root of the listing: a variant subfolder, an ONNX export, ... never counts as a weight. */
function isRootLevel(path: string): boolean {
  return !path.includes('/')
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
 * The files that count as checkpoint weights — the single rule `weightBytes` and `isWeightFile`
 * both defer to, so the two can never disagree. Root-level files only. Prefers the standard
 * `model[-NNNNN-of-MMMMM].safetensors` shard naming when present — which also excludes a
 * `consolidated*.safetensors` sitting next to it (Mistral's own releases ship both, covering the
 * exact same weights, for their own inference stack; counting both would double the checkpoint's
 * real size) — because that naming alone identifies the checkpoint's real weights unambiguously.
 * When no file matches that preferred naming, every other root-level `*.safetensors` file is
 * selected instead, `consolidated*` included: this is the *only* branch a `consolidated`-only
 * repository (no HF shard naming at all) ever reaches, so its `consolidated.safetensors` has to
 * count here — the same file that the preferred-shard branch above deliberately excludes when a
 * real shard set sits next to it. Only when there is no safetensors file at all does a legacy
 * `*.bin`/`*.pth` checkpoint count, so a checkpoint this engine cannot load (it only reads
 * safetensors) still gets an honest, non-zero total rather than a silent `0` that would let
 * `checkModelCompatibility` report `ok` on any card. No file matches any of these rules for an
 * empty selection, which `weightBytes` turns into `0` and `checkModelCompatibility` itself turns
 * into `MODEL_INCOMPATIBLE`, never a false `ok`.
 */
function selectWeightFiles(files: readonly CheckpointFile[]): readonly CheckpointFile[] {
  const preferredShards = files.filter((file) => isPreferredShard(file.path))
  if (preferredShards.length > 0) return preferredShards

  const anySafetensors = files.filter((file) => isAnySafetensors(file.path))
  if (anySafetensors.length > 0) return anySafetensors

  return files.filter((file) => isLegacyWeightFile(file.path))
}

/** Weight bytes for the memory check: the sum of `selectWeightFiles(files)`. */
export function weightBytes(files: readonly CheckpointFile[]): number {
  return sumSizes(selectWeightFiles(files))
}

/**
 * Whether `path` is one of the files `weightBytes(files)` actually sums, given the rest of the
 * listing it sits in — the same `selectWeightFiles` rule, so the two can never disagree, including
 * for a `consolidated`-only repository: `isWeightFile('consolidated.safetensors', files)` is `true`
 * when no other shard sits next to it (the "any safetensors" branch above selects it) and `false`
 * when a real shard set does (the preferred-shard branch selects those instead). A path's answer is
 * therefore not a property of the path alone — it depends on which other files are present, which a
 * single-argument version of this function could not have gotten right in both cases at once.
 */
export function isWeightFile(path: string, files: readonly CheckpointFile[]): boolean {
  return selectWeightFiles(files).some((file) => file.path === path)
}

/**
 * Bytes reserved on top of the weights when checking whether a checkpoint fits a card's free
 * memory: headroom for the engine build step and a minimal KV cache, as
 * `weightBytesTotal * (1 - kvCacheFreeGpuMemoryFraction)` — `kvCacheFreeGpuMemoryFraction` is the
 * provider's own `kv_cache_free_gpu_memory_fraction` setting (spec `tensorrt-llm-runtime`, "доля
 * свободной GPU-памяти под KV-cache"; task 2.14), passed in rather than read from anywhere here —
 * this module stays settings-free (see the file banner).
 *
 * `trtllm-serve`'s real KV-cache budget is that fraction of whatever memory remains free *after*
 * weights load, sized against a context length this check never has (design D12: there is no
 * session yet to size a KV cache for). Reusing the real formula against *remaining* free memory
 * would make the check nearly always pass — `weights + kv_fraction * (free - weights) <= free`
 * reduces to `weights <= free`, true whenever the checkpoint fits at all, whatever the fraction is
 * — which defeats the point of the check for exactly the case the spec calls out by name: "75 GB
 * FP8 on an 80 GB card" has to come back as either `ok` or a real, numbered shortage, not always
 * `ok` by construction (see the ADR this formula documents, which also derives this reduction in
 * full). Scaling `1 - kv_cache_free_gpu_memory_fraction` — the share of *post-weight* memory the
 * setting leaves unspent — against the checkpoint's own weight bytes instead keeps a real number
 * for a card with no session on it yet, and keeps it tied to what the operator configured: raising
 * `kv_cache_free_gpu_memory_fraction` (spend more of what is left on KV) shrinks this reserve, and
 * lowering it (keep more headroom) grows it. At this setting's own default, `0.9`, the reserve is
 * `10%` of weight bytes, matching the number this check used before the setting existed to derive
 * it from.
 */
export function kvCacheReserveBytes(weightBytesTotal: number, kvCacheFreeGpuMemoryFraction: number): number {
  return Math.ceil(weightBytesTotal * (1 - kvCacheFreeGpuMemoryFraction))
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
 *
 * `kvCacheFreeGpuMemoryFraction` is the provider's `kv_cache_free_gpu_memory_fraction` setting
 * (see `kvCacheReserveBytes`); the caller reads it from stored settings, never this module.
 */
export function checkModelCompatibility(
  input: ModelCheckInput,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemAvailableBytes: number,
  kvCacheFreeGpuMemoryFraction: number
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
  const reserveBytes = kvCacheReserveBytes(weightBytesTotal, kvCacheFreeGpuMemoryFraction)
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
