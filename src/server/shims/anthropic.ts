/**
 * Anthropic `/messages` ↔ OpenAI Chat Completions, for clients such as Claude Code that speak the
 * Anthropic API to a local engine that only speaks Chat Completions.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`transform_anthropic_to_openai`,
 * `transform_openai_response_to_anthropic`, `transform_and_forward_stream`).
 * Contract: test/fixtures/app/anthropic-shim.
 *
 * serde_json's `Value::get` only answers for objects and distinguishes a missing key (`None`) from
 * an explicit `null` (`Some(Null)`); every `unwrap_or` below falls back on a *missing* key only, so
 * an explicit `null` is carried through as `null`. `get` and `orElse` keep that distinction.
 */

import { isJsonObject, serdeToString } from './json.js'
import type { JsonObject, JsonValue } from './json.js'

/** serde_json `Value::get(key)`: `undefined` for a missing key or a non-object. */
function get(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isJsonObject(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
}

function asStr(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** `.unwrap_or(fallback)` on an `Option<&Value>`: only a missing value falls back, not `null`. */
function orElse(value: JsonValue | undefined, fallback: JsonValue): JsonValue {
  return value === undefined ? fallback : value
}

// ── Rust string semantics ────────────────────────────────────────────────────────────────────────

/** `char::is_whitespace` (Unicode White_Space) — not JS `\s`, which adds U+FEFF and drops U+0085. */
const RUST_WS = '\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000'
const RUST_TRIM = new RegExp(`^[${RUST_WS}]+|[${RUST_WS}]+$`, 'g')
const RUST_WS_RUN = new RegExp(`[${RUST_WS}]+`)

/** `str::trim` */
function rustTrim(s: string): string {
  return s.replace(RUST_TRIM, '')
}

/** `str::split_whitespace().count()` */
function wordCount(s: string): number {
  return s.split(RUST_WS_RUN).filter((w) => w.length > 0).length
}

/** Chat `finish_reason` → Anthropic `stop_reason`; anything unknown passes through unchanged. */
function stopReason(reason: string): string {
  switch (reason) {
    case 'stop':
      return 'end_turn'
    case 'length':
      return 'max_tokens'
    case 'tool_calls':
      return 'tool_use'
    default:
      return reason
  }
}

// ── request ──────────────────────────────────────────────────────────────────────────────────────

/** `transform_anthropic_to_openai`; `null` where the Rust returns `None`. */
export function anthropicRequestToChat(body: JsonValue): JsonValue | null {
  const model = asStr(get(body, 'model'))
  if (model === undefined) return null
  const messages = get(body, 'messages')
  if (messages === undefined) return null

  const converted = convertMessages(messages, get(body, 'system'))
  if (converted === null) return null

  const result: JsonObject = {
    model,
    // Strict chat templates reject more than one system message, or a non-leading one.
    messages: mergeSystemMessages(converted),
    stream: get(body, 'stream') === true,
  }

  const tools = get(body, 'tools')
  if (Array.isArray(tools)) {
    const chatTools: JsonValue[] = []
    for (const tool of tools) {
      const name = asStr(get(tool, 'name'))
      if (name === undefined) continue
      chatTools.push({
        type: 'function',
        function: {
          name,
          description: asStr(get(tool, 'description')) ?? '',
          parameters: orElse(get(tool, 'input_schema'), {}),
        },
      })
    }
    if (chatTools.length > 0) result['tools'] = chatTools
  }

  // `max_tokens` is deliberately not forwarded (commented out in the Rust).
  for (const key of ['temperature', 'top_p', 'top_k', 'frequency_penalty', 'presence_penalty']) {
    const val = get(body, key)
    if (val !== undefined) result[key] = val
  }
  const stop = get(body, 'stop_sequences')
  if (stop !== undefined) result['stop'] = stop

  return result
}

/** `convert_messages` */
function convertMessages(anthMessages: JsonValue, system: JsonValue | undefined): JsonObject[] | null {
  if (!Array.isArray(anthMessages)) return null
  const out: JsonObject[] = []

  if (typeof system === 'string') {
    out.push({ role: 'system', content: system })
  } else if (Array.isArray(system)) {
    const text = joinTexts(system)
    if (text !== '') out.push({ role: 'system', content: text })
  }

  for (const msg of anthMessages) {
    // A message without a string role, or without content, fails the whole request.
    const role = asStr(get(msg, 'role'))
    if (role === undefined) return null
    const content = get(msg, 'content')
    if (content === undefined) return null

    if (typeof content === 'string') {
      if (role === 'user' || role === 'assistant' || role === 'system' || role === 'developer') {
        out.push({ role, content })
      }
      continue
    }
    if (!Array.isArray(content)) return null

    switch (role) {
      case 'assistant': {
        const parts: JsonObject[] = []
        const toolCalls: JsonValue[] = []
        for (const block of content) {
          const type = asStr(get(block, 'type')) ?? ''
          if (type === 'text') {
            const text = asStr(get(block, 'text'))
            if (text !== undefined) parts.push({ type: 'text', text })
          } else if (type === 'tool_use') {
            const id = asStr(get(block, 'id'))
            const name = asStr(get(block, 'name'))
            const input = get(block, 'input')
            if (id !== undefined && name !== undefined && input !== undefined) {
              toolCalls.push({ id, type: 'function', function: { name, arguments: serdeToString(input) } })
            }
          } else {
            convertMediaBlock(block, parts)
          }
        }
        const msgObj: JsonObject = { role: 'assistant' }
        if (toolCalls.length === 0) {
          msgObj['content'] = textPartsToContent(parts)
        } else {
          msgObj['content'] = parts.length === 0 ? null : textPartsToContent(parts)
          msgObj['tool_calls'] = toolCalls
        }
        out.push(msgObj)
        break
      }
      case 'user': {
        const parts: JsonObject[] = []
        const toolResults: Array<[string, string]> = []
        for (const block of content) {
          const type = asStr(get(block, 'type')) ?? ''
          if (type === 'tool_result') {
            toolResults.push([
              asStr(get(block, 'tool_use_id')) ?? '',
              extractToolResultContent(get(block, 'content')),
            ])
          } else if (type === 'text') {
            const text = asStr(get(block, 'text'))
            if (text !== undefined) parts.push({ type: 'text', text })
          } else {
            convertMediaBlock(block, parts)
          }
        }
        // Tool results go first: they answer the previous assistant turn's tool calls, whatever
        // order the blocks came in.
        for (const [toolCallId, result] of toolResults) {
          out.push({ role: 'tool', tool_call_id: toolCallId, content: result })
        }
        if (parts.length > 0) out.push({ role: 'user', content: textPartsToContent(parts) })
        break
      }
      case 'system':
      case 'developer':
        out.push({ role, content: joinTexts(content) })
        break
      default:
        break
    }
  }
  return out
}

/** The `text` strings of the blocks that have one, joined with `\n`. */
function joinTexts(blocks: JsonValue[]): string {
  const texts: string[] = []
  for (const b of blocks) {
    const t = asStr(get(b, 'text'))
    if (t !== undefined) texts.push(t)
  }
  return texts.join('\n')
}

/** `text_parts_to_content`: `""` for none, a bare string for one text part, parts otherwise. */
function textPartsToContent(parts: JsonObject[]): JsonValue {
  if (parts.length === 0) return ''
  const [first] = parts
  if (parts.length === 1 && first !== undefined && get(first, 'type') === 'text') {
    return asStr(get(first, 'text')) ?? ''
  }
  return parts
}

/** `convert_media_block`: base64 images become data URLs; any other block with `text` is kept. */
function convertMediaBlock(block: JsonValue, parts: JsonObject[]): void {
  const type = asStr(get(block, 'type')) ?? ''
  if (type === 'image') {
    const source = get(block, 'source')
    if (source === undefined) return
    const data = asStr(get(source, 'data'))
    // `source.get("media_type").or(block.get("media_type"))`: the fallback applies only when the
    // key is missing from `source`, not when it is present but not a string.
    const mediaType = asStr(orElseOptional(get(source, 'media_type'), get(block, 'media_type')))
    if (data !== undefined && mediaType !== undefined) {
      parts.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } })
    }
    return
  }
  const text = asStr(get(block, 'text'))
  if (text !== undefined) parts.push({ type: 'text', text })
}

