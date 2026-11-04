/**
 * KV-cache size estimate from GGUF metadata. Port of `gguf/utils.rs`
 * (`kv_cache_bits_per_element`, `estimate_kv_cache_internal`). Error strings are the Rust
 * `Display` texts, which the app receives verbatim.
 *
 * Beyond the port: a per-layer `head_count_kv` array (`[0, 0, 8, …]`, which `reader.ts` inlines at
 * any length) counts only the layers with KV heads, each with its own count, as llama.cpp allocates
 * them — a hybrid model's recurrent layers hold no KV cache. The Rust estimate cannot read the array
 * and counts every block with `head_count` heads (15 times LFM2.5-2.6B's real 16 KiB per token).
 *
 * Sliding-window models are counted layer by layer too, as llama.cpp b12019 allocates them
 * (`src/llama-kv-cache-iswa.cpp:73`): a global layer holds the whole window, a sliding layer only
 * `min(window, pad256(n_swa × sequences + n_ubatch))` cells. The Rust estimate averaged the two over
 * every layer, `(full + window) / 2`, which for Gemma 3 (five sliding layers to one global,
 * `src/models/gemma3.cpp:7`) counted two and a half times its real cache at 32K and narrowed small Macs
 * far more than they needed.
 */

import { parseRustU64 } from '../../util/index.js'

export interface KvCacheEstimate {
  size: number
  per_token_size: number
}

export class KvCacheError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KvCacheError'
  }
}

export const KV_CACHE_ERRORS = {
  architectureNotFound: 'Invalid metadata: architecture not found',
  blockCountInvalid: 'Invalid metadata: block_count not found or invalid',
  headCountInvalid: 'Invalid metadata: head_count not found or invalid',
  embeddingLengthInvalid: 'Invalid metadata: embedding_length not found or invalid',
  contextLengthInvalid: 'Invalid metadata: context_length not found or invalid',
} as const

/**
 * Bits one KV element occupies under a llama.cpp `cache_type_*`. Block quants carry a scale per
 * 32 elements (hence the half bits); unknown or absent reads as fp16.
 */
export function kvCacheBitsPerElement(cacheType: string | undefined | null): number {
  switch (cacheType?.trim().toLowerCase()) {
    case 'f32':
      return 32
    case 'f16':
    case 'bf16':
      return 16
    case 'q8_0':
      return 8.5
    case 'q5_1':
      return 6
    case 'q5_0':
      return 5.5
    case 'q4_1':
      return 5
    case 'q4_0':
    case 'iq4_nl':
      return 4.5
    case 'turbo4':
      return 4
    case 'turbo3':
      return 3
    case 'turbo2':
      return 2
    default:
      return 16
  }
}

const u64 = (meta: Record<string, string>, key: string): number | undefined => {
  const raw = meta[key]
  return raw === undefined ? undefined : parseRustU64(raw)
}

/**
 * The KV heads of each layer from an inline integer array, or `undefined` for anything else: a
 * scalar, the reader's placeholder, a malformed list, or one in which no layer has a KV head.
 */
function perLayerKvHeads(raw: string | undefined): number[] | undefined {
  const text = raw?.trim()
  if (!text || !text.startsWith('[') || !text.endsWith(']')) return undefined
  const inner = text.slice(1, -1).trim()
  if (inner === '') return undefined
  const heads: number[] = []
  for (const part of inner.split(',')) {
    const n = parseRustU64(part.trim())
    if (n === undefined) return undefined
    heads.push(n)
  }
  return heads.some((n) => n > 0) ? heads : undefined
}

/** How the cache is shared: llama.cpp sizes a sliding layer per sequence and per micro-batch. */
export interface KvCacheLayout {
  /**
   * Sequences sharing one unified cache (`--parallel` under `-kvu`): a sliding layer keeps a window
   * for each of them (`n_swa × n_seq_max`, `src/llama-kv-cache-iswa.cpp:73`). Default 1.
   */
  nSeq?: number
  /** `--ubatch-size`: a sliding layer also holds one micro-batch beyond its window. Default 512. */
  nUbatch?: number
}

