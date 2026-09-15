/**
 * KV-cache size estimate from GGUF metadata. Port of `gguf/utils.rs`
 * (`kv_cache_bits_per_element`, `estimate_kv_cache_internal`). Error strings are the Rust
 * `Display` texts, which the app receives verbatim.
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
  const headCountKv = u64(meta, `${arch}.attention.head_count_kv`)
  const nHead = headCountKv !== undefined && headCountKv > 0 ? headCountKv : (headCount ?? 0)
  if (nHead === 0) throw new KvCacheError(KV_CACHE_ERRORS.headCountInvalid)

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
    nLayer * nHead * (keyLen * kvCacheBitsPerElement(cacheTypeK) + valLen * kvCacheBitsPerElement(cacheTypeV))
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
