/**
 * What a decision model file says about how to run it: which engine (the `DecisionDialect`), and for an
 * upstream GGUF its decision type and trained context. Read from the GGUF header only, before a start.
 *
 * A file the core cannot read stays with the fork, as every GGUF did before upstream served decision
 * models: the fork's own load error is then what the user sees.
 */

import { readGgufMetadataFromFile, upstreamDecisionTypeOf } from '../models/index.js'

/** `-c` for an upstream decision model when the settings leave it to the core. */
export const UPSTREAM_DECISION_DEFAULT_CTX = 8192

/**
 * Upstream decision types read from the embeddings output: the whole prompt must fit one ubatch
 * (llama.cpp `common_init_from_params` turns on embedding mode for them and caps the batch at the
 * ubatch), so the core starts them with `-ub` equal to the context.
 */
export const WHOLE_PROMPT_DECISION_TYPES: ReadonlySet<string> = new Set(['laya', 'kev', 'clef'])

export type DecisionModelFacts =
  | { dialect: 'turboquant' }
  | {
      dialect: 'upstream'
      /** `<arch>.decision.type`. */
      decisionType: string
      /** `<arch>.context_length`, when the file has one. */
      contextTrain?: number
    }

/** The facts from parsed metadata (string values, as the GGUF reader returns them). Pure. */
export function decisionFactsOf(metadata: Record<string, unknown> | undefined): DecisionModelFacts {
  const decisionType = upstreamDecisionTypeOf(metadata)
  if (decisionType === undefined) return { dialect: 'turboquant' }
  const arch = String(metadata?.['general.architecture'] ?? '').trim()
  const context = Number(metadata?.[`${arch}.context_length`])
  return {
    dialect: 'upstream',
    decisionType,
    ...(Number.isInteger(context) && context > 0 ? { contextTrain: context } : {}),
  }
}

/** The facts of a GGUF file; one that cannot be read is the fork's (see the module comment). */
export async function readDecisionModelFacts(
  path: string,
  read: (path: string) => Promise<{ metadata: Record<string, unknown> }> = readGgufMetadataFromFile
): Promise<DecisionModelFacts> {
  const parsed = await read(path).catch(() => undefined)
  return decisionFactsOf(parsed?.metadata)
}

/** `-c` for an upstream model: the setting when given, else the default, never past the trained context. */
export function upstreamCtxSize(setting: number, contextTrain: number | undefined): number {
  const wanted = Number.isInteger(setting) && setting > 0 ? setting : UPSTREAM_DECISION_DEFAULT_CTX
  return contextTrain !== undefined && contextTrain > 0 ? Math.min(wanted, contextTrain) : wanted
}
