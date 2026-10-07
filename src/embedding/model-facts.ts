/**
 * What an embedding GGUF says about how to run it, read from its header before a start: whether it is
 * an embedding model at all, its pooling, its trained context, and the oldest upstream build that
 * runs it. Pure but for `readEmbeddingModelFacts`.
 *
 * The build floors (ggml-org/llama.cpp, by the merge of each change):
 *  - b11240: typed `content` parts (`image_url`, `input_audio`) in `/v1/embeddings` (#29556), which a
 *    model with a projector needs to be given anything but text;
 *  - b11454: the `gemma-embedding2` architecture, EmbeddingGemma 2 (#30054). b11452 and b11453 were
 *    never released.
 */

import { isDecisionGguf, isEmbeddingGguf, readGgufMetadataFromFile } from '../models/index.js'
import type { EmbeddingPooling } from '../contracts/index.js'

/** `-c` when the settings leave it to the core: a long passage, an image or half a minute of audio. */
export const EMBEDDING_DEFAULT_CTX = 2048
/** The first upstream build with typed `content` parts in `/v1/embeddings`. */
export const EMBEDDING_CONTENT_PARTS_MIN_BUILD = 11240
/** The first upstream build that runs EmbeddingGemma 2. */
export const EMBEDDING_GEMMA2_MIN_BUILD = 11454

/** Architectures newer than the oldest upstream build the core may find, by the build that added them. */
const ARCH_MIN_BUILD: Readonly<Record<string, number>> = {
  'gemma-embedding2': EMBEDDING_GEMMA2_MIN_BUILD,
}

/** `<arch>.pooling_type` as llama.cpp numbers it. */
const POOLING_NAMES: Readonly<Record<string, 'none' | EmbeddingPooling | 'rank'>> = {
  '0': 'none',
  '1': 'mean',
  '2': 'cls',
  '3': 'last',
  '4': 'rank',
}

export interface EmbeddingModelFacts {
  /** `general.architecture`, lower case; `''` when the header has none. */
  arch: string
  /** The header says embeddings (`isEmbeddingGguf`), not text, a decision or nothing. */
  embedding: boolean
  /** A decision model: it runs in the decision module, never here. */
  decision: boolean
  /** `<arch>.pooling_type`; `undefined` when the header has none. `rank` is a reranker. */
  pooling?: 'none' | EmbeddingPooling | 'rank'
  /** `<arch>.context_length`, when the file has one. */
  contextTrain?: number
}

/** The facts from parsed metadata (string values, as the GGUF reader returns them). Pure. */
export function embeddingFactsOf(metadata: Record<string, unknown> | undefined): EmbeddingModelFacts {
  const meta = (metadata ?? {}) as Record<string, string>
  const arch = String(meta['general.architecture'] ?? '')
    .trim()
    .toLowerCase()
  const pooling = POOLING_NAMES[String(meta[`${arch}.pooling_type`] ?? '').trim()]
  const context = Number(meta[`${arch}.context_length`])
  return {
    arch,
    embedding: isEmbeddingGguf(meta),
    decision: isDecisionGguf(meta),
    ...(pooling !== undefined ? { pooling } : {}),
    ...(Number.isInteger(context) && context > 0 ? { contextTrain: context } : {}),
  }
}

/** The facts of a GGUF file; `undefined` when its header cannot be read. */
export async function readEmbeddingModelFacts(
  path: string,
  read: (path: string) => Promise<{ metadata: Record<string, unknown> }> = readGgufMetadataFromFile
): Promise<EmbeddingModelFacts | undefined> {
  const parsed = await read(path).catch(() => undefined)
  return parsed ? embeddingFactsOf(parsed.metadata) : undefined
}

/**
 * Why the file cannot run as an embedding model, or `undefined` when it can. A reranker (pooling
 * `rank`) answers scores, not vectors, and `/v1/embeddings` refuses it.
 */
export function notAnEmbeddingModel(facts: EmbeddingModelFacts): string | undefined {
  if (facts.decision) return 'It is a decision model; turn it on as a decision model instead.'
  if (facts.pooling === 'rank') return 'It is a reranker, which answers scores rather than vectors.'
  if (!facts.embedding) return 'It is a text generation model, not an embedding model.'
  return undefined
}

/** The oldest upstream build that serves the model; 0 when any build does. */
export function embeddingMinBuild(arch: string, projector: boolean): number {
  return Math.max(ARCH_MIN_BUILD[arch] ?? 0, projector ? EMBEDDING_CONTENT_PARTS_MIN_BUILD : 0)
}

/** `-c`: the setting when given, else the default, never past the trained context. */
export function embeddingCtxSize(setting: number, contextTrain: number | undefined): number {
  const wanted = Number.isInteger(setting) && setting > 0 ? setting : EMBEDDING_DEFAULT_CTX
  return contextTrain !== undefined && contextTrain > 0 ? Math.min(wanted, contextTrain) : wanted
}

/**
 * `--pooling`: the setting when given; else nothing, so the server reads the GGUF's own, unless the
 * file names none at all (an old conversion), where `/v1/embeddings` would refuse every request:
 * then `mean`, which is what such sentence-transformer models were trained with.
 */
export function embeddingPooling(
  setting: '' | EmbeddingPooling,
  facts: Pick<EmbeddingModelFacts, 'pooling'>
): EmbeddingPooling | undefined {
  if (setting !== '') return setting
  return facts.pooling === undefined || facts.pooling === 'none' ? 'mean' : undefined
}
