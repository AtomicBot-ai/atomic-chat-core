/**
 * The compatibility check every managed engine shares (change `add-vllm-runtime`, design D7; spec
 * `managed-model-store`, "Проверка совместимости одинакова по форме для всех managed-движков"):
 * whether a Hugging Face checkpoint can run on one engine on this host, computed entirely from what
 * the caller already has — `config.json`, `hf_quant_config.json` when the repository carries one, the
 * revision's file listing, that engine's pinned `RuntimeDescriptor`, the host's `GpuFacts[]` and its
 * `MemAvailable`/`MemTotal` (`HostMemory`) — before a single byte of the checkpoint is downloaded.
 *
 * The skeleton is the same for every engine; two things are the engine's own, passed in as a
 * `ManagedCheckEngine`: `memoryNeed`, what the checkpoint needs on a card by that engine's own
 * memory rule (TensorRT-LLM: its KV reserve divided by the free-memory fraction plus its runtime and
 * activations; vLLM: weights plus KV in bytes plus its overhead), and `checkpointProblems`, shapes of
 * a supported architecture the engine's loader cannot read. The engine's descriptor decides the rest:
 * its architectures and its format matrix. Neither the hooks nor the adapter are the same thing — the
 * check runs with no Docker and no load lifecycle at all.
 *
 * This is the pure verdict only: it never touches the network or the filesystem. `selectLaunchGpu` is
 * exported on its own because a load picks the same card the same way.
 *
 * Check order: GGUF is rejected outright before anything else (spec: "for GGUF there is
 * llama.cpp"), then a curated match's `inventory_digest` is verified — an integrity gate that is
 * independent of whether the checkpoint would otherwise load, so a tampered curated listing is
 * reported as `MANAGED_METADATA_INVALID` rather than whatever compatibility error the tampered
 * files happen to also trigger. Only then: quantization format recognised by the shared naming rule,
 * architecture supported, the engine's checkpoint problems, format present in this descriptor's own
 * matrix, the file listing has at least one weight file, the format's compute-capability rule
 * (minimum and exclusion list) — everything above is genuinely static, true or false regardless of
 * what else is running on the host — and finally the engine's memory need against the selected
 * card's free memory.
 *
 * `checkCheckpoint` runs every check as one call, for the check route's single live snapshot. The
 * load path cannot: a pre-launch check runs before the previous session on the very same card is
 * stopped, so reading that card's free memory then would refuse a same-card model switch outright.
 * `checkCheckpointFiles` is every check above the memory line, and `checkCheckpointMemory` is the
 * memory line alone, so a load can run the first before stopping the previous session and the second
 * after it, against a freshly re-probed card.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { GpuFacts, ModelCompatibility, RuntimeDescriptor } from '../../contracts/index.js'
import { inventoryDigest } from '../environment/index.js'
import {
  describeUnrecognizedQuantization,
  isGgufCheckpoint,
  kvCacheQuantAlgo,
  MIXED_PRECISION,
  quantizationComponents,
  quantizationFormat,
} from './quant-format.js'
import type { JsonObject } from './quant-format.js'

/** One file of the revision's listing, as the route contract carries it (spec `managed-model-store`). */
export interface CheckpointFile {
  /** Repository-relative, forward slashes, as Hugging Face spells it. */
  path: string
  size: number
  /** The repository's own published digest, or `null` when it has none (a non-LFS file). */
  sha256: string | null
}

/** Input to `checkCheckpoint`, matching what `POST /models/:provider/check` accepts. */
export interface ModelCheckInput {
  repository: string
  revision: string
  config_json: JsonObject
  /** `null` when the repository does not carry the file at all. */
  hf_quant_config_json: JsonObject | null
  files: CheckpointFile[]
  /** Omitted or not found on this host falls back to `selectLaunchGpu`'s "most free memory" rule. */
  gpu_id?: string
  /**
   * The checkpoint's tensor names, read from the headers of its weight `.safetensors` files (never
   * from `model.safetensors.index.json`, which can be stale or another model's), with numeric path
   * segments optionally folded to `*` (`normalizeWeightName`). Omitted when the caller could not
   * read the headers or predates the field: the checks that need tensor names are then skipped,
   * never failed.
   */
  weight_names?: string[]
}

