/**
 * What the public server (`:1337`) must know about a `tensorrt-llm` session to route it honestly
 * (spec `tensorrt-llm-runtime`, "Возможности модели объявляются, а не угадываются" and "Переполнение
 * контекста без авто-роста"; design D9): only the routes the adapter declares, tool calls only when
 * the pinned descriptor names a parser for the model's family, and `trtllm-serve`'s context-overflow
 * text mapped to OpenAI's `context_length_exceeded` — never a context increase and a replay.
 */
import type { SessionRoutePolicy } from '../shared/index.js'
import type { ManagedTextCapabilities } from '../managed-text/index.js'
import { TENSORRT_LLM_ROUTES, mapTensorrtLlmContextLengthError } from './adapter.js'

/**
 * `capabilities` are the loaded session's own, `limits` the context and output cap it was loaded
 * with. `null` — a session the core did not start and so cannot describe (one the app registered as
 * external) — keeps the route declaration and the error mapping but leaves tool calls and JSON
 * output to the engine: refusing them would guess just as much as allowing.
 */
export function tensorrtLlmRoutePolicy(
  capabilities: ManagedTextCapabilities | null,
  limits: { contextLength: number; maxOutputTokens: number } | null = null
): SessionRoutePolicy {
  return {
    routes: TENSORRT_LLM_ROUTES,
    tools: capabilities?.tools ?? true,
    structuredOutput: capabilities?.structured_output ?? true,
    mapError: mapTensorrtLlmContextLengthError,
    ...(limits === null ? {} : limits),
  }
}
