/**
 * Prompt size from text alone, for an engine that cannot count its own prompt, and for sharing an
 * engine's exact count out over the messages of a request.
 *
 * Ported from: web-app/src/lib/prompt-size.ts (`estimateTokens`, `estimateToolTokens`,
 * `messageText`, `estimatePromptTokensHeuristic`, `DEFAULT_OUTPUT_RESERVE_TOKENS`). The shape is the
 * Rust agent's `token_budget.rs::estimate_tokens`: the larger of a character-based and a word-based
 * guess, so dense JSON (few words, many characters) and prose (many short words) are both bounded.
 * The app worked on AI SDK messages; these are the OpenAI chat messages the core receives.
 */

import type { ContextChatMessage } from '../../contracts/index.js'

export const CHARS_PER_TOKEN = 3.6
export const WORDS_PER_TOKEN = 1.4
/** Per-tool wrapper the chat template adds around each JSON schema. */
export const TOOL_TEMPLATE_OVERHEAD_TOKENS = 12
/** Per-message wrapper (role tags, separators). */
export const MESSAGE_TEMPLATE_OVERHEAD_TOKENS = 4
/**
 * One image or audio part. Its real cost is the model's encoder's (from 256 tokens for Gemma 3 to
 * thousands for a large image on Qwen-VL); counting none would read an image chat as tiny.
 */
export const MEDIA_PART_TOKENS = 768
/** Output room kept free when a request names no `max_tokens`. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 1024
/**
 * A client's own output cap counts as room to keep free only up to this share of the window: agents
 * send their model's whole output limit (`max_tokens: 32000` against a 32K window), which no history
 * could make room for.
 */
export const MAX_RESERVE_WINDOW_SHARE = 0.25
/** What a chat template adds besides the messages' JSON in {@link promptTokenBound}: tool preambles, BOS. */
export const TEMPLATE_BOUND_TOKENS = 512
export const TEMPLATE_BOUND_PER_MESSAGE = 8

const TEXT_PART_TYPES: ReadonlySet<string> = new Set(['text', 'input_text', 'output_text'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0
  const byChars = Math.ceil(text.length / CHARS_PER_TOKEN)
  const trimmed = text.trim()
  const words = trimmed ? trimmed.split(/\s+/).length : 0
  return Math.max(byChars, Math.ceil(words * WORDS_PER_TOKEN))
}

function isTextPart(part: unknown): part is { type?: string; text: string } {
  return (
    isRecord(part) &&
    typeof part['text'] === 'string' &&
    (part['type'] === undefined || TEXT_PART_TYPES.has(String(part['type'])))
  )
}

/**
 * The text a chat template renders for a message: its content's text, its tool calls (name and
 * arguments) and the reasoning a client sent back.
 */
export function messageText(message: ContextChatMessage): string {
  const out: string[] = []
  const { content } = message
  if (typeof content === 'string') out.push(content)
  else if (Array.isArray(content)) for (const part of content) if (isTextPart(part)) out.push(part.text)
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      const fn = isRecord(call) ? call['function'] : undefined
      out.push(JSON.stringify(fn ?? call))
    }
  }
  const reasoning = message['reasoning_content']
  if (typeof reasoning === 'string') out.push(reasoning)
  return out.join('\n')
}

/** Parts of a message's content that are not text: images, audio, files. */
export function mediaPartCount(message: ContextChatMessage): number {
  if (!Array.isArray(message.content)) return 0
  return message.content.filter((part) => isRecord(part) && !isTextPart(part)).length
}

export function estimateMessageTokens(message: ContextChatMessage): number {
  return (
    estimateTextTokens(messageText(message)) +
    MESSAGE_TEMPLATE_OVERHEAD_TOKENS +
    mediaPartCount(message) * MEDIA_PART_TOKENS
  )
}

export function estimateToolsTokens(tools: readonly unknown[] | undefined): number {
  if (!tools) return 0
  return tools.reduce<number>(
    (sum, tool) => sum + estimateTextTokens(JSON.stringify(tool) ?? '') + TOOL_TEMPLATE_OVERHEAD_TOKENS,
    0
  )
}

export function estimatePromptTokens(request: {
  messages: readonly ContextChatMessage[]
  tools?: readonly unknown[] | undefined
}): number {
  return (
    request.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
    estimateToolsTokens(request.tools)
  )
}

/**
 * The messages with their media parts left out, for an engine's template and tokenizer: llama.cpp's
 * `/apply-template` and a text-only `/tokenize` would refuse an image or count its URL as text. Media
 * is counted apart, at {@link MEDIA_PART_TOKENS} a part.
 */
export function textOnlyMessages(messages: readonly ContextChatMessage[]): ContextChatMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content) || mediaPartCount(message) === 0) return message
    const text = message.content.filter(isTextPart)
    return { ...message, content: text.length > 0 ? text : '' }
  })
}

/**
 * A number of tokens the prompt cannot exceed, without asking the engine: a byte-level or
 * byte-fallback tokenizer never makes more tokens than the UTF-8 bytes of the text, and the request's
 * JSON is longer than the text a template renders from it, save the template's own few hundred
 * tokens. `undefined` when the request carries media, whose cost no byte count bounds.
 */
export function promptTokenBound(request: {
  messages: readonly ContextChatMessage[]
  tools?: readonly unknown[] | undefined
}): number | undefined {
  if (request.messages.some((message) => mediaPartCount(message) > 0)) return undefined
  const bytes = Buffer.byteLength(JSON.stringify({ messages: request.messages, tools: request.tools ?? [] }))
  return bytes + TEMPLATE_BOUND_TOKENS + request.messages.length * TEMPLATE_BOUND_PER_MESSAGE
}

/** The output cap a chat body asks for (`max_completion_tokens`, else `max_tokens`), when it names one. */
export function requestedOutputTokens(body: Record<string, unknown> | undefined): number | undefined {
  for (const key of ['max_completion_tokens', 'max_tokens']) {
    const value = body?.[key]
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  }
  return undefined
}

/**
 * Tokens kept free for the answer to `body`: its own output cap, or {@link DEFAULT_OUTPUT_RESERVE_TOKENS},
 * and never more than {@link MAX_RESERVE_WINDOW_SHARE} of a known window.
 */
export function answerReserve(body: Record<string, unknown> | undefined, window?: number): number {
  const reserve = requestedOutputTokens(body) ?? DEFAULT_OUTPUT_RESERVE_TOKENS
  if (window === undefined || !(window > 0)) return reserve
  return Math.min(reserve, Math.floor(window * MAX_RESERVE_WINDOW_SHARE))
}