function orElseOptional(
  value: JsonValue | undefined,
  fallback: JsonValue | undefined
): JsonValue | undefined {
  return value === undefined ? fallback : value
}

/** `extract_tool_result_content` */
function extractToolResultContent(content: JsonValue | undefined): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const texts: string[] = []
    for (const b of content) {
      if (get(b, 'type') !== 'text') continue
      const t = asStr(get(b, 'text'))
      if (t !== undefined) texts.push(t)
    }
    return texts.join('\n')
  }
  // Objects, numbers, booleans and an explicit `null` are serialised (`null` → "null").
  return serdeToString(content)
}

/**
 * `responses_shim::merge_system_messages`: every system/developer message collapses into a single
 * leading system message (non-empty texts joined with a blank line); the rest keep their order.
 */
function mergeSystemMessages(messages: JsonObject[]): JsonObject[] {
  const systemParts: string[] = []
  const rest: JsonObject[] = []
  for (const msg of messages) {
    const role = asStr(get(msg, 'role')) ?? ''
    if (role === 'system' || role === 'developer') {
      const text = flattenContentToText(get(msg, 'content'))
      if (text !== '') systemParts.push(text)
    } else {
      rest.push(msg)
    }
  }
  if (systemParts.length === 0) return rest
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest]
}

/** `responses_shim::flatten_content_to_text`: array part texts are concatenated with no separator. */
function flattenContentToText(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let buf = ''
    for (const part of content) buf += asStr(get(part, 'text')) ?? ''
    return buf
  }
  return ''
}

