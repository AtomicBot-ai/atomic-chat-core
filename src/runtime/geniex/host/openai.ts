/**
 * OpenAI chat completions over GenieX's chat template and token stream (spec `geniex-runtime`,
 * "Сервер хоста отвечает как OpenAI chat completions"; task 5.4, design D6). Pure: a request in,
 * the template's messages out; tokens in, OpenAI deltas and the reply out.
 *
 * What the library does (design): renders the chat template with `tools` and `enable_thinking`,
 * streams raw tokens. What it has no notion of and the host adds: reading `<think>…</think>` as
 * `reasoning_content`, `<tool_call>{…}</tool_call>` (Qwen3) and fenced JSON (Gemma 4) as
 * `tool_calls`, stop strings, call ids, `finish_reason`, images as files.
 */

import { invalidRequest as invalid, isRecord, parseCommonChatRequest, textOf } from '../../shared/index.js'
import type { CommonChatRequest, Delta, FinishReason, ModelCaps } from '../../shared/index.js'
import type { GeniexChatMessage, GeniexContent, GeniexStopReason } from './library.js'

export interface ParsedGeniexChat extends CommonChatRequest {
  /** Every message, as the template takes them; images as the `imageIndex`th of `images`. */
  messages: GeniexChatMessage[]
  /** The images of the request, base64 bodies in order of appearance; the host writes them to files. */
  images: Array<{ base64: string; mime: string }>
  /** `tools` as one JSON string for the template; `null` for none. */
  toolsJson: string | null
}

const DATA_URL_RE = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i

/** A content part's text, or an image placeholder path the host fills in once the file is written. */
export const IMAGE_PLACEHOLDER = (index: number): string => `{{image:${index}}}`

function userContent(
  content: unknown,
  caps: ModelCaps,
  param: string,
  images: ParsedGeniexChat['images']
): GeniexContent[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) throw invalid(`${param} must be a string or an array of parts`, param)
  return content.map((part, index) => {
    const at = `${param}[${index}]`
    if (!isRecord(part)) throw invalid(`${at} is not a content part`, at)
    if (part['type'] === 'text' && typeof part['text'] === 'string')
      return { type: 'text', text: part['text'] }
    if (part['type'] === 'image_url') {
      if (!caps.vision) throw invalid('This model does not take image input.', at)
      const url = isRecord(part['image_url']) ? part['image_url']['url'] : part['image_url']
      const match = typeof url === 'string' ? DATA_URL_RE.exec(url) : null
      if (!match) throw invalid('An image must be a base64 data URL (data:image/…;base64,…).', at)
      images.push({ mime: (match[1] as string).toLowerCase(), base64: match[2] as string })
      return { type: 'image', path: IMAGE_PLACEHOLDER(images.length - 1) }
    }
    throw invalid(`Content part type ${JSON.stringify(part['type'])} is not supported.`, at)
  })
}

function convertMessages(
  raw: unknown[],
  caps: ModelCaps,
  images: ParsedGeniexChat['images']
): GeniexChatMessage[] {
  const callNames = new Map<string, string>()
  return raw.map((item, index) => {
    const param = `messages[${index}]`
    if (!isRecord(item)) throw invalid(`${param} is not a message`, param)
    const role = item['role']
    if (role === 'system' || role === 'developer')
      return {
        role: 'system',
        content: [{ type: 'text', text: textOf(item['content'], `${param}.content`) }],
      }
    if (role === 'user')
      return { role: 'user', content: userContent(item['content'], caps, `${param}.content`, images) }
    if (role === 'assistant') {
      const said = textOf(item['content'], `${param}.content`)
      const calls = Array.isArray(item['tool_calls']) ? item['tool_calls'] : []
      const message: GeniexChatMessage = {
        role: 'assistant',
        content: said ? [{ type: 'text', text: said }] : [],
      }
      if (calls.length > 0)
        message.tool_calls = calls.map((call) => {
          const fn = isRecord(call) && isRecord(call['function']) ? call['function'] : {}
          const name = typeof fn['name'] === 'string' ? fn['name'] : ''
          const id = isRecord(call) && typeof call['id'] === 'string' ? call['id'] : null
          if (id) callNames.set(id, name)
          const args = fn['arguments']
          return { id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args ?? {}) }
        })
      return message
    }
    if (role === 'tool') {
      const id = typeof item['tool_call_id'] === 'string' ? item['tool_call_id'] : null
      const name =
        (id ? callNames.get(id) : undefined) ?? (typeof item['name'] === 'string' ? item['name'] : null)
      return {
        role: 'tool',
        content: [{ type: 'text', text: textOf(item['content'], `${param}.content`) }],
        tool_call_id: id,
        tool_name: name,
      }
    }
    throw invalid(
      `${param}.role ${JSON.stringify(role)} is not system, developer, user, assistant or tool`,
      `${param}.role`
    )
  })
}