/** llama.cpp's own `--ubatch-size` default (`common/common.h`, `n_ubatch = 512`). */
export const LLAMA_DEFAULT_UBATCH = 512

/** llama.cpp pads every KV cache size to 256 cells (`src/llama-context.cpp:388`, `iswa.cpp:73`). */
const KV_PAD = 256

/**
 * The sliding-window layer pattern llama.cpp b12019 hard-codes per architecture when the GGUF does
 * not carry `<arch>.attention.sliding_window_pattern` (`load_swa_pattern(ml, n[, dense_first])` in
 * `src/models/<arch>.cpp`): `n` is the period, the last layer of each period (the first with
 * `denseFirst`) attends globally.
 */
const ARCH_SWA_PATTERN: Readonly<Record<string, { period: number; denseFirst?: boolean }>> = {
  'gemma2': { period: 2 },
  'gemma3': { period: 6 },
  'gemma3n': { period: 5 },
  'cohere2': { period: 4 },
  'gpt-oss': { period: 2 },
  'exaone4': { period: 4 },
  'afmoe': { period: 4 },
  'smallthinker': { period: 4, denseFirst: true },
}

/**
 * Gemma 3n keeps KV only for its first 20 layers, the rest reuse them (`src/models/gemma3n.cpp:7`);
 * other models say how many trailing layers share in `<arch>.attention.shared_kv_layers` (Gemma 4).
 */
const ARCH_KV_LAYERS_FROM_START: Readonly<Record<string, number>> = { gemma3n: 20 }

/** `llama_hparams::set_swa_pattern` (`src/llama-hparams.cpp:8`). */
function periodicSwa(period: number, denseFirst: boolean): (il: number) => boolean {
  if (period === 0) return () => true
  return denseFirst ? (il) => il % period !== 0 : (il) => il % period < period - 1
}

/** A `[true, false, …]` array as the reader inlines it, or `undefined`. */
function perLayerFlags(raw: string | undefined): boolean[] | undefined {
  const text = raw?.trim()
  if (!text || !text.startsWith('[') || !text.endsWith(']')) return undefined
  const parts = text
    .slice(1, -1)
    .split(',')
    .map((p) => p.trim())
  if (parts.length === 0 || parts.some((p) => p !== 'true' && p !== 'false')) return undefined
  return parts.map((p) => p === 'true')
}

/**
 * Which layers keep only a sliding window: the GGUF's own per-layer flags or period, else the
 * architecture's built-in pattern. `undefined` — every layer at the full window, the safe side — for a
 * model without a window, and for an architecture whose pattern this table does not know.
 */
function slidingLayers(meta: Record<string, string>, arch: string): ((il: number) => boolean) | undefined {
  const raw = meta[`${arch}.attention.sliding_window_pattern`]
  const flags = perLayerFlags(raw)
  if (flags) return (il) => flags[il] === true
  const period = raw === undefined ? undefined : parseRustU64(raw)
  if (period !== undefined) return periodicSwa(period, false)
  const known = ARCH_SWA_PATTERN[arch]
  return known ? periodicSwa(known.period, known.denseFirst === true) : undefined
}

