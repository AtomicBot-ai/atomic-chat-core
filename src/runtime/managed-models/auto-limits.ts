/**
 * The automatic context length and parallel requests of a managed engine (vLLM, SGLang): what a load
 * runs with when the settings leave `context_length` or the request count at 0.
 *
 * They were fixed at 8192 tokens and one request (integrations audit 2026-11-03, S2): a coding
 * agent's first request is 13-27K tokens, so every agent prompt was refused with
 * `context_length_exceeded`, and the side requests an agent sends beside its turn (title,
 * classifier) waited behind it. Both engines keep one paged KV pool sized by their memory share,
 * not by these settings — the window only bounds a request and the count only how many run at once —
 * so the largest pair the engine's own memory rule passes on the card is chosen, preferring the
 * window: 64K with 2 requests, 32K with 2, 32K alone, 16K, then the old 8K, at which the memory
 * check refuses exactly as before.
 */
import type { JsonObject } from './quant-format.js'

/** The windows tried, widest first. 32K is the default the settings describe. */
export const MANAGED_AUTO_CONTEXTS = [65_536, 32_768, 16_384, 8_192] as const
/** The window settings without a memory plan read as (route limits before a load, capabilities). */
export const MANAGED_AUTO_CONTEXT_DEFAULT = 32_768
/** Requests at once when the memory rule passes; one otherwise. */
export const MANAGED_AUTO_SEQUENCES = 2

export interface AutoLimitsInput {
  contextAuto: boolean
  sequencesAuto: boolean
  /** The pinned window when not automatic. */
  context: number
  /** The pinned request count when not automatic. */
  sequences: number
  /** A window must leave room for the output cap. */
  maxOutputTokens: number
  /** The longest window the model takes (`checkpointMaxContext`); `undefined` when unknown. */
  trainedContext: number | undefined
  /** The engine's memory rule at this pair. */
  fits: (context: number, sequences: number) => boolean
}

/** The candidate pairs in order of preference; the last is used when none fits. */
export function autoLimitCandidates(input: Omit<AutoLimitsInput, 'fits'>): Array<[number, number]> {
  let contexts: number[] = input.contextAuto ? [...MANAGED_AUTO_CONTEXTS] : [input.context]
  if (input.contextAuto) {
    const trained = input.trainedContext
    if (trained !== undefined && trained > 0) {
      const within = contexts.filter((c) => c <= trained)
      contexts = within.length > 0 ? within : [trained]
    }
    const roomy = contexts.filter((c) => c > input.maxOutputTokens)
    if (roomy.length > 0) contexts = roomy
  }
  const pairs: Array<[number, number]> = []
  for (const context of contexts) {
    if (!input.sequencesAuto) pairs.push([context, input.sequences])
    // Two requests only up to 32K: past that the window is worth more than the second request.
    else if (context > MANAGED_AUTO_CONTEXT_DEFAULT) pairs.push([context, MANAGED_AUTO_SEQUENCES])
    else pairs.push([context, MANAGED_AUTO_SEQUENCES], [context, 1])
  }
  return pairs
}

/** The first candidate pair the memory rule passes, else the smallest (the check then refuses). */
export function fitAutoLimits(input: AutoLimitsInput): { context: number; sequences: number } {
  const pairs = autoLimitCandidates(input)
  const chosen =
    pairs.find(([context, sequences]) => input.fits(context, sequences)) ?? pairs[pairs.length - 1]
  const [context, sequences] = chosen ?? [input.context, input.sequences]
  return { context, sequences }
}

const CONTEXT_KEYS = [
  'max_position_embeddings',
  'n_positions',
  'max_seq_len',
  'seq_length',
  'model_max_length',
  'max_sequence_length',
  'max_seq_length',
  'seq_len',
] as const

/**
 * The longest window a checkpoint takes, as vLLM derives it (`_get_and_verify_max_len`: the smallest
 * of these keys on the text config) without its RoPE-scaling factor — the safe side, since a window
 * above what vLLM derives fails the start. SGLang reads the same keys. `undefined` when none is set.
 */
export function checkpointMaxContext(configJson: JsonObject): number | undefined {
  const text = configJson['text_config']
  const config =
    typeof text === 'object' && text !== null && !Array.isArray(text) ? (text as JsonObject) : configJson
  const values = CONTEXT_KEYS.map((key) => config[key] ?? configJson[key]).filter(
    (v): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
  )
  return values.length > 0 ? Math.min(...values) : undefined
}
