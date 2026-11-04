/**
 * OpenAI chat completions over LiteRT-LM's conversation JSON (spec `litert-lm-runtime`, "Сервер
 * хоста отвечает как OpenAI chat completions"; task 5.4). Pure: requests in, library messages out;
 * library chunks in, OpenAI deltas and replies out.
 *
 * What the library does itself (spike S2): chat templates, parsing tool calls into `tool_calls` with
 * an `arguments` object (one chunk, no deltas), thinking as `channels.thought`. What it has no notion
 * of and the host adds: `stop` strings, OpenAI's string `arguments`, call ids, `finish_reason`.
 */

import type { LiteRtMessage, LiteRtSampler } from './library.js'

import {
  DATA_URL_RE,
  invalidRequest as invalid,
  isRecord,
  OpenAiRequestError,
  parseCommonChatRequest,
  textOf,
} from '../../shared/index.js'
import type { Delta, FinishReason, ModelCaps } from '../../shared/index.js'

export { OpenAiRequestError }
export type { Delta, FinishReason, ModelCaps, OpenAiErrorBody } from '../../shared/index.js'

export interface ParsedChat {
  /** Every message but the trailing user message or run of tool results. */
  history: LiteRtMessage[]
  /** What this request adds: one user message, or the tool results that close a round of calls. */
  next: LiteRtMessage[]
  /** `null` with no tools or `tool_choice: "none"`. */
  tools: unknown[] | null
  stream: boolean
  includeUsage: boolean
  sampler: LiteRtSampler
  maxTokens?: number
  stop: string[]
  responseFormat: { kind: 'json_schema' | 'regex'; value: string } | null
  thinking: boolean
}

const text = (value: string) => ({ type: 'text', text: value })

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return isRecord(raw) ? raw : {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

/** A tool result: the JSON it holds when it is JSON, else the text. */
function parseToolResponse(content: unknown): unknown {
  const raw = typeof content === 'string' ? content : textOf(content, 'content')
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return raw
  }
}

function userContent(content: unknown, caps: ModelCaps, param: string): Record<string, unknown>[] {
  if (typeof content === 'string') return [text(content)]
  if (!Array.isArray(content)) throw invalid(`${param} must be a string or an array of parts`, param)
  return content.map((part, index) => {
    const at = `${param}[${index}]`
    if (!isRecord(part)) throw invalid(`${at} is not a content part`, at)
    if (part['type'] === 'text' && typeof part['text'] === 'string') return text(part['text'])
    if (part['type'] === 'image_url') {
      if (!caps.vision) throw invalid('This model does not take image input.', at)
      const url = isRecord(part['image_url']) ? part['image_url']['url'] : part['image_url']
      const match = typeof url === 'string' ? DATA_URL_RE.exec(url) : null
      if (!match) throw invalid('An image must be a base64 data URL (data:image/…;base64,…).', at)
      return { type: 'image', blob: match[1] }
    }
    throw invalid(`Content part type ${JSON.stringify(part['type'])} is not supported.`, at)
  })
}

function convertMessages(raw: unknown[], caps: ModelCaps): LiteRtMessage[] {
  const callNames = new Map<string, string>()
  return raw.map((item, index) => {
    const param = `messages[${index}]`
    if (!isRecord(item)) throw invalid(`${param} is not a message`, param)
    const role = item['role']
    if (role === 'system' || role === 'developer')
      return { role: 'system', content: [text(textOf(item['content'], `${param}.content`))] }
    if (role === 'user')
      return { role: 'user', content: userContent(item['content'], caps, `${param}.content`) }
    if (role === 'assistant') {
      const said = textOf(item['content'], `${param}.content`)
      const calls = Array.isArray(item['tool_calls']) ? item['tool_calls'] : []
      const message: LiteRtMessage = { role: 'assistant', content: said ? [text(said)] : [] }
      if (calls.length > 0)
        message['tool_calls'] = calls.map((call) => {
          const fn = isRecord(call) && isRecord(call['function']) ? call['function'] : {}
          const name = typeof fn['name'] === 'string' ? fn['name'] : ''
          if (isRecord(call) && typeof call['id'] === 'string') callNames.set(call['id'], name)
          return { type: 'function', function: { name, arguments: parseArguments(fn['arguments']) } }
        })
      return message
    }
    if (role === 'tool') {
      const id = item['tool_call_id']
      const name =
        (typeof id === 'string' ? callNames.get(id) : undefined) ??
        (typeof item['name'] === 'string' ? item['name'] : '')
      return {
        role: 'tool',
        content: [{ type: 'tool_response', name, response: parseToolResponse(item['content']) }],
      }
    }
    throw invalid(
      `${param}.role ${JSON.stringify(role)} is not system, developer, user, assistant or tool`,
      `${param}.role`
    )
  })
}

