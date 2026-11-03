/**
 * System messages inside an Anthropic `/messages` conversation, for a llama.cpp engine.
 *
 * Claude Code sends its reminders as `role: "system"` messages between the turns of a conversation
 * with a model it does not know. llama.cpp's `/v1/messages` hands them to the chat template where they
 * stand, and a strict template (Qwen3.5's: "System message must be at the beginning.") answers 500.
 * The proxy then retried every such turn as chat completions, which loses the reply's token usage and
 * the turn's thinking blocks.
 *
 * Moving them into the top-level `system` fixes the template but rewrites the start of the prompt
 * whenever a reminder appears, and llama.cpp then processes the whole conversation again — on a
 * hybrid or sliding-window model (Qwen3.5, Gemma) its prompt cache cannot reuse anything past the
 * change. So each one stays where it is, as user text wrapped in `<system-reminder>` the way Claude
 * Code writes its own, merged into a neighbouring user turn so the roles still alternate:
 *
 * - into the user message that follows it: at the end of its last `tool_result` when it answers tool
 *   calls, otherwise before its text. llama.cpp puts a user message's text blocks before its tool
 *   results (`server_chat_convert_anthropic_to_oai`), so a text block there would land between the
 *   tool call and its result — and Qwen's template would take it for the user's latest question and
 *   re-render every earlier reply of the turn;
 * - with no user message after it (the conversation ends, or the assistant speaks next), into the
 *   user message before it, the same way at its end; with none there either, as a user message of
 *   its own.
 *
 * Only system messages before the first turn join `system`, where the conversation starts anyway. A
 * reminder sent with `clear_at: "next_user_message"` (a turn-scoped one) is dropped once a user
 * message follows it, as the Anthropic API clears it.
 */

import { asSystemReminder, isJsonObject } from '../shims/index.js'
import type { JsonObject, JsonValue } from '../shims/index.js'
import type { LocalProvider } from '../../router/index.js'
import { isLlamaCppServer } from './thinking.js'

function isSystemRole(message: JsonValue): boolean {
  if (!isJsonObject(message)) return false
  return message['role'] === 'system' || message['role'] === 'developer'
}

function isUser(message: JsonValue | undefined): message is JsonObject {
  return isJsonObject(message) && message['role'] === 'user'
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

function isToolResult(block: JsonValue): block is JsonObject {
  return isJsonObject(block) && block['type'] === 'tool_result'
}

/**
 * A tool result's content with `text` appended: a string stays a string, blocks get one more (which
 * llama.cpp joins to the others with nothing between, hence the blank line it opens with).
 */
function appendToToolResult(block: JsonObject, text: string): JsonObject {
  const content = block['content']
  if (Array.isArray(content) && content.length > 0) {
    return { ...block, content: [...content, { type: 'text', text: `\n\n${text}` }] }
  }
  if (typeof content === 'string' && content !== '') return { ...block, content: `${content}\n\n${text}` }
  return { ...block, content: text }
}

/**
 * `message` with `text` merged in: at the end of its last tool result when it carries any, else at
 * the start (`before`) or the end of its text.
 */
function mergeInto(message: JsonObject, text: string, before: boolean): JsonObject {
  const content = message['content']
  if (Array.isArray(content)) {
    let last = -1
    content.forEach((block, i) => {
      if (isToolResult(block)) last = i
    })
    if (last >= 0) {
      const blocks = [...content]
      blocks[last] = appendToToolResult(blocks[last] as JsonObject, text)
      return { ...message, content: blocks }
    }
    // A template that takes typed content joins the blocks with nothing between them; one that takes
    // a string gets them joined with a newline by llama.cpp.
    if (content.length === 0) return { ...message, content: [{ type: 'text', text }] }
    return {
      ...message,
      content: before
        ? [{ type: 'text', text: `${text}\n` }, ...content]
        : [...content, { type: 'text', text: `\n${text}` }],
    }
  }
  if (typeof content === 'string' && content !== '') {
    return { ...message, content: before ? `${text}\n\n${content}` : `${content}\n\n${text}` }
  }
  return { ...message, content: text }
}

/** The leading system messages' text joined to the request's own `system`. */
function joinedSystem(system: JsonValue | undefined, merged: string): JsonValue {
  if (Array.isArray(system) && system.length > 0) {
    // llama.cpp joins the blocks of an array `system` with nothing between them, so the merged text
    // is one more block that starts on its own paragraph; the client's own blocks stay as they were.
    return [...system, { type: 'text', text: `\n\n${merged}` }]
  }
  if (typeof system === 'string' && system !== '') return `${system}\n\n${merged}`
  return merged
}

/**
 * The `system` and `messages` an Anthropic request to `provider` goes with once the system messages
 * in its conversation are placed as described above; `undefined` to send it as it is: an engine
 * other than llama.cpp, or a conversation with no system message in it.
 */
export function placedSystemMessages(
  provider: LocalProvider,
  body: JsonValue
): { system?: JsonValue; messages: JsonValue[] } | undefined {
  if (!isLlamaCppServer(provider) || !isJsonObject(body)) return undefined
  const messages = body['messages']
  if (!Array.isArray(messages) || !messages.some(isSystemRole)) return undefined

  const lastUser = messages.findLastIndex((message) => isUser(message as JsonValue))
  const cleared = (i: number): boolean =>
    (messages[i] as JsonObject)['clear_at'] === 'next_user_message' && i < lastUser

  let start = 0
  const leadingTexts: string[] = []
  for (; start < messages.length && isSystemRole(messages[start] as JsonValue); start++) {
    const text = cleared(start) ? '' : textOf((messages[start] as JsonObject)['content'])
    if (text !== '') leadingTexts.push(text)
  }
  const leading = leadingTexts.join('\n\n')

  const out: JsonValue[] = []
  let pending: string[] = []
  const flushBefore = () => {
    if (pending.length === 0) return
    const text = pending.join('\n\n')
    pending = []
    const previous = out.at(-1)
    if (isUser(previous)) out[out.length - 1] = mergeInto(previous, text, false)
    else out.push({ role: 'user', content: text })
  }
  for (let i = start; i < messages.length; i++) {
    const message = messages[i] as JsonValue
    if (isSystemRole(message)) {
      const text = cleared(i) ? '' : textOf((message as JsonObject)['content'])
      if (text.trim() !== '') pending.push(asSystemReminder(text))
      continue
    }
    if (pending.length > 0 && isUser(message)) {
      out.push(mergeInto(message, pending.join('\n\n'), true))
      pending = []
      continue
    }
    flushBefore()
    out.push(message)
  }
  flushBefore()

  // Empty leading system messages are dropped and the client's `system` is kept as it came.
  return leading === '' ? { messages: out } : { system: joinedSystem(body['system'], leading), messages: out }
}