/** A chat completions body, or `OpenAiRequestError` (400) naming the field it cannot serve. */
export function parseGeniexChatRequest(raw: unknown, caps: ModelCaps): ParsedGeniexChat {
  if (!isRecord(raw)) throw invalid('The request body must be a JSON object.')
  const common = parseCommonChatRequest(raw, caps)
  const images: ParsedGeniexChat['images'] = []
  const messages = convertMessages(raw['messages'] as unknown[], caps, images)
  const last = messages.at(-1)
  if (!last || (last.role !== 'user' && last.role !== 'tool'))
    throw invalid('The last message must be from the user or a tool.', 'messages')
  return { ...common, messages, images, toolsJson: common.tools ? JSON.stringify(common.tools) : null }
}

// ---------------------------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------------------------

interface ToolCall {
  id: string
  name: string
  arguments: string
}

const THINK_OPEN = '<think>'
const THINK_CLOSE = '</think>'
const CALL_OPEN = '<tool_call>'
const CALL_CLOSE = '</tool_call>'
const FENCE = '```'
// Gemma 4's own syntax (spike S2, 2026-10-28; the format vLLM's `gemma4` parser reads):
// `<|channel>thought …<channel|>` is thinking, `<|tool_call>call:name{key:<|"|>text<|"|>,n:42,…}<tool_call|>`
// (or `<turn|>`) a call — bare keys, strings in `<|"|>` with no escapes, nested `{}` and `[]`.
const GEMMA_THINK_OPEN = '<|channel>thought'
const GEMMA_THINK_CLOSE = '<channel|>'
const GEMMA_CALL_OPEN = '<|tool_call>'
const GEMMA_CALL_CLOSES = ['<tool_call|>', '<turn|>'] as const
const GEMMA_QUOTE = '<|"|>'

/** A JSON object with `name` and `arguments` (or `parameters`), or a list of them. */
function callsOf(json: string): Array<{ name: string; arguments: string }> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(json.trim())
  } catch {
    return null
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const calls: Array<{ name: string; arguments: string }> = []
  for (const item of items) {
    if (!isRecord(item)) return null
    const fn = isRecord(item['function']) ? item['function'] : item
    const name = fn['name']
    if (typeof name !== 'string' || name === '') return null
    const args = fn['arguments'] ?? fn['parameters'] ?? {}
    calls.push({ name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
  }
  return calls.length > 0 ? calls : null
}

/** The longest prefix of a marker that `text` ends with; 0 when none. */
/** `call:name{…}` blocks of a Gemma 4 tool-call body, their arguments as JSON; `null` when there is none. */
function gemmaCallsOf(body: string): Array<{ name: string; arguments: string }> | null {
  const calls: Array<{ name: string; arguments: string }> = []
  const re = /call:(\w+)\{/g
  let match: RegExpExecArray | null
  while ((match = re.exec(body))) {
    const open = match.index + match[0].length - 1
    const close = gemmaMatching(body, open)
    if (close < 0) return null
    calls.push({
      name: match[1] as string,
      arguments: JSON.stringify(gemmaObject(body.slice(open + 1, close))),
    })
    re.lastIndex = close + 1
  }
  return calls.length > 0 ? calls : null
}

/** The index of the bracket closing the one at `open`, skipping quoted strings; -1 when unbalanced. */
function gemmaMatching(text: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']' }
  const stack: string[] = [pairs[text[open] as string] as string]
  for (let i = open + 1; i < text.length; i++) {
    if (text.startsWith(GEMMA_QUOTE, i)) {
      const end = text.indexOf(GEMMA_QUOTE, i + GEMMA_QUOTE.length)
      if (end < 0) return -1
      i = end + GEMMA_QUOTE.length - 1
      continue
    }
    const c = text[i] as string
    if (c === '{' || c === '[') stack.push(pairs[c] as string)
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1
      if (stack.length === 0) return i
    }
  }
  return -1
}

/** Splits `text` at the commas outside strings and brackets. */
function gemmaItems(text: string): string[] {
  const items: string[] = []
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    if (text.startsWith(GEMMA_QUOTE, i)) {
      const end = text.indexOf(GEMMA_QUOTE, i + GEMMA_QUOTE.length)
      i = end < 0 ? text.length : end + GEMMA_QUOTE.length - 1
      continue
    }
    const c = text[i] as string
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      items.push(text.slice(from, i))
      from = i + 1
    }
  }
  items.push(text.slice(from))
  return items.map((item) => item.trim()).filter((item) => item !== '')
}