/** A chat completions body, or `OpenAiRequestError` (400) naming the field it cannot serve. */
export function parseChatRequest(raw: unknown, caps: ModelCaps): ParsedChat {
  if (!isRecord(raw)) throw invalid('The request body must be a JSON object.')
  const common = parseCommonChatRequest(raw, caps)
  const messages = convertMessages(raw['messages'] as unknown[], caps)
  let split = messages.length
  while (split > 0 && messages[split - 1]?.['role'] === 'tool') split--
  if (split === messages.length) {
    if (messages.at(-1)?.['role'] !== 'user')
      throw invalid('The last message must be from the user or a tool.', 'messages')
    split--
  }
  return {
    history: messages.slice(0, split),
    next: messages.slice(split),
    tools: common.tools,
    stream: common.stream,
    includeUsage: common.includeUsage,
    sampler: common.sampler,
    ...(common.maxTokens !== undefined ? { maxTokens: common.maxTokens } : {}),
    stop: common.stop,
    responseFormat: common.responseFormat,
    thinking: common.thinking,
  }
}

interface ToolCall {
  id: string
  name: string
  arguments: unknown
}

/** The library's words for a generation it ended at the token limit; not an error to the client. */
const TOKEN_LIMIT_RE = /max number of tokens/i
const CANCELLED_RE = /^CANCELLED/i

/** Builds one reply from the library's chunks: deltas as they come, the whole message at the end. */
export class ReplyBuilder {
  private content = ''
  private reasoning = ''
  private readonly calls: ToolCall[] = []
  /** Text not yet sent because it may be the start of a stop string. */
  private held = ''
  /** A stop string was met: everything after it is dropped and the library should be cancelled. */
  stopped = false
  /** Chunks that carried generated text or thought: the completion's token count, near enough. */
  completionChunks = 0

  constructor(
    private readonly stops: readonly string[],
    private readonly newCallId: () => string = () => `call_${Math.random().toString(36).slice(2, 14)}`
  ) {}

  /** One library chunk (a message JSON, or bare text); the deltas it makes. */
  add(raw: string): Delta[] {
    if (this.stopped) return []
    let message: Record<string, unknown>
    try {
      const parsed = JSON.parse(raw) as unknown
      message = isRecord(parsed) ? parsed : { content: [text(raw)] }
    } catch {
      message = { content: [text(raw)] }
    }
    const deltas: Delta[] = []
    const thought = isRecord(message['channels']) ? message['channels']['thought'] : undefined
    if (typeof thought === 'string' && thought) {
      this.reasoning += thought
      this.completionChunks++
      deltas.push({ reasoning_content: thought })
    }
    const parts = Array.isArray(message['content']) ? message['content'] : []
    const said = parts
      .map((part) =>
        isRecord(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : ''
      )
      .join('')
    if (said) {
      this.completionChunks++
      const out = this.text(said)
      if (out) deltas.push({ content: out })
    }
    const calls = Array.isArray(message['tool_calls']) ? message['tool_calls'] : []
    if (calls.length > 0) {
      const added = calls.map((call) => {
        const fn = isRecord(call) && isRecord(call['function']) ? call['function'] : {}
        const made: ToolCall = {
          id: this.newCallId(),
          name: typeof fn['name'] === 'string' ? fn['name'] : '',
          arguments: parseArguments(fn['arguments']),
        }
        this.calls.push(made)
        return made
      })
      deltas.push({
        tool_calls: added.map((call) => ({
          index: this.calls.indexOf(call),
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: JSON.stringify(call.arguments) },
        })),
      })
    }
    return deltas
  }

  /** Text to send now; holds back a tail that may begin a stop string, cuts at a whole one. */
  private text(more: string): string {
    const pending = this.held + more
    for (const stop of this.stops) {
      const at = pending.indexOf(stop)
      if (at >= 0) {
        this.stopped = true
        this.held = ''
        this.content += pending.slice(0, at)
        return pending.slice(0, at)
      }
    }
    let keep = 0
    for (const stop of this.stops)
      for (let length = Math.min(stop.length - 1, pending.length); length > keep; length--)
        if (pending.endsWith(stop.slice(0, length))) {
          keep = length
          break
        }
    this.held = pending.slice(pending.length - keep)
    const out = pending.slice(0, pending.length - keep)
    this.content += out
    return out
  }

  /** At the end: whatever was held back for a stop string that never came. */
  flush(): Delta[] {
    if (!this.held) return []
    const out = this.held
    this.held = ''
    this.content += out
    return [{ content: out }]
  }

  /**
   * The finish reason, given the error the last chunk carried. A cancel the host made for a stop
   * string is a stop; the token limit is `length`; any other error is thrown, with the library's words.
   */
  finish(error: string | null): FinishReason {
    if (error && !(this.stopped && CANCELLED_RE.test(error))) {
      if (TOKEN_LIMIT_RE.test(error)) return 'length'
      throw new OpenAiRequestError(500, `LiteRT-LM: ${error}`)
    }
    return this.calls.length > 0 ? 'tool_calls' : 'stop'
  }

  /** `choices[0].message` of a non-stream reply. */
  message(): Record<string, unknown> {
    return {
      role: 'assistant',
      content: this.content || this.calls.length === 0 ? this.content : null,
      ...(this.reasoning ? { reasoning_content: this.reasoning } : {}),
      ...(this.calls.length > 0
        ? {
            tool_calls: this.calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : {}),
    }
  }

  /** The reply as the library's conversation holds it: what a continuing request must repeat. */
  history(): LiteRtMessage {
    return {
      role: 'assistant',
      content: this.content ? [text(this.content)] : [],
      ...(this.calls.length > 0
        ? {
            tool_calls: this.calls.map((call) => ({
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    }
  }
}
