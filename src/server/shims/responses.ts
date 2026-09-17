/**
 * OpenAI Responses API → Chat Completions, for local engines that only speak Chat Completions.
 *
 * Codex CLI (and any other Responses-only client) sends `/v1/responses`; the llama.cpp backends
 * implement only `/v1/chat/completions`. This module converts the request one way and the reply —
 * single-shot JSON or a stream of chunks — back into Responses objects and events.
 *
 * Ported from: src-tauri/src/core/server/responses_shim.rs. Contract: test/fixtures/app/responses-shim.
 *
 * Porting notes (where JS and serde_json differ and the port has to work to stay identical):
 * - `Value::get` answers only for objects and only for keys that are present; a key present with
 *   `null` is *present*. `field()` below is that lookup, and the code distinguishes `undefined`
 *   (absent) from `null` exactly where Rust distinguishes `None` from `Some(Null)`.
 * - `as_u64` accepts only non-negative integers; `serdeToString` reproduces `Value::to_string()`
 *   (sorted keys, ryu float formatting) for the one place a value is serialised into text.
 */

import { randomUUID } from 'node:crypto'
import type { JsonObject, JsonValue } from './json.js'
import { isJsonObject, serdeToString } from './json.js'

function uuidSimple(): string {
  return randomUUID().replace(/-/g, '')
}

/** `new_response_id`: `resp_<32 hex>`. */
export function newResponseId(): string {
  return `resp_${uuidSimple()}`
}

function newMessageId(): string {
  return `msg_${uuidSimple()}`
}

function newFcId(): string {
  return `fc_${uuidSimple()}`
}

/** serde_json `Value::get(key)`: `undefined` unless `value` is an object that has `key` (even as null). */
function field(value: JsonValue | undefined, key: string): JsonValue | undefined {
  if (value === undefined || !isJsonObject(value) || !Object.hasOwn(value, key)) return undefined
  return value[key]
}

function asStr(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * serde_json `as_u64`: only a non-negative integer. `-0` is excluded because serde_json parses `-0`
 * as the float `-0.0`. A float literal with an integral value (`3.0`) cannot be told apart from `3`
 * once JSON.parse has run, so it is accepted here where Rust would refuse it.
 */
function asU64(value: JsonValue | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || Object.is(value, -0)) {
    return undefined
  }
  return value
}

function clone(value: JsonValue): JsonValue {
  return structuredClone(value)
}

/** Convert a Responses API request body into a Chat Completions request body. */
export function responsesRequestToChat(body: JsonValue): JsonValue {
  const messages: JsonValue[] = []

  // `instructions` (the system prompt in the Responses API) becomes a leading system message.
  const instructions = asStr(field(body, 'instructions'))
  if (instructions !== undefined && instructions !== '') {
    messages.push({ role: 'system', content: instructions })
  }

  const input = field(body, 'input')
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input })
  } else if (Array.isArray(input)) {
    for (const item of input) {
      const msg = responsesInputItemToChat(item)
      if (msg !== undefined) messages.push(msg)
    }
  }

  const out: JsonObject = { messages: mergeSystemMessages(messages) }

  const model = field(body, 'model')
  if (model !== undefined) out['model'] = clone(model)
  const stream = field(body, 'stream')
  if (stream !== undefined) {
    out['stream'] = clone(stream)
    // Ask the backend for a usage block on the final streamed chunk so `response.completed` can
    // carry `usage`. Only a literal `true` asks; a present-but-false/null `stream` is still copied.
    if (stream === true) out['stream_options'] = { include_usage: true }
  }
  const temperature = field(body, 'temperature')
  if (temperature !== undefined) out['temperature'] = clone(temperature)
  const topP = field(body, 'top_p')
  if (topP !== undefined) out['top_p'] = clone(topP)
  // Responses caps output with `max_output_tokens`; Chat uses `max_tokens`.
  const maxOutputTokens = field(body, 'max_output_tokens')
  if (maxOutputTokens !== undefined) out['max_tokens'] = clone(maxOutputTokens)
  const parallelToolCalls = field(body, 'parallel_tool_calls')
  if (parallelToolCalls !== undefined) out['parallel_tool_calls'] = clone(parallelToolCalls)

  const tools = field(body, 'tools')
  if (Array.isArray(tools)) {
    const chatTools = tools.map(responsesToolToChat).filter((t): t is JsonValue => t !== undefined)
    if (chatTools.length > 0) out['tools'] = chatTools
  }
  const toolChoice = field(body, 'tool_choice')
  if (toolChoice !== undefined) out['tool_choice'] = responsesToolChoiceToChat(toolChoice)

  // Structured output: Responses `text.format` -> Chat `response_format`.
  const format = field(field(body, 'text'), 'format')
  if (format !== undefined) {
    const responseFormat = responsesTextFormatToChat(format)
    if (responseFormat !== undefined) out['response_format'] = responseFormat
  }

  return out
}