// ── non-streaming response ───────────────────────────────────────────────────────────────────────

/** `transform_openai_response_to_anthropic` */
export function chatResponseToAnthropic(chat: JsonValue): JsonValue {
  const choices = get(chat, 'choices')
  const choice = Array.isArray(choices) ? choices[0] : undefined
  const message = get(choice, 'message')

  const content: JsonValue[] = []
  const text = asStr(get(message, 'content'))
  if (text !== undefined && text !== '') content.push({ type: 'text', text })

  const toolCalls = get(message, 'tool_calls')
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const fn = get(tc, 'function')
      const args = asStr(get(fn, 'arguments')) ?? '{}'
      let input: JsonValue
      try {
        input = JSON.parse(args) as JsonValue
      } catch {
        // Arguments the model left as broken JSON become an empty input rather than an error.
        input = {}
      }
      content.push({
        type: 'tool_use',
        id: asStr(get(tc, 'id')) ?? '',
        name: asStr(get(fn, 'name')) ?? '',
        input,
      })
    }
  }

  return {
    id: orElse(get(chat, 'id'), ''),
    type: 'message',
    role: 'assistant',
    content,
    model: orElse(get(chat, 'model'), ''),
    stop_reason: stopReason(asStr(get(choice, 'finish_reason')) ?? 'end_turn'),
    stop_sequence: null,
    usage: orElse(get(chat, 'usage'), { input_tokens: 0, output_tokens: 0 }),
  }
}

// ── streaming ────────────────────────────────────────────────────────────────────────────────────

/**
 * `transform_and_forward_stream`: raw Chat Completions SSE bytes in (as network reads arrive),
 * Anthropic stream events out. `onNetworkChunk` returns the event payloads produced by that read;
 * the wire name of each is its `type`. `done` turns true once the stream has been closed with
 * `message_stop`, after which further reads produce nothing.
 *
 * One deliberate divergence from the Rust: it split every network read into lines on its own, so a
 * `data:` line cut across two reads was parsed as two invalid halves and dropped. Here an
 * unterminated trailing line is held until the read that completes it, and `finish()` — called when
 * the upstream body ends — processes whatever is still held. Without it, a final `data: [DONE]` that
 * arrives with no newline would never close the message, and the client would wait for a
 * `message_stop` that never comes; the Rust handled that case because it did not buffer.
 */
export class AnthropicStreamConverter {
  private pending = ''
  private finished = false
  private isFirst = true
  private accumulated = ''
  private textBlockIndex: number | undefined
  /** Chat tool-call index → Anthropic content block index. */
  private readonly toolBlocks = new Map<number, number>()
  private nextBlockIndex = 0

  get done(): boolean {
    return this.finished
  }

