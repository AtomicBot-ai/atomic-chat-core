/**
 * Extended thinking for Anthropic `/messages` on a llama.cpp engine.
 *
 * The Anthropic API thinks only when a request asks for it (`thinking: {type: "enabled"}` or
 * `"adaptive"`); a request with no `thinking`, or with `{type: "disabled"}`, gets none. llama.cpp's
 * `/v1/messages` maps only `enabled` (to a thinking budget) and otherwise leaves the chat template's
 * thinking at the server default, which `--jinja` turns on for every template that can think. So a
 * request that asked for no thinking thought anyway: Claude Code's session-title request, sent with
 * no `thinking` and `max_tokens: 32000`, made Qwen3.5 4B think for 20,000 tokens, and on a one-slot
 * server the user's own turn waited behind it (QA B08).
 *
 * The core tells the template what the request meant: `chat_template_kwargs.enable_thinking: false`,
 * which llama.cpp's Anthropic conversion passes to the template (b10777 and later; an older build
 * drops the field and answers as before). A request that sets the switch itself is sent as it is.
 */

import { isJsonObject } from '../shims/index.js'
import type { JsonObject, JsonValue } from '../shims/index.js'
import type { LocalProvider } from '../../router/index.js'

/** The engines that are llama.cpp's own server: both llama.cpp builds and the PrismML fork. */
const LLAMACPP_SERVERS: ReadonlySet<LocalProvider> = new Set([
  'llamacpp',
  'llamacpp-upstream',
  'atomic-prism',
])

function hasKey(value: JsonValue | undefined, key: string): boolean {
  return isJsonObject(value) && Object.prototype.hasOwnProperty.call(value, key)
}

/** Whether an Anthropic `thinking` value asks for thinking: anything but absent, `null` or `disabled`. */
function asksForThinking(thinking: JsonValue | undefined): boolean {
  if (thinking === undefined || thinking === null) return false
  return !(isJsonObject(thinking) && thinking['type'] === 'disabled')
}

/**
 * Whether the body already says whether to think, in the fields llama.cpp reads: the template's own
 * switch at the top level, or the switch or a reasoning effort in the `extra_params` it merges in.
 */
function setsThinkingItself(body: JsonObject): boolean {
  const extra = body['extra_params']
  return (
    hasKey(body['chat_template_kwargs'], 'enable_thinking') ||
    hasKey(extra, 'reasoning_effort') ||
    (isJsonObject(extra) && hasKey(extra['chat_template_kwargs'], 'enable_thinking'))
  )
}

/**
 * The `chat_template_kwargs` an Anthropic request to `provider` goes with so the template does not
 * think, the client's own kwargs kept; `undefined` to send it as it is: an engine other than
 * llama.cpp, a request that asks for thinking or sets the switch itself, or kwargs that are not an
 * object (the engine's to refuse).
 */
export function noThinkingTemplateKwargs(provider: LocalProvider, body: JsonValue): JsonObject | undefined {
  if (!LLAMACPP_SERVERS.has(provider) || !isJsonObject(body)) return undefined
  if (asksForThinking(body['thinking']) || setsThinkingItself(body)) return undefined
  const kwargs = body['chat_template_kwargs']
  if (kwargs === undefined) return { enable_thinking: false }
  return isJsonObject(kwargs) ? { ...kwargs, enable_thinking: false } : undefined
}