function gemmaValue(raw: string): unknown {
  const text = raw.trim()
  if (text.startsWith(GEMMA_QUOTE)) {
    const end = text.indexOf(GEMMA_QUOTE, GEMMA_QUOTE.length)
    return end < 0 ? text.slice(GEMMA_QUOTE.length) : text.slice(GEMMA_QUOTE.length, end)
  }
  if (text.startsWith('{') && text.endsWith('}')) return gemmaObject(text.slice(1, -1))
  if (text.startsWith('[') && text.endsWith(']')) return gemmaItems(text.slice(1, -1)).map(gemmaValue)
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === 'None') return null
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return Number(text)
  return text
}

/** `key:value,…` of a Gemma 4 call (keys bare or in `<|"|>`), as an object. */
function gemmaObject(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const item of gemmaItems(text)) {
    const colon = item.startsWith(GEMMA_QUOTE)
      ? item.indexOf(':', item.indexOf(GEMMA_QUOTE, GEMMA_QUOTE.length) + GEMMA_QUOTE.length)
      : item.indexOf(':')
    if (colon < 0) continue
    let key = item.slice(0, colon).trim()
    if (key.startsWith(GEMMA_QUOTE) && key.endsWith(GEMMA_QUOTE))
      key = key.slice(GEMMA_QUOTE.length, -GEMMA_QUOTE.length)
    out[key] = gemmaValue(item.slice(colon + 1))
  }
  return out
}

function partialSuffix(text: string, markers: readonly string[]): number {
  let keep = 0
  for (const marker of markers)
    for (let length = Math.min(marker.length - 1, text.length); length > keep; length--)
      if (text.endsWith(marker.slice(0, length))) {
        keep = length
        break
      }
  return keep
}

/**
 * Builds one reply from the library's tokens: deltas as they come, the whole message at the end. A
 * `<think>` block (Gemma 4: `<|channel>thought…<channel|>`) becomes `reasoning_content`; a `<tool_call>`
 * block (Gemma 4: `<|tool_call>call:…<tool_call|>`), and with tools requested a fenced JSON block,
 * become `tool_calls`; a stop string ends the text and asks to cancel the library.
 */
export class GeniexReplyParser {
  private content = ''
  private reasoning = ''
  private readonly calls: ToolCall[] = []
  /** Text not yet classified: may begin a marker or a stop string. */
  private held = ''
  private state: 'text' | 'think' | 'call' | 'fence' | 'gthink' | 'gcall' = 'text'
  /** The fence's opening line (` ```json `), kept to replay a block that was not a tool call. */
  private fenceHead = ''
  /** A stop string was met: everything after it is dropped and the library should be cancelled. */
  stopped = false
  tokens = 0

  constructor(
    private readonly stops: readonly string[],
    private readonly toolsRequested: boolean,
    private readonly newCallId: () => string = () => `call_${Math.random().toString(36).slice(2, 14)}`
  ) {}

  /** One token; the deltas it makes. */
  add(token: string): Delta[] {
    if (this.stopped) return []
    this.tokens++
    this.held += token
    return this.drain(false)
  }

  /** At the end: whatever was held back for a marker or a stop string that never came. */
  flush(): Delta[] {
    return this.stopped ? [] : this.drain(true)
  }