/**
 * Collapse every `system`/`developer` message into a single leading `system` message, joined by a
 * blank line; messages whose flattened text is empty contribute nothing, and if nothing remains no
 * system message is emitted. Strict chat templates (notably Qwen3-family GGUFs) raise "System
 * message must be at the beginning" when a request carries more than one system message or places
 * one after the first turn — which Codex does by combining `instructions` with developer/system
 * input items. Order of the other messages is preserved.
 */
export function mergeSystemMessages(messages: JsonValue[]): JsonValue[] {
  const systemParts: string[] = []
  const rest: JsonValue[] = []

  for (const msg of messages) {
    const role = asStr(field(msg, 'role')) ?? ''
    if (role === 'system' || role === 'developer') {
      const text = flattenContentToText(field(msg, 'content'))
      if (text !== '') systemParts.push(text)
    } else {
      rest.push(msg)
    }
  }

  if (systemParts.length === 0) return rest
  return [{ role: 'system', content: systemParts.join('\n\n') }, ...rest]
}

function responsesInputItemToChat(item: JsonValue): JsonValue | undefined {
  const type = asStr(field(item, 'type')) ?? 'message'
  switch (type) {
    case 'message': {
      const role = asStr(field(item, 'role')) ?? 'user'
      return { role, content: flattenContentToText(field(item, 'content')) }
    }
    case 'function_call': {
      const name = asStr(field(item, 'name')) ?? ''
      const args = asStr(field(item, 'arguments')) ?? '{}'
      // Rust: `get("call_id").or_else(|| get("id"))` — the fallback to `id` happens only when
      // `call_id` is absent; a present non-string `call_id` (e.g. null) yields "" instead.
      // (Not `??`: that would also fall through on a present null.)
      const rawCallId = field(item, 'call_id')
      const callId = asStr(rawCallId !== undefined ? rawCallId : field(item, 'id')) ?? ''
      return {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }],
      }
    }
    case 'function_call_output': {
      const callId = asStr(field(item, 'call_id')) ?? ''
      const output = field(item, 'output')
      const content = output === undefined ? '' : typeof output === 'string' ? output : serdeToString(output)
      return { role: 'tool', tool_call_id: callId, content }
    }
    // Reasoning items (and any other Responses-only item) have no Chat Completions equivalent;
    // they are dropped from the replayed conversation.
    default:
      return undefined
  }
}

/**
 * Flatten Responses content (a string, or an array of typed parts) to plain text: every part's
 * string `text` is concatenated regardless of the part's type; parts without one (images, files)
 * are skipped. Anything else yields "".
 */
export function flattenContentToText(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    let buf = ''
    for (const part of content) {
      const text = asStr(field(part, 'text'))
      if (text !== undefined) buf += text
    }
    return buf
  }
  return ''
}

function responsesToolToChat(tool: JsonValue): JsonValue | undefined {
  // A Responses function tool is flat: {type, name, description, parameters}. Built-in tools
  // (web_search, etc.) have no Chat equivalent and are dropped, as is a function without `name`.
  if (asStr(field(tool, 'type')) !== 'function') return undefined
  const name = field(tool, 'name')
  if (name === undefined) return undefined
  const func: JsonObject = { name: clone(name) }
  const description = field(tool, 'description')
  if (description !== undefined) func['description'] = clone(description)
  const parameters = field(tool, 'parameters')
  if (parameters !== undefined) func['parameters'] = clone(parameters)
  return { type: 'function', function: func }
}

function responsesToolChoiceToChat(toolChoice: JsonValue): JsonValue {
  // "auto" | "none" | "required" pass through unchanged.
  if (typeof toolChoice === 'string') return toolChoice
  if (isJsonObject(toolChoice)) {
    const name = asStr(field(toolChoice, 'name'))
    return name !== undefined ? { type: 'function', function: { name } } : clone(toolChoice)
  }
  return 'auto'
}

function responsesTextFormatToChat(format: JsonValue): JsonValue | undefined {
  switch (asStr(field(format, 'type'))) {
    case 'json_schema': {
      const jsonSchema: JsonObject = {}
      for (const key of ['name', 'schema', 'strict']) {
        const v = field(format, key)
        if (v !== undefined) jsonSchema[key] = clone(v)
      }
      return { type: 'json_schema', json_schema: jsonSchema }
    }
    case 'json_object':
      return { type: 'json_object' }
    default:
      return undefined
  }
}