  onNetworkChunk(text: string): JsonValue[] {
    const events: JsonValue[] = []
    if (this.finished) return events
    this.pending += text
    const lastNewline = this.pending.lastIndexOf('\n')
    if (lastNewline < 0) return events
    const complete = this.pending.slice(0, lastNewline)
    this.pending = this.pending.slice(lastNewline + 1)
    for (const raw of complete.split('\n')) {
      // `str::lines` also accepts `\r\n` endings.
      this.onLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw, events)
      if (this.finished) {
        this.pending = ''
        break
      }
    }
    return events
  }

  /**
   * The upstream body ended. Process a final line that arrived without a newline; emit nothing else.
   * A stream that ends without `[DONE]` or a finish reason still gets no closing events here, exactly
   * as in the Rust — a truncated response is not reported as a finished one.
   */
  finish(): JsonValue[] {
    const events: JsonValue[] = []
    if (this.finished || this.pending === '') return events
    const tail = this.pending
    this.pending = ''
    this.onLine(tail.endsWith('\r') ? tail.slice(0, -1) : tail, events)
    return events
  }

  private onLine(line: string, events: JsonValue[]): void {
    if (!line.startsWith('data:')) return
    // `trim_start_matches` strips the prefix repeatedly, not once.
    let rest = line
    while (rest.startsWith('data:')) rest = rest.slice('data:'.length)
    const data = rustTrim(rest)

    if (data === '[DONE]') {
      this.closeOpenBlocks(events)
      this.closeMessage(this.toolBlocks.size === 0 ? 'end_turn' : 'tool_use', events)
      return
    }

    let chunk: JsonValue
    try {
      chunk = JSON.parse(data) as JsonValue
    } catch {
      return
    }

    const choices = get(chunk, 'choices')
    const choice = Array.isArray(choices) ? choices[0] : undefined
    // An explicit `"delta": null` still counts as a delta.
    const delta = get(choice, 'delta')
    if (delta === undefined) return
    const finishReason = get(choice, 'finish_reason')

    if (this.isFirst) {
      events.push({
        type: 'message_start',
        message: {
          id: orElse(get(chunk, 'id'), ''),
          type: 'message',
          role: asStr(get(delta, 'role')) ?? 'assistant',
          content: [],
          model: orElse(get(chunk, 'model'), ''),
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      })
      this.isFirst = false
    }

    const text = asStr(get(delta, 'content'))
    if (text !== undefined && text !== '') {
      if (this.textBlockIndex === undefined) {
        this.textBlockIndex = this.nextBlockIndex++
        events.push({
          type: 'content_block_start',
          index: this.textBlockIndex,
          content_block: { type: 'text', text: '' },
        })
      }
      this.accumulated += text
      events.push({
        type: 'content_block_delta',
        index: this.textBlockIndex,
        delta: { type: 'text_delta', text },
      })
    }

    const toolCalls = get(delta, 'tool_calls')
    if (Array.isArray(toolCalls)) {
      // Even an empty `tool_calls` array closes the text block.
      this.closeTextBlock(events)
      for (const tc of toolCalls) {
        const rawIndex = get(tc, 'index')
        // `as_u64().unwrap_or(0)`: anything but a non-negative integer counts as index 0.
        const tcIndex =
          typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 ? rawIndex : 0
        const fn = get(tc, 'function')

        const id = asStr(get(tc, 'id'))
        if (id !== undefined) {
          const idx = this.nextBlockIndex++
          // A repeated id for the same index replaces the mapping; the earlier block is never closed.
          this.toolBlocks.set(tcIndex, idx)
          events.push({
            type: 'content_block_start',
            index: idx,
            content_block: { type: 'tool_use', id, name: asStr(get(fn, 'name')) ?? '', input: {} },
          })
        }

        const args = asStr(get(fn, 'arguments'))
        const idx = this.toolBlocks.get(tcIndex)
        if (args !== undefined && args !== '' && idx !== undefined) {
          events.push({
            type: 'content_block_delta',
            index: idx,
            delta: { type: 'input_json_delta', partial_json: args },
          })
        }
      }
    }

    if (finishReason !== undefined && finishReason !== null) {
      this.closeOpenBlocks(events)
      this.closeMessage(stopReason(asStr(finishReason) ?? 'end_turn'), events)
    }
  }

  private closeTextBlock(events: JsonValue[]): void {
    if (this.textBlockIndex === undefined) return
    events.push({ type: 'content_block_stop', index: this.textBlockIndex })
    this.textBlockIndex = undefined
  }

  private closeOpenBlocks(events: JsonValue[]): void {
    this.closeTextBlock(events)
    for (const idx of [...this.toolBlocks.values()].sort((a, b) => a - b)) {
      events.push({ type: 'content_block_stop', index: idx })
    }
  }

  private closeMessage(reason: string, events: JsonValue[]): void {
    events.push({
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      // Not a token count: the Rust reports the whitespace-separated word count of the text.
      usage: { output_tokens: wordCount(this.accumulated) },
    })
    events.push({ type: 'message_stop' })
    this.finished = true
  }
}
