/**
 * System messages inside an Anthropic `/messages` conversation, for a llama.cpp engine.
 *
 * Claude Code sends its reminders as `role: "system"` messages between the turns of a conversation
 * with a model it does not know. llama.cpp's `/v1/messages` hands them to the chat template where they
 * stand, and a strict template (Qwen3.5's: "System message must be at the beginning.") answers 500.
 * The proxy then retried every such turn as chat completions, whose translation merges every system
 * message into the leading one — and loses on the way the reply's token usage (Claude Code then never
 * learns how full its context is) and the turn's thinking blocks.
 *
 * The core merges them the same way before the engine sees the request: their text joins the
 * top-level `system`, the rest of the conversation keeps its order, and llama.cpp answers natively.
 */

import { isJsonObject } from '../shims/index.js'
import type { JsonObject, JsonValue } from '../shims/index.js'
import type { LocalProvider } from '../../router/index.js'
import { isLlamaCppServer } from './thinking.js'

function isSystemRole(message: JsonValue): boolean {
  if (!isJsonObject(message)) return false
  return message['role'] === 'system' || message['role'] === 'developer'
}

/** The message's text: a string as it is, an array's text blocks joined as the chat shim joins them. */
function textOf(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  let text = ''
  for (const block of content) {
    if (isJsonObject(block) && typeof block['text'] === 'string') text += block['text']
  }
  return text
}

/**
 * The `system` and `messages` an Anthropic request to `provider` goes with once the system messages
 * in its conversation are merged into `system`; `undefined` to send it as it is: an engine other than
 * llama.cpp, or a conversation with no system message in it.
 *
 * llama.cpp joins the blocks of an array `system` with nothing between them, so the merged text is
 * one more block that starts on its own paragraph; the client's own blocks are left as they were.
 */
export function mergedSystemMessages(
  provider: LocalProvider,
  body: JsonValue
): { system?: JsonValue; messages: JsonValue[] } | undefined {
  if (!isLlamaCppServer(provider) || !isJsonObject(body)) return undefined
  const messages = body['messages']
  if (!Array.isArray(messages) || !messages.some(isSystemRole)) return undefined

  const texts = messages
    .filter(isSystemRole)
    .map((message) => textOf((message as JsonObject)['content']))
    .filter((text) => text !== '')
  const rest = messages.filter((message) => !isSystemRole(message))
  const merged = texts.join('\n\n')
  const system = body['system']

  // Empty system messages are dropped and the client's `system` is kept as it came.
  if (merged === '') return { messages: rest }
  if (Array.isArray(system)) {
    return {
      system: system.length > 0 ? [...system, { type: 'text', text: `\n\n${merged}` }] : merged,
      messages: rest,
    }
  }
  if (typeof system === 'string' && system !== '') {
    return { system: `${system}\n\n${merged}`, messages: rest }
  }
  return { system: merged, messages: rest }
}