/**
 * `model.layers.12.mlp.experts.7.w1.weight` → `model.layers.*.mlp.experts.*.w1.weight`: a large MoE
 * index (DeepSeek-V3: ~90k names) folds to a few hundred, and no shape check here looks at indices.
 */
export function normalizeWeightName(name: string): string {
  return name.replace(/(?<=^|\.)\d+(?=\.|$)/g, '*')
}

/** Folded and de-duplicated tensor names, in a stable order. */
export function normalizeWeightNames(names: Iterable<string>): string[] {
  return [...new Set([...names].map(normalizeWeightName))].sort()
}

/** A safetensors header larger than this is not a header this core reads (real ones are KB to a few MB). */
const MAX_SAFETENSORS_HEADER_BYTES = 100 * 1024 * 1024

/** The header length a `.safetensors` file's first 8 bytes declare (little-endian u64); `undefined` if implausible. */
export function safetensorsHeaderLength(prefix: Uint8Array): number | undefined {
  if (prefix.length < 8) return undefined
  const length = new DataView(prefix.buffer, prefix.byteOffset, 8).getBigUint64(0, true)
  return length > 0n && length <= BigInt(MAX_SAFETENSORS_HEADER_BYTES) ? Number(length) : undefined
}

/** The tensor names a parsed safetensors header lists (its keys, minus `__metadata__`); `undefined` if it is not an object. */
export function safetensorsTensorNames(header: unknown): string[] | undefined {
  if (header === null || typeof header !== 'object' || Array.isArray(header)) return undefined
  return Object.keys(header).filter((key) => key !== '__metadata__')
}

/**
 * Architectures whose MoE layers TensorRT-LLM builds with `DeepseekV3Gate`, which refuses to load
 * without an `e_score_correction_bias` tensor next to the router weight (TensorRT-LLM v1.3.0rc29,
 * `_torch/models/modeling_deepseekv3.py` `DeepseekV3Gate.load_weights`; `modeling_glm.py` builds
 * `Glm4Moe` with the same gate). `NemotronH*` also uses the gate, but only in its MoE layers, and a
 * dense Nemotron-H has none, so it is not listed: a rule here must never refuse a model that loads.
 */
/**
 * The host's own memory, from `/proc/meminfo`: what a unified-memory card (design D13, GB10/DGX
 * Spark — `nvidia-smi` reports no memory of its own) has instead of VRAM. `availableBytes` is
 * `MemAvailable`, what such a card has free; `totalBytes` is `MemTotal`, its size. Either is `0`
 * when the file could not be read — the safe direction: a unified-memory card then under-reports.
 */
export interface HostMemory {
  availableBytes: number
  totalBytes: number
}

/**
 * The card a load runs on, and the card `POST /models/:provider/check` computes against when the
 * caller names none — one function for both, so a verdict and a launch can never be about different
 * cards (spec `tensorrt-llm-runtime` "Выбор карты и настройки провайдера", design D12b). `gpu_id`
 * when given and present on the host; otherwise the card with the most FREE memory right now, ties
 * broken by the most TOTAL memory, and a full tie by the order `nvidia-smi` lists the cards in (its
 * own index, stable on a host), so equal cards always resolve the same way. `null` only when the host
 * has no GPU at all.
 *
 * Free memory, not total: on a desktop with two equal cards the first is usually holding the
 * desktop and a browser, and "the biggest card" would send the model there to run out of memory
 * while the second card sits idle. Placement may therefore change between loads as the cards' load
 * changes; the engine cache is keyed by model, not by card, so that only moves where it runs.
 * Compute capability is deliberately not a filter here: the spec's rule is memory only, and a card
 * the checkpoint's format cannot run on gets an honest `MODEL_INCOMPATIBLE` naming the other cards
 * it would fit on (`fits_other_gpus`).
 *
 * A unified-memory card (`total_vram_bytes: null`) ranks by the host's memory — `MemAvailable` as
 * its free memory and `MemTotal` as its total — the same figure `freeMemoryBytes` compares its
 * memory need against.
 */