  private drain(final: boolean): Delta[] {
    const deltas: Delta[] = []
    let progress = true
    while (progress && this.held.length > 0) {
      progress = false
      if (this.state === 'text') {
        const stopAt = this.stops
          .map((stop) => [this.held.indexOf(stop), stop] as const)
          .filter(([at]) => at >= 0)
          .sort((a, b) => a[0] - b[0])[0]
        const openers = {
          think: THINK_OPEN,
          call: CALL_OPEN,
          fence: this.toolsRequested ? FENCE : null,
          gthink: GEMMA_THINK_OPEN,
          gcall: GEMMA_CALL_OPEN,
        } as const
        type Kind = keyof typeof openers
        const marks = (Object.keys(openers) as Kind[])
          .map(
            (kind) =>
              [openers[kind] === null ? -1 : this.held.indexOf(openers[kind] as string), kind] as const
          )
          .filter(([at]) => at >= 0)
          .sort((a, b) => a[0] - b[0])
        const first = marks[0]
        if (stopAt && (!first || stopAt[0] <= first[0])) {
          this.emitText(this.held.slice(0, stopAt[0]), deltas)
          this.held = ''
          this.stopped = true
          return deltas
        }
        if (first) {
          const [at, kind] = first
          this.emitText(this.held.slice(0, at), deltas)
          this.held = this.held.slice(at + (openers[kind] as string).length)
          this.state = kind
          this.fenceHead = ''
          progress = true
          continue
        }
        const keep = final
          ? 0
          : partialSuffix(this.held, [
              THINK_OPEN,
              CALL_OPEN,
              GEMMA_THINK_OPEN,
              GEMMA_CALL_OPEN,
              ...(this.toolsRequested ? [FENCE] : []),
              ...this.stops,
            ])
        const out = this.held.slice(0, this.held.length - keep)
        this.held = this.held.slice(this.held.length - keep)
        this.emitText(out, deltas)
        continue
      }
      if (this.state === 'think' || this.state === 'gthink') {
        const closer = this.state === 'think' ? THINK_CLOSE : GEMMA_THINK_CLOSE
        const close = this.held.indexOf(closer)
        if (close >= 0) {
          this.emitReasoning(this.held.slice(0, close), deltas)
          this.held = this.held.slice(close + closer.length)
          this.state = 'text'
          progress = true
          continue
        }
        const keep = final ? 0 : partialSuffix(this.held, [closer])
        this.emitReasoning(this.held.slice(0, this.held.length - keep), deltas)
        this.held = this.held.slice(this.held.length - keep)
        continue
      }
      if (this.state === 'call' || this.state === 'gcall') {
        const gemma = this.state === 'gcall'
        const closers: readonly string[] = gemma ? GEMMA_CALL_CLOSES : [CALL_CLOSE]
        const found = closers
          .map((closer) => [this.held.indexOf(closer), closer] as const)
          .filter(([at]) => at >= 0)
          .sort((a, b) => a[0] - b[0])[0]
        if (found || final) {
          const body = found ? this.held.slice(0, found[0]) : this.held
          this.held = found ? this.held.slice(found[0] + found[1].length) : ''
          this.state = 'text'
          const calls = gemma ? gemmaCallsOf(body) : callsOf(body)
          if (calls) deltas.push(this.record(calls))
          else this.emitText(`${gemma ? GEMMA_CALL_OPEN : CALL_OPEN}${body}${found ? found[1] : ''}`, deltas)
          progress = found !== undefined
          continue
        }
        return deltas
      }
      // A fenced block: the first line names the language; the body runs to the closing fence.
      if (this.fenceHead === '' && !this.held.includes('\n')) {
        if (final) {
          this.emitText(`${FENCE}${this.held}`, deltas)
          this.held = ''
        }
        return deltas
      }
      if (this.fenceHead === '') {
        const newline = this.held.indexOf('\n')
        this.fenceHead = this.held.slice(0, newline + 1)
        this.held = this.held.slice(newline + 1)
      }
      const close = this.held.indexOf(FENCE)
      if (close >= 0 || final) {
        const body = close >= 0 ? this.held.slice(0, close) : this.held
        this.held = close >= 0 ? this.held.slice(close + FENCE.length) : ''
        this.state = 'text'
        const language = this.fenceHead.trim().toLowerCase()
        const calls =
          language === '' || language === 'json' || language === 'tool_call' || language === 'tool_code'
            ? callsOf(body)
            : null
        if (calls) deltas.push(this.record(calls))
        else this.emitText(`${FENCE}${this.fenceHead}${body}${close >= 0 ? FENCE : ''}`, deltas)
        this.fenceHead = ''
        progress = close >= 0
        continue
      }
      return deltas
    }
    return deltas
  }

  private emitText(text: string, deltas: Delta[]): void {
    if (!text) return
    this.content += text
    deltas.push({ content: text })
  }

  private emitReasoning(text: string, deltas: Delta[]): void {
    if (!text) return
    this.reasoning += text
    deltas.push({ reasoning_content: text })
  }

  private record(calls: Array<{ name: string; arguments: string }>): Delta {
    const added = calls.map((call) => {
      const made: ToolCall = { id: this.newCallId(), ...call }
      this.calls.push(made)
      return made
    })
    return {
      tool_calls: added.map((call) => ({
        index: this.calls.indexOf(call),
        id: call.id,
        type: 'function' as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    }
  }

  /** The finish reason: calls win, then the library's own stop reason. */
  finish(stopReason: GeniexStopReason): FinishReason {
    if (this.calls.length > 0) return 'tool_calls'
    return stopReason === 'length' || stopReason === 'context_length' ? 'length' : 'stop'
  }

  /** `choices[0].message` of a non-stream reply. */
  message(): Record<string, unknown> {
    const content = this.content.replace(/^\s*\n/, '')
    return {
      role: 'assistant',
      content: content || this.calls.length === 0 ? content : null,
      ...(this.reasoning.trim() ? { reasoning_content: this.reasoning.replace(/^\n+|\n+$/g, '') } : {}),
      ...(this.calls.length > 0
        ? {
            tool_calls: this.calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    }
  }
}
