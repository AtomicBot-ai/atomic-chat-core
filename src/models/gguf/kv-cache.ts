/**
 * KV-cache size estimate from GGUF metadata. Port of `gguf/utils.rs`
 * (`kv_cache_bits_per_element`, `estimate_kv_cache_internal`). Error strings are the Rust
 * `Display` texts, which the app receives verbatim.
 *
 * Beyond the port: a per-layer `head_count_kv` array (`[0, 0, 8, …]`, which `reader.ts` inlines at
 * any length) counts only the layers with KV heads, each with its own count, as llama.cpp allocates
 * them — a hybrid model's recurrent layers hold no KV cache. The Rust estimate cannot read the array
 * and counts every block with `head_count` heads (15 times LFM2.5-2.6B's real 16 KiB per token).
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

export function estimateKvCache(
  meta: Record<string, string>,
  ctxSize: number | undefined,
  cacheTypeK?: string | null,
  cacheTypeV?: string | null
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

  const bitsPerToken =
    kvHeadsAcrossLayers *
    (keyLen * kvCacheBitsPerElement(cacheTypeK) + valLen * kvCacheBitsPerElement(cacheTypeV))
  const kvPerToken = Math.ceil(bitsPerToken / 8)
  const fullCost = ctxLen * kvPerToken
  const size =
    slidingWindow === undefined ? fullCost : Math.floor((fullCost + slidingWindow * kvPerToken) / 2)
  return { size, per_token_size: kvPerToken }
}

/** `{arch}.context_length` when present and positive — the model's trained context. */
export function ggufContextLength(meta: Record<string, string>): number | undefined {
  const arch = meta['general.architecture']
  if (arch === undefined) return undefined
  const v = u64(meta, `${arch}.context_length`)
  return v !== undefined && v > 0 ? v : undefined
}