export function selectLaunchGpu(
  gpus: readonly GpuFacts[],
  host: HostMemory,
  gpuId?: string
): GpuFacts | null {
  if (gpuId !== undefined) {
    const requested = gpus.find((gpu) => gpu.gpu_id === gpuId)
    if (requested !== undefined) return requested
  }
  if (gpus.length === 0) return null
  // Strictly greater only: on a full tie the earlier card stays, i.e. nvidia-smi's own order.
  const ranksAbove = (gpu: GpuFacts, best: GpuFacts): boolean => {
    const free = freeMemoryBytes(gpu, host) - freeMemoryBytes(best, host)
    return free !== 0 ? free > 0 : totalMemoryBytes(gpu, host) > totalMemoryBytes(best, host)
  }
  return gpus.reduce((best, gpu) => (ranksAbove(gpu, best) ? gpu : best))
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
 * The files that count as checkpoint weights. Root-level files only. Prefers the standard
 * `model[-NNNNN-of-MMMMM].safetensors` shard naming when present — which also excludes a
 * `consolidated*.safetensors` sitting next to it (Mistral's own releases ship both, covering the
 * exact same weights, for their own inference stack; counting both would double the checkpoint's
 * real size) — because that naming alone identifies the checkpoint's real weights unambiguously.
 * When no file matches that preferred naming, every other root-level `*.safetensors` file is
 * selected instead, `consolidated*` included: this is the *only* branch a `consolidated`-only
 * repository (no HF shard naming at all) ever reaches, so its `consolidated.safetensors` has to
 * count here. Only when there is no safetensors file at all does a legacy `*.bin`/`*.pth` checkpoint
 * count, so a checkpoint this engine cannot load (it only reads safetensors) still gets an honest,
 * non-zero total rather than a silent `0` that would let `checkModelCompatibilityFiles` report `ok`
 * on any card. No file matches any of these rules for an empty selection, which `weightBytes` turns
 * into `0` and `checkModelCompatibilityFiles` itself turns into `MODEL_INCOMPATIBLE`, never a false
 * `ok`.
 */
function selectWeightFiles(files: readonly CheckpointFile[]): readonly CheckpointFile[] {
  const preferredShards = files.filter((file) => isPreferredShard(file.path))
  if (preferredShards.length > 0) return preferredShards

  const anySafetensors = files.filter((file) => isAnySafetensors(file.path))
  if (anySafetensors.length > 0) return anySafetensors

  return files.filter((file) => isLegacyWeightFile(file.path))
}

/** The weight files whose safetensors headers hold the checkpoint's tensor names (legacy `.bin`/`.pth` excluded). */
export function weightSafetensorsFiles(files: readonly CheckpointFile[]): readonly CheckpointFile[] {
  return selectWeightFiles(files).filter((file) => file.path.toLowerCase().endsWith(SAFETENSORS_SUFFIX))
}

/** Weight bytes for the memory check: the sum of `selectWeightFiles(files)`. */
export function weightBytes(files: readonly CheckpointFile[]): number {
  return sumSizes(selectWeightFiles(files))
}

/**
 * A finite, positive number read from `configJson[key]`; `undefined` for anything else (missing,
 * the wrong type, zero, negative, `NaN`/`Infinity`) — every field the KV-cache formula below needs
 * is a strictly positive count or dimension, and treating `0` or a negative value as "present" would
 * size a KV cache of zero or negative bytes, silently passing a check that should have fallen back.
 */
export function positiveNumberField(configJson: JsonObject, key: string): number | undefined {
  const value = configJson[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

export interface KvCacheShape {
  numHiddenLayers: number
  numKeyValueHeads: number
  headDim: number
}

/**
 * The architecture fields a transformer's KV-cache size is computed from, with the two standard
 * fallbacks: `num_key_value_heads` falls back to `num_attention_heads` (plain multi-head attention —
 * every attention head is its own KV head, the GQA/MQA field simply absent) and `head_dim` falls
 * back to `hidden_size / num_attention_heads` (the standard derivation, for a config that does not
 * spell `head_dim` out explicitly). `undefined` when `config.json` lacks what even the fallbacks
 * need — `kvCacheBytes` then has nothing to compute from, and `kvCacheReserveBytes` falls back to
 * the older weight-proportional rule.
 */
export function readKvCacheShape(rootConfigJson: JsonObject): KvCacheShape | undefined {
  // A VLM-style config (Qwen3.5+, Gemma 4, Mistral 3) keeps the language model's shape on
  // `text_config`; the top level then has no `num_hidden_layers` at all.
  const textConfig = rootConfigJson.text_config
  const configJson =
    positiveNumberField(rootConfigJson, 'num_hidden_layers') === undefined &&
    typeof textConfig === 'object' &&
    textConfig !== null &&
    !Array.isArray(textConfig)
      ? (textConfig as JsonObject)
      : rootConfigJson
  const numHiddenLayers = attentionLayerCount(configJson)
  const numAttentionHeads = positiveNumberField(configJson, 'num_attention_heads')
  const numKeyValueHeads = positiveNumberField(configJson, 'num_key_value_heads') ?? numAttentionHeads
  const hiddenSize = positiveNumberField(configJson, 'hidden_size')
  const headDim =
    positiveNumberField(configJson, 'head_dim') ??
    (hiddenSize !== undefined && numAttentionHeads !== undefined ? hiddenSize / numAttentionHeads : undefined)
  if (numHiddenLayers === undefined || numKeyValueHeads === undefined || headDim === undefined) {
    return undefined
  }
  return { numHiddenLayers, numKeyValueHeads, headDim }
}

/**
 * Layers that keep a per-token KV cache. A hybrid config lists `layer_types`; its
 * `linear_attention` layers (Qwen3.5's Gated DeltaNet) hold a fixed-size state instead, so only the
 * rest count. Sliding-window layers still count in full, which over-reserves for them on purpose.
 */
function attentionLayerCount(configJson: JsonObject): number | undefined {
  const total = positiveNumberField(configJson, 'num_hidden_layers')
  const layerTypes = configJson.layer_types
  if (total === undefined || !Array.isArray(layerTypes) || layerTypes.length !== total) return total
  const attention = layerTypes.filter((type) => type !== 'linear_attention').length
  return attention > 0 ? attention : total
}

/**
 * The KV cache's own footprint for one sequence at `contextLength` tokens:
 * `2 × num_hidden_layers × num_key_value_heads × head_dim × kv_dtype_bytes × context_length` — one
 * K tensor and one V tensor (the leading `2`) per layer, each holding `context_length` tokens of
 * `num_key_value_heads × head_dim` values at `kv_dtype_bytes` each. `kv_dtype_bytes` is `1` when
 * `kvCacheQuantAlgo` names `FP8`, else `2` (`bf16`/`fp16`, this engine's other supported weight
 * dtypes). `undefined` when `config.json` lacks the architecture fields `readKvCacheShape` needs.
 */
export function kvCacheBytes(
  configJson: JsonObject,
  hfQuantConfigJson: JsonObject | null,
  contextLength: number
): number | undefined {
  const shape = readKvCacheShape(configJson)
  if (shape === undefined) return undefined
  const kvDtypeBytes = kvCacheQuantAlgo(configJson, hfQuantConfigJson)?.toUpperCase() === 'FP8' ? 1 : 2
  return 2 * shape.numHiddenLayers * shape.numKeyValueHeads * shape.headDim * kvDtypeBytes * contextLength
}

/** A card with no VRAM figure of its own (GB10/DGX Spark, design D13): its memory is the host's. */
export function isUnifiedMemory(gpu: GpuFacts): boolean {
  return gpu.total_vram_bytes === null
}

/** Free memory to compare against for one card: `MemAvailable` for a unified-memory card (design D13). */
export function freeMemoryBytes(gpu: GpuFacts, host: HostMemory): number {
  return isUnifiedMemory(gpu) ? host.availableBytes : (gpu.free_vram_bytes ?? 0)
}

/** A card's size, for ranking only: `MemTotal` for a unified-memory card (design D13). */
export function totalMemoryBytes(gpu: GpuFacts, host: HostMemory): number {
  return isUnifiedMemory(gpu) ? host.totalBytes : (gpu.total_vram_bytes ?? 0)
}

/** How an engine sized a KV-cache reserve — carried into `ModelCompatibility.kv_reserve_basis`. */
export type KvReserveBasis = 'config' | 'weight_fraction'

/** The checkpoint as an engine's memory rule sees it. */
export interface CheckpointMemoryInputs {
  weightBytesTotal: number
  configJson: JsonObject
  hfQuantConfigJson: JsonObject | null
}

/** What a checkpoint needs on one card by an engine's own memory rule. */
export interface MemoryNeed {
  neededBytes: number
  /** How the engine sized its KV cache, when it says (`kv_reserve_basis` of the verdict). */
  kvReserveBasis?: KvReserveBasis
  /** `key=value` numbers for a refusal's `details`; the skeleton appends `free_bytes=…`. */
  details: string
}

/** A reason a supported architecture's checkpoint still cannot load on this engine. */
export interface CheckpointProblem {
  message: string
  details: string
}

/**
 * What one engine adds to the shared skeleton (design D7): its id for messages, its loader's
 * checkpoint quirks and its memory rule. Part of the engine's spec, never of its adapter.
 */
export interface ManagedCheckEngine {
  /** `tensorrt-llm`, `vllm`: the provider id, in messages. */
  engineId: string
  checkpointProblems(
    architecture: string,
    configJson: JsonObject,
    weightNames: readonly string[] | undefined
  ): CheckpointProblem | null
  memoryNeed(gpu: GpuFacts, checkpoint: CheckpointMemoryInputs, hostMemory: HostMemory): MemoryNeed
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

/** The compute-capability rule a checkpoint's format puts on a card. */
interface FormatRequirement {
  min_compute_capability: string
  excluded_compute_capabilities: string[]
}

type FormatResolution =
  | { ok: true; requirement: FormatRequirement }
  /** `missing` names the format the descriptor has no row for; `null` when a mixed checkpoint names none. */
  | { ok: false; missing: string | null }

/**
 * The descriptor's rule for `format`. A `mixed_precision` checkpoint needs every one of its per-layer
 * formats (`quantizationComponents`) to have a row, and a card has to clear all of them: the highest
 * minimum and every exclusion. Any per-layer format without a row fails the whole checkpoint closed.
 */
function formatRequirement(
  descriptor: RuntimeDescriptor,
  format: string,
  hfQuantConfigJson: JsonObject | null
): FormatResolution {
  const components = quantizationComponents(format, hfQuantConfigJson)
  if (components.length === 0) return { ok: false, missing: null }
  let minimum: string | undefined
  const excluded = new Set<string>()
  for (const component of components) {
    const row = descriptor.quantization.find((entry) => entry.format === component)
    if (row === undefined) return { ok: false, missing: component }
    if (minimum === undefined || compareComputeCapability(row.min_compute_capability, minimum) > 0) {
      minimum = row.min_compute_capability
    }
    for (const capability of row.excluded_compute_capabilities) excluded.add(capability)
  }
  return {
    ok: true,
    requirement: {
      min_compute_capability: minimum as string,
      excluded_compute_capabilities: [...excluded],
    },
  }
}

/** `mixed_precision (fp8 + nvfp4)` for a mixed checkpoint, the format itself otherwise. */
function formatLabel(format: string, hfQuantConfigJson: JsonObject | null): string {
  if (format !== MIXED_PRECISION) return format
  const components = quantizationComponents(format, hfQuantConfigJson)
  return components.length === 0 ? format : `${format} (${components.join(' + ')})`
}

/** Whether a checkpoint with `requirement` is loadable on `gpu`. */
function formatAllowedOnGpu(requirement: FormatRequirement, gpu: GpuFacts): boolean {
  if (!computeCapabilityAtLeast(gpu.compute_capability, requirement.min_compute_capability)) return false
  return !requirement.excluded_compute_capabilities.includes(gpu.compute_capability)
}

/**
 * Every other GPU (not `selected`) the checkpoint would fit on: architecture-independent, the
 * format's CC rule plus free memory, each card measured by its own kind of reserve (`needOn`).
 */
function fitsOtherGpus(
  gpus: readonly GpuFacts[],
  selected: GpuFacts,
  requirement: FormatRequirement | null,
  needOn: (gpu: GpuFacts) => number,
  hostMemory: HostMemory
): string[] {
  if (requirement === null) return []
  return gpus
    .filter((gpu) => gpu.gpu_id !== selected.gpu_id)
    .filter((gpu) => formatAllowedOnGpu(requirement, gpu))
    .filter((gpu) => needOn(gpu) <= freeMemoryBytes(gpu, hostMemory))
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
  fitsOther: string[],
  kvReserveBasis?: KvReserveBasis | undefined
): ModelCompatibility {
  return {
    architectures: context.architectures,
    quantization_format: context.quantizationFormat,
    weight_bytes: context.weightBytesTotal,
    checked_gpu_id: context.selected.gpu_id,
    curated: context.curated,
    unified_memory: isUnifiedMemory(context.selected),
    fits_other_gpus: fitsOther,
    ...(kvReserveBasis === undefined ? {} : { kv_reserve_basis: kvReserveBasis }),
    verdict,
  }
}

/**
 * Everything `checkCheckpointMemory` needs about the checkpoint once every non-memory check has passed.
 * `configJson`/`hfQuantConfigJson` travel here (rather than being re-passed alongside `sizing`)
 * because they are exactly `input.config_json`/`input.hf_quant_config_json` as
 * `checkCheckpointFiles` already read them — carrying its own copy here means
 * `checkCheckpointMemory` can never be called with a `config.json` that disagrees with the one the rest
 * of the verdict was computed from.
 */
export interface ResolvedCheckpoint {
  architectures: string[]
  /** Never null here: `checkCheckpointFiles` only returns this once a format was recognised. */
  quantizationFormat: string
  weightBytesTotal: number
  selected: GpuFacts
  curated: boolean
  configJson: JsonObject
  hfQuantConfigJson: JsonObject | null
}

export type FilesCheckResult =
  { ok: true; resolved: ResolvedCheckpoint } | { ok: false; verdict: ModelCompatibility }

/**
 * Throws `AtomicCoreError` for two caller-input problems that are never a fact about the checkpoint
 * itself: `INVALID_ARGUMENT` when the file listing names `hf_quant_config.json` while
 * `hf_quant_config_json` is `null` (the caller said the file exists but did not send its content, so
 * the format naming rule cannot be trusted), and `MANAGED_PREREQUISITE_BLOCKED` when the host has no
 * GPU at all (`gpus` empty — the same code, and the same host condition, `runtime.ts`'s own
 * `selectLaunchGpu` check already answers with for a real load; task 2.16w round 1, finding 11:
 * an absent or failing `nvidia-smi` is a missing prerequisite, not a malformed request).
 * `inventoryDigest` can also throw `AtomicCoreError('MANAGED_METADATA_INVALID', …)` for a curated
 * match whose file listing is itself malformed (an empty or repeated path, a NUL byte, a
 * non-integer size — see `src/runtime/environment/inventory.ts`), before this function gets a
 * chance to compare digests. Every other input, however incompatible, is a normal `verdict.ok: false`
 * answer, never a thrown error (design D12: the point of this check is to hand back numbers, not to
 * fail the request).
 *
 * Every check above the memory line: GGUF, the curated digest, the quantization format, the
 * architecture, the format's presence in this descriptor and its compute-capability rule. None of
 * these can change by evicting whatever session currently holds the selected card, so all of them
 * run before `stopPrevious` on the load path (task 2.16w round 1, finding 1). `fits_other_gpus` on a
 * compute-capability failure is still computed here (`memory` sizes the reserve needed to report it),
 * using whichever `gpus`/`hostMemory` snapshot the caller passed in — informational only,
 * about *other* cards the eviction race does not touch.
 */
export function checkCheckpointFiles(
  input: ModelCheckInput,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemory: HostMemory,
  engine: ManagedCheckEngine
): FilesCheckResult {
  if (
    input.files.some((file) => file.path === 'hf_quant_config.json') &&
    input.hf_quant_config_json === null
  ) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'The file listing includes hf_quant_config.json but hf_quant_config_json was not provided.'
    )
  }

  const selected = selectLaunchGpu(gpus, hostMemory, input.gpu_id)
  if (selected === null) {
    throw new AtomicCoreError(
      'MANAGED_PREREQUISITE_BLOCKED',
      `No NVIDIA GPU was found on this machine, so ${engine.engineId} compatibility cannot be checked.`
    )
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
      return {
        ok: false,
        verdict: buildCompatibility(
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
        ),
      }
    }
  }

  if (gguf) {
    return {
      ok: false,
      verdict: buildCompatibility(
        context,
        {
          ok: false,
          error: {
            code: 'MODEL_INCOMPATIBLE',
            message: `GGUF checkpoints are not supported by ${engine.engineId}; use the llama.cpp provider for GGUF.`,
          },
        },
        []
      ),
    }
  }

  if (format === null) {
    return {
      ok: false,
      verdict: buildCompatibility(
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
      ),
    }
  }

  const architecture = architectures.length > 0 ? architectures[0] : undefined
  if (architecture === undefined || !descriptor.supported_architectures.includes(architecture)) {
    return {
      ok: false,
      verdict: buildCompatibility(
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
      ),
    }
  }

  const shapeProblem = engine.checkpointProblems(architecture, input.config_json, input.weight_names)
  if (shapeProblem !== null) {
    return {
      ok: false,
      verdict: buildCompatibility(
        context,
        { ok: false, error: { code: 'MODEL_INCOMPATIBLE', ...shapeProblem } },
        []
      ),
    }
  }

  const resolution = formatRequirement(descriptor, format, input.hf_quant_config_json)
  if (!resolution.ok) {
    const missing = resolution.missing
    return {
      ok: false,
      verdict: buildCompatibility(
        context,
        {
          ok: false,
          error: {
            code: 'MODEL_INCOMPATIBLE',
            message:
              missing === null
                ? `Unsupported quantization format: "${format}" does not name the format of its layers.`
                : missing === format
                  ? `Unsupported quantization format: ${engine.engineId} does not support "${format}" (it is not part of this engine's descriptor).`
                  : `Unsupported quantization format: "${format}" has layers in "${missing}", which ${engine.engineId} does not support (it is not part of this engine's descriptor).`,
            details: missing ?? format,
          },
        },
        []
      ),
    }
  }
  const formatSupport = resolution.requirement
  const label = formatLabel(format, input.hf_quant_config_json)

  if (weightBytesTotal === 0) {
    return {
      ok: false,
      verdict: buildCompatibility(
        context,
        {
          ok: false,
          error: {
            code: 'MODEL_INCOMPATIBLE',
            message: 'No checkpoint weight files were found in the file listing.',
          },
        },
        []
      ),
    }
  }

  // Known from here on: architecture and format are both fine, so any card whose own CC clears
  // this format and has room is a real alternative — compute it once and reuse it in both CC-failure
  // branches below, so a caller whose selected card fails on CC still sees a card that would work
  // (spec: "report which other host cards it would fit").
  const checkpoint: CheckpointMemoryInputs = {
    weightBytesTotal,
    configJson: input.config_json,
    hfQuantConfigJson: input.hf_quant_config_json,
  }
  const needOn = (gpu: GpuFacts): MemoryNeed => engine.memoryNeed(gpu, checkpoint, hostMemory)
  const basis = needOn(selected).kvReserveBasis
  const fitsOther = fitsOtherGpus(gpus, selected, formatSupport, (gpu) => needOn(gpu).neededBytes, hostMemory)

  if (!computeCapabilityAtLeast(selected.compute_capability, formatSupport.min_compute_capability)) {
    return {
      ok: false,
      verdict: buildCompatibility(
        context,
        {
          ok: false,
          error: {
            code: 'MODEL_INCOMPATIBLE',
            message: `Format ${label} requires compute capability ${formatSupport.min_compute_capability} or newer.`,
            details: `required=${formatSupport.min_compute_capability} actual=${selected.compute_capability}`,
          },
        },
        fitsOther,
        basis
      ),
    }
  }

  if (formatSupport.excluded_compute_capabilities.includes(selected.compute_capability)) {
    return {
      ok: false,
      verdict: buildCompatibility(
        context,
        {
          ok: false,
          error: {
            code: 'MODEL_INCOMPATIBLE',
            message: `Format ${label} is not supported by this engine release on compute capability ${selected.compute_capability}.`,
            details: `format=${format} compute_capability=${selected.compute_capability}`,
          },
        },
        fitsOther,
        basis
      ),
    }
  }

  return {
    ok: true,
    resolved: {
      architectures,
      quantizationFormat: format,
      weightBytesTotal,
      selected,
      curated: context.curated,
      configJson: input.config_json,
      hfQuantConfigJson: input.hf_quant_config_json,
    },
  }
}

/**
 * The memory line alone (task 2.16w round 1, finding 1): whether `resolved.weightBytesTotal` plus
 * the KV-cache reserve fits the selected card's free memory. Callers pass a fresh `gpus`/
 * `hostMemory` snapshot — the load path's `beforeCreate` hook re-probes the host after
 * `stopPrevious` has run, so this sees whatever that freed, never a snapshot taken before it — and
 * this function re-reads the free-memory figure for `resolved.selected.gpu_id` from *that* fresh
 * `gpus`, rather than trusting `resolved.selected`'s own (possibly stale) copy: that stale copy is
 * only a fallback for the case `gpus` no longer lists the card at all (it disappeared), which
 * `runtime.ts`'s own `beforeCreate` hook checks for and reports as `MANAGED_PREREQUISITE_BLOCKED`
 * before ever calling this. This never picks a *different* card — the caller already committed to
 * this exact one (`checkModelCompatibilityFiles`, or a load's own `selectLaunchGpu`).
 */
export function checkCheckpointMemory(
  resolved: ResolvedCheckpoint,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemory: HostMemory,
  engine: ManagedCheckEngine
): ModelCompatibility {
  const selected = gpus.find((gpu) => gpu.gpu_id === resolved.selected.gpu_id) ?? resolved.selected
  const context: VerdictContext = {
    architectures: resolved.architectures,
    quantizationFormat: resolved.quantizationFormat,
    weightBytesTotal: resolved.weightBytesTotal,
    selected,
    curated: resolved.curated,
  }
  const checkpoint: CheckpointMemoryInputs = {
    weightBytesTotal: resolved.weightBytesTotal,
    configJson: resolved.configJson,
    hfQuantConfigJson: resolved.hfQuantConfigJson,
  }
  const needOn = (gpu: GpuFacts): MemoryNeed => engine.memoryNeed(gpu, checkpoint, hostMemory)
  const need = needOn(selected)
  const basis = need.kvReserveBasis
  const freeBytes = freeMemoryBytes(selected, hostMemory)
  const resolution = formatRequirement(descriptor, resolved.quantizationFormat, resolved.hfQuantConfigJson)
  const fitsOther = fitsOtherGpus(
    gpus,
    selected,
    resolution.ok ? resolution.requirement : null,
    (gpu) => needOn(gpu).neededBytes,
    hostMemory
  )

  if (need.neededBytes > freeBytes) {
    return buildCompatibility(
      context,
      {
        ok: false,
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message:
            'The checkpoint, the engine runtime memory and the KV-cache reserve do not fit the selected GPU.',
          details: `${need.details} free_bytes=${freeBytes}`,
        },
      },
      fitsOther,
      basis
    )
  }

  return buildCompatibility(context, { ok: true }, fitsOther, basis)
}

/**
 * The full verdict: `checkCheckpointFiles` then, if it passed, `checkCheckpointMemory` — for the check
 * route's single live snapshot, where there is no previous session on the selected card to evict
 * first. The load path runs the two separately instead (see the file banner).
 */
export function checkCheckpoint(
  input: ModelCheckInput,
  descriptor: RuntimeDescriptor,
  gpus: readonly GpuFacts[],
  hostMemory: HostMemory,
  engine: ManagedCheckEngine
): ModelCompatibility {
  const files = checkCheckpointFiles(input, descriptor, gpus, hostMemory, engine)
  if (!files.ok) return files.verdict
  return checkCheckpointMemory(files.resolved, descriptor, gpus, hostMemory, engine)
}