export function estimateKvCache(
  meta: Record<string, string>,
  ctxSize: number | undefined,
  cacheTypeK?: string | null,
  cacheTypeV?: string | null,
  layout: KvCacheLayout = {}
): KvCacheEstimate {
  const arch = meta['general.architecture']
  if (arch === undefined) throw new KvCacheError(KV_CACHE_ERRORS.architectureNotFound)

  const nLayer = u64(meta, `${arch}.block_count`)
  if (nLayer === undefined || nLayer <= 0) throw new KvCacheError(KV_CACHE_ERRORS.blockCountInvalid)

  const headCount = u64(meta, `${arch}.attention.head_count`)
  const layerKvHeads = perLayerKvHeads(meta[`${arch}.attention.head_count_kv`])
  const headCountKv = u64(meta, `${arch}.attention.head_count_kv`)
  const nHead = layerKvHeads
    ? Math.max(...layerKvHeads)
    : headCountKv !== undefined && headCountKv > 0
      ? headCountKv
      : (headCount ?? 0)
  if (nHead === 0) throw new KvCacheError(KV_CACHE_ERRORS.headCountInvalid)
  /** KV heads summed over the layers: `block_count × heads` for a scalar, the array's sum per layer. */
  const kvHeadsAcrossLayers = layerKvHeads ? layerKvHeads.reduce((a, b) => a + b, 0) : nLayer * nHead

  let keyLen = u64(meta, `${arch}.attention.key_length`) ?? 0
  let valLen = u64(meta, `${arch}.attention.value_length`) ?? 0
  if (keyLen === 0 || valLen === 0) {
    const embLen = u64(meta, `${arch}.embedding_length`) ?? 0
    if (embLen > 0 && nHead > 0) {
      const totalHeads = headCount ?? nHead
      const headDim = Math.floor(embLen / totalHeads)
      keyLen = headDim
      valLen = headDim
    }
  }
  if (keyLen === 0 || valLen === 0) throw new KvCacheError(KV_CACHE_ERRORS.embeddingLengthInvalid)

  const maxCtx = u64(meta, `${arch}.context_length`)
  if (maxCtx === undefined || maxCtx <= 0) throw new KvCacheError(KV_CACHE_ERRORS.contextLengthInvalid)
  const ctxLen = ctxSize === undefined ? maxCtx : Math.min(ctxSize, maxCtx)

  const slidingWindowRaw = u64(meta, `${arch}.attention.sliding_window`)
  const slidingWindow = slidingWindowRaw !== undefined && slidingWindowRaw > 0 ? slidingWindowRaw : undefined
  const isSliding = slidingWindow === undefined ? undefined : slidingLayers(meta, arch)

  const bitsK = kvCacheBitsPerElement(cacheTypeK)
  const bitsV = kvCacheBitsPerElement(cacheTypeV)
  if (slidingWindow === undefined || isSliding === undefined) {
    const kvPerToken = Math.ceil((kvHeadsAcrossLayers * (keyLen * bitsK + valLen * bitsV)) / 8)
    return { size: ctxLen * kvPerToken, per_token_size: kvPerToken }
  }

  // Layer by layer: the global ones hold the whole window, the sliding ones their own (possibly
  // narrower) heads over `swaCells`, and the layers that reuse another's KV hold nothing.
  const keyLenSwa = u64(meta, `${arch}.attention.key_length_swa`) || keyLen
  const valLenSwa = u64(meta, `${arch}.attention.value_length_swa`) || valLen
  const shared = u64(meta, `${arch}.attention.shared_kv_layers`)
  const kvFromStart = ARCH_KV_LAYERS_FROM_START[arch] ?? (shared ? nLayer - shared : undefined)
  const layers = layerKvHeads ?? Array.from({ length: nLayer }, () => nHead)
  let fullBits = 0
  let swaBits = 0
  layers.forEach((heads, il) => {
    if (heads === 0 || (kvFromStart !== undefined && il >= kvFromStart)) return
    if (isSliding(il)) swaBits += heads * (keyLenSwa * bitsK + valLenSwa * bitsV)
    else fullBits += heads * (keyLen * bitsK + valLen * bitsV)
  })
  const nSeq = Math.max(1, Math.floor(layout.nSeq ?? 1))
  const nUbatch = Math.max(1, Math.floor(layout.nUbatch ?? LLAMA_DEFAULT_UBATCH))
  const swaCells = Math.min(ctxLen, Math.ceil((slidingWindow * nSeq + nUbatch) / KV_PAD) * KV_PAD)
  const size = ctxLen * Math.ceil(fullBits / 8) + swaCells * Math.ceil(swaBits / 8)
  return { size, per_token_size: Math.ceil((fullBits + swaBits) / 8) }
}

/** `{arch}.context_length` when present and positive — the model's trained context. */
export function ggufContextLength(meta: Record<string, string>): number | undefined {
  const arch = meta['general.architecture']
  if (arch === undefined) return undefined
  const v = u64(meta, `${arch}.context_length`)
  return v !== undefined && v > 0 ? v : undefined
}