/** Map a Chat Completions `usage` block to the Responses `usage` shape. */
function mapUsage(usage: JsonValue): JsonValue {
  const input = asU64(field(usage, 'prompt_tokens')) ?? 0
  const output = asU64(field(usage, 'completion_tokens')) ?? 0
  const total = asU64(field(usage, 'total_tokens')) ?? input + output
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: total,
  }
}

/** Build the `output` array (assistant message, then function_call items) from a Chat message. */
function messageToOutputItems(message: JsonValue | undefined): JsonValue[] {
  const output: JsonValue[] = []
  if (message === undefined) return output

  const text = asStr(field(message, 'content'))
  if (text !== undefined && text !== '') {
    output.push({
      type: 'message',
      id: newMessageId(),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text, annotations: [] }],
    })
  }

  const toolCalls = field(message, 'tool_calls')
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const fn = field(tc, 'function')
      // `name` is cloned whatever its type (a numeric name stays a number); `arguments` must be a string.
      const name = field(fn, 'name')
      output.push({
        type: 'function_call',
        id: newFcId(),
        call_id: asStr(field(tc, 'id')) ?? '',
        name: name === undefined ? '' : clone(name),
        arguments: asStr(field(fn, 'arguments')) ?? '',
        status: 'completed',
      })
    }
  }

  return output
}

/**
 * Convert a non-streaming Chat Completions response into a Responses object. Only the first choice
 * is used, `finish_reason` is ignored (status is always "completed"), and a present `usage` — even
 * `null` — is mapped, so `usage: null` becomes an all-zero usage block; only an absent one is null.
 */
export function chatResponseToResponses(
  chat: JsonValue,
  responseId: string,
  modelFallback: string
): JsonValue {
  const model = asStr(field(chat, 'model')) ?? modelFallback
  const created = asU64(field(chat, 'created')) ?? 0

  const choices = field(chat, 'choices')
  const first = Array.isArray(choices) ? choices[0] : undefined
  const message = field(first, 'message')

  const output = messageToOutputItems(message)
  const usage = field(chat, 'usage')

  return {
    id: responseId,
    object: 'response',
    created_at: created,
    status: 'completed',
    model,
    output,
    usage: usage === undefined ? null : mapUsage(usage),
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
  }
}

interface ToolAcc {
  itemId: string
  outputIndex: number
  callId: string
  name: string
  args: string
  added: boolean
}

/**
 * Stateful converter from a Chat Completions chunk stream to the Responses event protocol. Feed each
 * parsed Chat `data:` chunk to `onChunk` and emit the returned events; call `finish` when the stream
 * ends (`[DONE]` or a dropped upstream).
 *
 * Emits the sequence Codex consumes: `response.created`, per-item `response.output_item.added` /
 * `response.output_text.delta` / `response.function_call_arguments.delta`, the matching `*.done`
 * events, and a terminal `response.completed` carrying the full `output` and `usage`.
 * `sequence_number` is contiguous from 0 across every event this instance emits.
 */
export class ResponsesStreamConverter {
  private readonly responseId: string
  private readonly model: string
  private seq = 0
  private nextOutputIndex = 0
  // assistant text message item
  private msgItemId: string | undefined = undefined
  private msgOutputIndex = 0
  private text = ''
  // tool calls keyed by the Chat `tool_calls[].index`
  private tools = new Map<number, ToolAcc>()

  constructor(responseId: string, model: string) {
    this.responseId = responseId
    this.model = model
  }

  private nextSeq(): number {
    return this.seq++
  }

  private responseEnvelope(status: string, output: JsonValue[], usage: JsonValue): JsonValue {
    return {
      id: this.responseId,
      object: 'response',
      status,
      model: this.model,
      output,
      usage,
      parallel_tool_calls: true,
      tool_choice: 'auto',
      tools: [],
    }
  }

  /** The opening `response.created` event. Send once, before any chunk. */
  createdEvent(): JsonValue {
    return {
      type: 'response.created',
      sequence_number: this.nextSeq(),
      response: this.responseEnvelope('in_progress', [], null),
    }
  }

