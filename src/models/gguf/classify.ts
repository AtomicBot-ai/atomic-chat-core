/**
 * Metadata-driven classification of a GGUF: embedding vs text, projector modality, embedded MTP
 * head, effective context. Verbatim port of the relevant helpers in
 * `extensions/llamacpp-upstream-extension/src/util.ts`.
 */

type Meta = Record<string, unknown> | undefined | null

/**
 * `general.architecture` values whose llama.cpp graph builds the embedded MTP head
 * (`LLM_GRAPH_TYPE_DECODER_MTP` in `src/models/*.cpp`), as of upstream b10809 (5266f24da).
 * A GGUF still needs `{arch}.nextn_predict_layers` > 0: most conversions strip the head.
 */
const EMBEDDED_MTP_ARCHITECTURES = new Set([
  'bailingmoe3',
  'cohere2moe',
  'deepseek2',
  'deepseek32',
  'deepseek4',
  'glm-dsa',
  'glm4moe',
  'hy_v3',
  'mimo2',
  'nemotron_h_moe',
  'qwen35',
  'qwen35moe',
  'qwen3next',
  'step35',
])

/** True iff the load-error text is an MTP rejection (llama.cpp has no structured code for it). */
export function matchesMtpLoadFailure(text: string): boolean {
  if (!text) return false
  return (
    /failed to create MTP context/i.test(text) ||
    /context type MTP requested/i.test(text) ||
    /doesn'?t contain MTP layers/i.test(text)
  )
}

/** A GGUF whose MTP head is embedded (`{arch}.nextn_predict_layers` > 0). */
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

/** Architectures that are decision models by themselves (the Laya family: an mmBERT encoder with a marker head). */
export const DECISION_GGUF_ARCHITECTURES = new Set(['laya'])

/**
 * A decision model: served by `llama-server --decision` in the decision module, never as a chat or
 * embedding session. Either the architecture is one (`laya`) or the file is stamped with a decision
 * spec (`decision.layout`, the mirror key of `decision.spec`, which any architecture can carry: an
 * Arbiter or JevK5 GGUF stays `qwen35` underneath). Checked before `isEmbeddingGguf`, which it
 * excludes: `laya` is deliberately not in `NON_TEXT_GGUF_ARCHITECTURES`, because that would load it
 * with `--embedding --pooling mean`.
 */
export function isDecisionGguf(metadata: Meta): boolean {
  if (!metadata) return false
  const raw = metadata['general.architecture']
  const arch = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (DECISION_GGUF_ARCHITECTURES.has(arch)) return true
  const layout = metadata['decision.layout']
  return typeof layout === 'string' ? layout.trim() !== '' : layout !== undefined && layout !== null
}

/**
 * The files a laya Hugging Face checkpoint folder needs before the engine can convert it
 * (`DECISION.md`, "Loading a Hugging Face checkpoint directly"), relative and `/`-separated.
 * `rl_agent_config.json` is what tells the folder apart from any other model.
 */
export const DECISION_CHECKPOINT_FILES = [
  'rl_agent_config.json',
  'encoder/config.json',
  'tokenizer/tokenizer.json',
  'model.safetensors',
] as const

/** Which of `DECISION_CHECKPOINT_FILES` a folder lacks, given the relative paths it has. */
export function missingDecisionCheckpointFiles(present: ReadonlySet<string>): string[] {
  return DECISION_CHECKPOINT_FILES.filter((file) => !present.has(file))
}

/** Weights that produce embeddings rather than text (load in embedding mode instead). */
export function isEmbeddingGguf(metadata: Meta): boolean {
  const raw = metadata?.['general.architecture']
  const arch = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!arch) return false
  if (isDecisionGguf(metadata)) return false
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
