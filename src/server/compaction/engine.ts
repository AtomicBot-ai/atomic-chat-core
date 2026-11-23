/**
 * What each local engine offers history compaction: how its prompts are counted, whether its chat
 * template takes the thinking switch, and how it is addressed.
 */

import type { LocalProviderId } from '../../contracts/index.js'

/**
 * A loaded session as compaction needs it. The public server's `LocalTarget` is one; Apple
 * Foundation Models, which the public server does not route, is one too.
 */
export interface CompactionTarget {
  provider: LocalProviderId
  modelId: string
  port: number
  /** Empty for an engine without auth (MLX): no `Authorization` is sent then. */
  apiKey: string
  /** Present for a session whose engine declares the routes it serves (gateways, hosts). */
  policy?: { routes: readonly { method: string; path: string }[] }
  /** Changes with every load (`SessionInfo.generation`), when the session has one. */
  generation?: string
}

/**
 * llama.cpp's own server: both llama.cpp builds and the PrismML fork. Kept in step with the public
 * server's `isLlamaCppServer` (`server/public/thinking.ts`); a test compares the two.
 */
const LLAMACPP_FAMILY: ReadonlySet<string> = new Set(['llamacpp', 'llamacpp-upstream', 'atomic-prism'])

/**
 * Engines whose chat templates read `chat_template_kwargs.enable_thinking`: llama.cpp passes the
 * kwargs to its Jinja template, and vLLM and SGLang to the Hugging Face template (their adapters read
 * the same switch, `managed-text/request-rules.ts`). Any other engine gets no kwargs it may refuse.
 */
const THINKING_SWITCH: ReadonlySet<string> = new Set([...LLAMACPP_FAMILY, 'vllm', 'sglang'])

/** Whether `provider` is llama.cpp's own server, with `/apply-template`, `/tokenize` and `/props`. */
export function isLlamaCppFamily(provider: string): boolean {
  return LLAMACPP_FAMILY.has(provider)
}

/** Whether a request to `provider` may carry `chat_template_kwargs: {enable_thinking: false}`. */
export function takesThinkingSwitch(provider: string): boolean {
  return THINKING_SWITCH.has(provider)
}

/**
 * How a prompt to `target` is counted: rendered by llama.cpp's template and tokenized there, sent to
 * the chat `/tokenize` a session declares (vLLM, SGLang, the GenieX and LiteRT-LM hosts), or
 * estimated from its text.
 */
export type CountMethod = 'llamacpp' | 'tokenize' | 'estimate'

export function countMethod(target: CompactionTarget): CountMethod {
  if (isLlamaCppFamily(target.provider)) return 'llamacpp'
  if (target.policy?.routes.some((r) => r.method === 'POST' && r.path === '/tokenize')) return 'tokenize'
  return 'estimate'
}

/** The headers of a JSON request to the session: its own key, when it has one. */
export function sessionHeaders(target: CompactionTarget): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
  }
}