  /**
   * Events for one Chat chunk. Only `choices[0].delta` is read: non-empty string `content` and
   * `tool_calls`. Everything else (reasoning_content, finish_reason, usage, error objects) yields
   * nothing — usage is the caller's to pass to `finish`.
   */
  onChunk(chunk: JsonValue): JsonValue[] {
    const events: JsonValue[] = []
    const choices = field(chunk, 'choices')
    if (!Array.isArray(choices) || choices.length === 0) return events
    const delta = field(choices[0], 'delta')
    if (delta === undefined) return events

    const text = asStr(field(delta, 'content'))
    if (text !== undefined && text !== '') {
      if (this.msgItemId === undefined) {
        const itemId = newMessageId()
        const outputIndex = this.nextOutputIndex++
        this.msgItemId = itemId
        this.msgOutputIndex = outputIndex
        events.push({
          type: 'response.output_item.added',
          sequence_number: this.nextSeq(),
          output_index: outputIndex,
          item: { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] },
        })
        events.push({
          type: 'response.content_part.added',
          sequence_number: this.nextSeq(),
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        })
      }
      this.text += text
      events.push({
        type: 'response.output_text.delta',
        sequence_number: this.nextSeq(),
        item_id: this.msgItemId,
        output_index: this.msgOutputIndex,
        content_index: 0,
        delta: text,
      })
    }

    const toolCalls = field(delta, 'tool_calls')
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const index = asU64(field(tc, 'index')) ?? 0
        let acc = this.tools.get(index)
        if (acc === undefined) {
          acc = {
            itemId: newFcId(),
            outputIndex: this.nextOutputIndex++,
            callId: '',
            name: '',
            args: '',
            added: false,
          }
          this.tools.set(index, acc)
        }
        // A later non-empty id replaces the earlier one; name fragments accumulate.
        const id = asStr(field(tc, 'id'))
        if (id !== undefined && id !== '') acc.callId = id
        const fn = field(tc, 'function')
        const name = asStr(field(fn, 'name'))
        if (name !== undefined && name !== '') acc.name += name

        // `added` is emitted on the first delta for this index and snapshots call_id/name as known
        // at that moment — possibly empty; the final values only appear in the `done` item.
        if (!acc.added) {
          acc.added = true
          events.push({
            type: 'response.output_item.added',
            sequence_number: this.nextSeq(),
            output_index: acc.outputIndex,
            item: {
              type: 'function_call',
              id: acc.itemId,
              status: 'in_progress',
              call_id: acc.callId,
              name: acc.name,
              arguments: '',
            },
          })
        }

        const args = asStr(field(fn, 'arguments'))
        if (args !== undefined && args !== '') {
          acc.args += args
          events.push({
            type: 'response.function_call_arguments.delta',
            sequence_number: this.nextSeq(),
            item_id: acc.itemId,
            output_index: acc.outputIndex,
            delta: args,
          })
        }
      }
    }

    return events
  }

  /**
   * Closing events: the message item's `*.done` events, then each tool call's (in Chat `index`
   * order), then `response.completed` whose `output` is sorted by output_index. `usage` absent →
   * `null` in the envelope; present (even `null`) → mapped, like the non-streaming path.
   */
  finish(usage?: JsonValue): JsonValue[] {
    const events: JsonValue[] = []
    const items: Array<{ outputIndex: number; item: JsonValue }> = []

    if (this.msgItemId !== undefined) {
      const itemId = this.msgItemId
      const outputIndex = this.msgOutputIndex
      const text = this.text
      events.push({
        type: 'response.output_text.done',
        sequence_number: this.nextSeq(),
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        text,
      })
      events.push({
        type: 'response.content_part.done',
        sequence_number: this.nextSeq(),
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      })
      const item = (): JsonValue => ({
        type: 'message',
        id: itemId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [] }],
      })
      events.push({
        type: 'response.output_item.done',
        sequence_number: this.nextSeq(),
        output_index: outputIndex,
        item: item(),
      })
      items.push({ outputIndex, item: item() })
    }

    // Rust takes the tool map (`mem::take`), so a second `finish` re-closes the message but no tools.
    const tools = [...this.tools.entries()].sort(([a], [b]) => a - b).map(([, acc]) => acc)
    this.tools = new Map()
    for (const acc of tools) {
      events.push({
        type: 'response.function_call_arguments.done',
        sequence_number: this.nextSeq(),
        item_id: acc.itemId,
        output_index: acc.outputIndex,
        arguments: acc.args,
      })
      const item = (): JsonValue => ({
        type: 'function_call',
        id: acc.itemId,
        status: 'completed',
        call_id: acc.callId,
        name: acc.name,
        arguments: acc.args,
      })
      events.push({
        type: 'response.output_item.done',
        sequence_number: this.nextSeq(),
        output_index: acc.outputIndex,
        item: item(),
      })
      items.push({ outputIndex: acc.outputIndex, item: item() })
    }

    // Stable sort, as Rust's `sort_by_key`.
    items.sort((a, b) => a.outputIndex - b.outputIndex)
    const output = items.map((entry) => entry.item)

    events.push({
      type: 'response.completed',
      sequence_number: this.nextSeq(),
      response: this.responseEnvelope('completed', output, usage === undefined ? null : mapUsage(usage)),
    })

    return events
  }
}
