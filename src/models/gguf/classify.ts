/**
 * Metadata-driven classification of a GGUF: embedding vs text, projector modality, embedded MTP
 * head, effective context. Verbatim port of the relevant helpers in
 * `extensions/llamacpp-upstream-extension/src/util.ts`.
 */

type Meta = Record<string, unknown> | undefined | null

const EMBEDDED_MTP_ARCHITECTURES = new Set(['qwen35', 'qwen35moe'])

/** True iff the load-error text is an MTP rejection (llama.cpp has no structured code for it). */
export function matchesMtpLoadFailure(text: string): boolean {
  if (!text) return false
  return (
    /failed to create MTP context/i.test(text) ||
    /context type MTP requested/i.test(text) ||
    /doesn'?t contain MTP layers/i.test(text)
  )
}

/** A combined Qwen GGUF whose MTP head is embedded (`{arch}.nextn_predict_layers` > 0). */
export function hasEmbeddedMtp(metadata: Meta): boolean {
  if (!metadata) return false
  const architecture = metadata['general.architecture']
  if (typeof architecture !== 'string' || !EMBEDDED_MTP_ARCHITECTURES.has(architecture)) return false
  const blockCount = Number(metadata[`${architecture}.block_count`])
  const nextn = Number(metadata[`${architecture}.nextn_predict_layers`])
  return Number.isInteger(blockCount) && Number.isInteger(nextn) && nextn > 0 && blockCount > nextn
}

export function isMtpCapable(metadata: Meta, mtpDraftPath: string): boolean {
  return mtpDraftPath.length > 0 || hasEmbeddedMtp(metadata)
}

/** Architectures that cannot generate text; started as a chat model they crash the server. */
export const NON_TEXT_GGUF_ARCHITECTURES = new Set([
  'bert',
  'modern-bert',
  'nomic-bert',
  'nomic-bert-moe',
  'neo-bert',
  'jina-bert-v2',
  'jina-bert-v3',
  'eurobert',
  'gemma-embedding',
  'llama-embed',
  't5encoder',
])

/** Weights that produce embeddings rather than text (load in embedding mode instead). */
export function isEmbeddingGguf(metadata: Meta): boolean {
  const raw = metadata?.['general.architecture']
  const arch = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!arch) return false
  if (NON_TEXT_GGUF_ARCHITECTURES.has(arch)) return true
  // Embedding/reranker conversions of a generative arch keep the arch name; a pooling type other
  // than 0 (NONE) or a classifier head gives them away.
  const pooling = metadata?.[`${arch}.pooling_type`]
  const poolingStr = pooling == null ? '' : String(pooling).trim()
  if (poolingStr !== '' && poolingStr !== '0') return true
  return metadata?.[`${arch}.classifier.output_labels`] !== undefined
}

/**
 * The context to request: clamp to the trained maximum when known (llama.cpp aborts past it),
 * otherwise pass the request through.
 */
export function effectiveCtxSize(
  requested: number | undefined,
  maxCtxTrain: number | undefined
): number | undefined {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return requested
  if (typeof maxCtxTrain !== 'number' || !Number.isFinite(maxCtxTrain)) return requested
  if (maxCtxTrain <= 0) return requested
  return Math.min(requested, maxCtxTrain)
}

/**
 * Which modality an mmproj carries. `general.architecture` is `clip` for every projector; the
 * modality lives in the `clip.*` keys. Unknown metadata falls back to vision.
 */
export function classifyProjector(metadata: Meta): { vision: boolean; audio: boolean } {
  if (!metadata) return { vision: true, audio: false }
  const truthy = (v: unknown) =>
    String(v ?? '')
      .trim()
      .toLowerCase() === 'true'
  const present = (v: unknown) => v !== undefined && v !== null && String(v).trim() !== ''
  const vision =
    truthy(metadata['clip.has_vision_encoder']) || present(metadata['clip.vision.projector_type'])
  const audio = truthy(metadata['clip.has_audio_encoder']) || present(metadata['clip.audio.projector_type'])
  if (!vision && !audio) return { vision: true, audio: false }
  return { vision, audio }
}
