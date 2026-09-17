/**
 * Chat Completions → OpenAI Responses API, for the ChatGPT subscription route whose upstream only
 * speaks Responses.
 *
 * The mirror of `responses.ts`: that one exists because Codex speaks only Responses and the local
 * backends speak only Chat Completions; this one exists because the ChatGPT subscription backend
 * (`https://chatgpt.com/backend-api/codex/responses`) speaks only Responses while our own clients
 * speak Chat Completions.
 *
 * Ported from: src-tauri/src/core/server/chat_to_responses_shim.rs.
 * Contract: test/fixtures/app/chat-to-responses-shim.
 *
 * Presence semantics follow serde_json exactly: `get` distinguishes a missing key from a key holding
 * `null`, and a string/array accessor on the wrong type behaves like `as_str()` / `as_array()`
 * returning `None`.
 */

import { createHash, randomUUID } from 'node:crypto'
import { isJsonObject, serdeToString } from './json.js'
import type { JsonObject, JsonValue } from './json.js'

/**
 * Prepended to every request's `instructions`. The endpoint is Codex's, and its models otherwise
 * assume a coding-agent harness that is not us.
 */
export const COMPATIBILITY_INSTRUCTIONS =
  "You are operating inside Atomic Chat. Follow the user's instructions, " +
  'use only tools supplied in this request, and return concise, accurate results.'

/** The Responses API caps ids at 64 characters (bytes, as Rust counts them). */
const MAX_CALL_ID_LEN = 64

const DEFAULT_FAILURE_MESSAGE = 'the ChatGPT backend reported a failure'

// ── serde_json-shaped accessors ──────────────────────────────────────────────

/** `Value::get(key)`: `undefined` when `value` is not an object or lacks the key (own keys only). */
function get(value: JsonValue | undefined, key: string): JsonValue | undefined {
  if (value === undefined || !isJsonObject(value)) return undefined
  return Object.hasOwn(value, key) ? value[key] : undefined
}

function asStr(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asArray(value: JsonValue | undefined): JsonValue[] | undefined {
  return Array.isArray(value) ? value : undefined
}

/** `as_u64()`: only a non-negative integer qualifies (`-3`, `"2"` and `1.5` do not). */
function asU64(value: JsonValue | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return undefined
  return value === 0 ? 0 : value // folds -0
}

/** An object built key by key without `__proto__` turning into a prototype assignment. */
function objectFrom(entries: Iterable<readonly [string, JsonValue]>): JsonObject {
  return Object.fromEntries(entries) as JsonObject
}

/** `flatten_content_to_text` from the Rust responses shim: a string, or the concatenated part texts. */
function flattenContentToText(content: JsonValue | undefined): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => asStr(get(part, 'text')) ?? '').join('')
  return ''
}

// ── ids ──────────────────────────────────────────────────────────────────────

function uuidSimple(): string {
  return randomUUID().replace(/-/g, '')
}

export function newChatCompletionId(): string {
  return `chatcmpl-${uuidSimple()}`
}

function newCallId(): string {
  return `call_${uuidSimple()}`
}

/**
 * A call id the Responses API will accept, preserving the original when it already fits. An
 * over-long id is truncated with a digest tail so two different ids can never collapse onto one:
 * the first 31 bytes, `_`, then the first 16 bytes of SHA-256 over the whole id as hex (64 total).
 *
 * Lengths are UTF-8 bytes, as Rust's `str::len`. Rust slices `&value[..31]`, which panics when byte
 * 31 falls inside a multi-byte character; this throws in the same situation rather than inventing
 * a different id the Rust side would never have produced.
 */
export function responsesCallId(value: string): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length <= MAX_CALL_ID_LEN) return value
  // Deliberate divergence from Rust: `&value[..31]` panics when byte 31 falls inside a multi-byte
  // character, failing the whole request for any non-ASCII tool-call id over 64 bytes. The cut
  // backs off to the previous character boundary instead. No id Rust ever produced can differ —
  // Rust produced none for these inputs — and the result still fits: ≤31 bytes + `_` + 32 hex.
  let cut = 31
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) cut--
  const hex = createHash('sha256').update(bytes).digest('hex').slice(0, 32)
  return `${new TextDecoder().decode(bytes.subarray(0, cut))}_${hex}`
}

// ── request ──────────────────────────────────────────────────────────────────

/**
 * Convert a Chat Completions request body into a Responses request body.
 *
 * `stream` and `store` are forced rather than copied: the subscription endpoint only streams, and
 * we never want our conversations retained server-side. A client's own `stream: false` is honoured
 * by aggregating on the way back ({@link ChatChunkStreamConverter.intoChatCompletion}).
 */
export function chatRequestToResponses(body: JsonValue, promptCacheKey: string): JsonValue {
  const instructions: string[] = [COMPATIBILITY_INSTRUCTIONS]
  const input: JsonValue[] = []
  const assistantIndex = { value: 0 }

  for (const message of asArray(get(body, 'messages')) ?? []) {
    const role = asStr(get(message, 'role')) ?? 'user'
    // Responses carries the system prompt out-of-band, so every system/developer turn is hoisted
    // into `instructions` in order.
    if (role === 'system' || role === 'developer') {
      const text = flattenContentToText(get(message, 'content'))
      if (text !== '') instructions.push(text)
      continue
    }
    input.push(...chatMessageToResponsesItems(message, assistantIndex))
  }

  const out: JsonObject = {}
  const model = get(body, 'model')
  if (model !== undefined) out['model'] = model
  out['instructions'] = instructions.join('\n\n')
  out['input'] = input
  out['stream'] = true
  out['store'] = false
  // Keeps the reasoning item replayable on the next turn, which is what lets a tool-calling
  // conversation continue coherently.
  out['include'] = ['reasoning.encrypted_content']
  out['prompt_cache_key'] = promptCacheKey
  out['parallel_tool_calls'] = true

  const text: JsonObject = { verbosity: 'low' }
  const responseFormat = get(body, 'response_format')
  const format = responseFormat === undefined ? undefined : chatResponseFormatToText(responseFormat)
  if (format !== undefined) text['format'] = format
  out['text'] = text

  // NOT sent: `max_output_tokens`, `temperature`, `top_p`. The Codex Responses endpoint rejects the
  // token cap the public Responses API accepts, and the sampling knobs are not part of its contract;
  // forwarding any of them fails the request outright.

  const effort = asStr(get(body, 'reasoning_effort'))
  if (effort !== undefined && effort !== '') out['reasoning'] = { effort, summary: 'auto' }

  const tools = asArray(get(body, 'tools'))
  if (tools !== undefined) {
    const converted = tools.map(chatToolToResponses).filter((t): t is JsonObject => t !== undefined)
    if (converted.length > 0) out['tools'] = converted
  }
  const toolChoice = get(body, 'tool_choice')
  out['tool_choice'] = toolChoice === undefined ? 'auto' : chatToolChoiceToResponses(toolChoice)

  return out
}

/**
 * One Chat message becomes zero or more Responses input items: an assistant turn carrying both text
 * and tool calls is two items, and a `tool` result is a `function_call_output`.
 *
 * `assistantIndex` numbers the replayed assistant messages (`msg_atomic_N`) across one request and
 * is advanced only when an assistant message item is actually emitted.
 */
export function chatMessageToResponsesItems(
  message: JsonValue,
  assistantIndex: { value: number }
): JsonValue[] {
  const role = asStr(get(message, 'role')) ?? 'user'

  if (role === 'tool') {
    const toolCallId = asStr(get(message, 'tool_call_id'))
    const content = get(message, 'content')
    // A non-string content (including an explicit `null`) is sent as its JSON text.
    const output = typeof content === 'string' ? content : content === undefined ? '' : serdeToString(content)
    return [
      {
        type: 'function_call_output',
        call_id: toolCallId === undefined ? '' : responsesCallId(toolCallId),
        output,
      },
    ]
  }

  const items: JsonValue[] = []
  const content = chatContentToResponsesParts(get(message, 'content'), role)

  if (role === 'assistant') {
    // An assistant turn is replayed as a completed output item, the shape the endpoint expects for
    // its own past replies. A user turn is a bare `{role, content}`.
    if (content.length > 0) {
      items.push({
        type: 'message',
        id: `msg_atomic_${assistantIndex.value}`,
        role: 'assistant',
        content,
        status: 'completed',
      })
      assistantIndex.value += 1
    }
  } else if (content.length > 0) {
    items.push({ role, content })
  }

  for (const call of asArray(get(message, 'tool_calls')) ?? []) {
    const fn = get(call, 'function')
    const name = asStr(get(fn, 'name')) ?? ''
    if (name === '') continue
    const args = asStr(get(fn, 'arguments')) ?? '{}'
    const id = asStr(get(call, 'id'))
    items.push({
      type: 'function_call',
      call_id: id === undefined ? newCallId() : responsesCallId(id),
      name,
      arguments: args,
    })
  }

  return items
}

/** An output part carries `annotations`; an input part does not. */
function textPart(textType: string, text: string): JsonValue {
  return textType === 'output_text'
    ? { type: 'output_text', text, annotations: [] }
    : { type: textType, text }
}

/**
 * Chat content (a string, or an array of typed parts) as Responses content parts. What the user sent
 * is `input_text`; what the assistant produced is `output_text`.
 */
function chatContentToResponsesParts(content: JsonValue | undefined, role: string): JsonValue[] {
  const textType = role === 'assistant' ? 'output_text' : 'input_text'
  if (typeof content === 'string') return content === '' ? [] : [textPart(textType, content)]
  if (!Array.isArray(content)) return []

  const out: JsonValue[] = []
  for (const part of content) {
    if (asStr(get(part, 'type')) === 'image_url') {
      // Chat nests the URL; Responses puts it on the part. Data URLs travel unchanged. The same
      // `input_image` part is emitted for an assistant turn too — Rust does not distinguish.
      const url = asStr(get(get(part, 'image_url'), 'url'))
      if (url !== undefined) out.push({ type: 'input_image', detail: 'auto', image_url: url })
    } else {
      const text = asStr(get(part, 'text'))
      if (text !== undefined && text !== '') out.push(textPart(textType, text))
    }
  }
  return out
}

/**
 * Chat nests the schema under `function`; Responses keeps it flat. Non-function (built-in) tools and
 * tools without a `name` key are dropped (`undefined`). A present `name` is copied as-is, whatever
 * its type.
 */
export function chatToolToResponses(tool: JsonValue): JsonObject | undefined {
  if (asStr(get(tool, 'type')) !== 'function') return undefined
  const fn = get(tool, 'function')
  if (fn === undefined) return undefined
  const name = get(fn, 'name')
  if (name === undefined) return undefined

  const out: JsonObject = { type: 'function', name }
  const description = get(fn, 'description')
  if (description !== undefined) out['description'] = description
  // Every object schema has to carry `properties`, including nested combinators — the endpoint
  // rejects one that does not.
  out['parameters'] = normalizeFunctionSchema(get(fn, 'parameters'))
  const strict = get(fn, 'strict')
  if (strict !== undefined) out['strict'] = strict
  return out
}

/**
 * Fill in `properties` on every object schema, recursing through the places a JSON Schema can nest
 * one. A missing or non-object schema becomes `{type: "object", properties: {}}` — including a
 * non-object entry inside `properties` / `$defs` / `definitions` / `anyOf` / `oneOf` / `allOf` /
 * `prefixItems`, whereas a non-object `items` / `additionalProperties` / `not` is left alone.
 */
export function normalizeFunctionSchema(schema: JsonValue | undefined): JsonObject {
  if (schema === undefined || !isJsonObject(schema)) return { type: 'object', properties: {} }

  const out: JsonObject = objectFrom(Object.entries(schema))
  for (const key of ['properties', '$defs', 'definitions']) {
    const children = out[key]
    if (children !== undefined && isJsonObject(children)) {
      out[key] = objectFrom(
        Object.entries(children).map(([name, child]) => [name, normalizeFunctionSchema(child)])
      )
    }
  }
  for (const key of ['items', 'additionalProperties', 'not']) {
    const child = out[key]
    if (child !== undefined && isJsonObject(child)) out[key] = normalizeFunctionSchema(child)
  }
  for (const key of ['anyOf', 'oneOf', 'allOf', 'prefixItems']) {
    const children = out[key]
    if (Array.isArray(children)) out[key] = children.map((child) => normalizeFunctionSchema(child))
  }

  const type = out['type']
  const isObject = type === 'object' || (Array.isArray(type) && type.some((t) => t === 'object'))
  const properties = out['properties']
  if (isObject && (properties === undefined || !isJsonObject(properties))) out['properties'] = {}
  return out
}

/** `"auto" | "none" | "required"` pass through; a named function is flattened; anything else is `auto`. */
export function chatToolChoiceToResponses(toolChoice: JsonValue): JsonValue {
  if (typeof toolChoice === 'string') return toolChoice
  if (isJsonObject(toolChoice)) {
    const name = asStr(get(get(toolChoice, 'function'), 'name'))
    return name === undefined ? toolChoice : { type: 'function', name }
  }
  return 'auto'
}

/** `response_format` as Responses `text.format`; `undefined` when there is nothing to send. */
export function chatResponseFormatToText(responseFormat: JsonValue): JsonObject | undefined {
  const type = asStr(get(responseFormat, 'type'))
  if (type === 'json_object') return { type: 'json_object' }
  if (type !== 'json_schema') return undefined
  const jsonSchema = get(responseFormat, 'json_schema')
  if (jsonSchema === undefined) return undefined
  const out: JsonObject = { type: 'json_schema' }
  for (const key of ['name', 'schema', 'strict']) {
    const value = get(jsonSchema, key)
    if (value !== undefined) out[key] = value
  }
  return out
}

/** Responses `usage` in the Chat Completions shape. Non-integer or negative counts read as 0. */
export function mapUsageReverse(usage: JsonValue): JsonObject {
  const input = asU64(get(usage, 'input_tokens')) ?? 0
  const output = asU64(get(usage, 'output_tokens')) ?? 0
  const total = asU64(get(usage, 'total_tokens')) ?? input + output
  return { prompt_tokens: input, completion_tokens: output, total_tokens: total }
}

// ── stream ───────────────────────────────────────────────────────────────────

/** One in-flight function call. Its position in `tools` is the index chat chunks key on. */
type ToolAcc = { callId: string; name: string; arguments: string }

/**
 * `ChatChunkStreamConverter`: Responses stream events in, `chat.completion.chunk` objects out.
 *
 * The same instance accumulates the whole reply, so a caller that asked for `stream: false` gets one
 * `chat.completion` from {@link intoChatCompletion} without a second pass.
 */
export class ChatChunkStreamConverter {
  private readonly id = newChatCompletionId()
  private model: string
  private readonly created: number
  private roleSent = false
  private finished = false
  /** The upstream stopped at a cap rather than finishing the thought. */
  private incomplete = false
  private readonly tools: ToolAcc[] = []
  /** Responses item id → index into `tools`. */
  private readonly toolIndexByItem = new Map<string, number>()
  private text = ''
  private reasoning = ''
  private usage: JsonObject | undefined
  /** Set when the upstream reported a failure instead of completing. */
  private errorMessage: string | null = null

  constructor(model: string, created: number) {
    this.model = model
    this.created = created
  }

  private chunk(delta: JsonObject, finishReason: string | null, usage?: JsonObject): JsonObject {
    const out: JsonObject = {
      id: this.id,
      object: 'chat.completion.chunk',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }
    if (usage !== undefined) out['usage'] = usage
    return out
  }

  /** Chat clients expect the assistant role once, on the first chunk. */
  private delta(): JsonObject {
    if (this.roleSent) return {}
    this.roleSent = true
    return { role: 'assistant' }
  }

  private finishReason(): string {
    if (this.incomplete) return 'length'
    return this.tools.length === 0 ? 'stop' : 'tool_calls'
  }

  /** Feed one Responses event. Returns the chunks it produces, if any. */
  onEvent(event: JsonValue): JsonValue[] {
    if (this.finished) return []
    const kind = asStr(get(event, 'type'))
    if (kind === undefined) return []

    switch (kind) {
      case 'response.created':
      case 'response.in_progress': {
        // The upstream echoes the model it actually served; prefer it over the requested one.
        const model = asStr(get(get(event, 'response'), 'model'))
        if (model !== undefined && model !== '') this.model = model
        return []
      }

      // A refusal is still the assistant's reply; dropping it would end the turn empty.
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const text = asStr(get(event, 'delta'))
        if (text === undefined || text === '') return []
        this.text += text
        return [this.chunk({ ...this.delta(), content: text }, null)]
      }

      // Reasoning has no standard Chat Completions field; `reasoning_content` is the de-facto one
      // (DeepSeek's), and what the app's transport already understands.
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        const text = asStr(get(event, 'delta'))
        if (text === undefined || text === '') return []
        this.reasoning += text
        return [this.chunk({ ...this.delta(), reasoning_content: text }, null)]
      }

      // Some streams deliver a function call whole, without an `added` event or argument deltas.
      // Guarded on the item id so a call that did stream normally is not announced twice.
      case 'response.output_item.done': {
        const item = get(event, 'item')
        if (item === undefined || asStr(get(item, 'type')) !== 'function_call') return []
        const itemId = asStr(get(item, 'id')) ?? ''
        if (this.toolIndexByItem.has(itemId)) return []
        const name = asStr(get(item, 'name'))
        if (name === undefined) return []
        // `call_id` falls back to `id` only when the key is absent: a present non-string
        // `call_id` mints a fresh id instead (Rust's `get("call_id").or_else(get("id"))`).
        const rawCallId = get(item, 'call_id')
        const callId = asStr(rawCallId === undefined ? get(item, 'id') : rawCallId) ?? newCallId()
        const args = asStr(get(item, 'arguments')) ?? ''
        const index = this.pushTool(itemId, { callId, name, arguments: args })
        return [
          this.chunk(
            {
              ...this.delta(),
              tool_calls: [{ index, id: callId, type: 'function', function: { name, arguments: args } }],
            },
            null
          ),
        ]
      }

      case 'response.output_item.added': {
        const item = get(event, 'item')
        if (item === undefined || asStr(get(item, 'type')) !== 'function_call') return []
        const itemId = asStr(get(item, 'id')) ?? ''
        const callId = asStr(get(item, 'call_id')) ?? newCallId()
        const name = asStr(get(item, 'name')) ?? ''
        const index = this.pushTool(itemId, { callId, name, arguments: '' })
        return [
          this.chunk(
            {
              ...this.delta(),
              tool_calls: [{ index, id: callId, type: 'function', function: { name, arguments: '' } }],
            },
            null
          ),
        ]
      }

      case 'response.function_call_arguments.delta': {
        const text = asStr(get(event, 'delta'))
        if (text === undefined) return []
        const itemId = asStr(get(event, 'item_id')) ?? ''
        // Fall back to the newest call: a stream that omits `item_id` is still unambiguous while only
        // one call is open. (A missing `item_id` first looks up the key "", which is where an
        // `added` item without an `id` was filed.)
        const index = this.toolIndexByItem.get(itemId) ?? this.newestToolIndex()
        if (index === undefined) return []
        const tool = this.tools[index]
        if (tool !== undefined) tool.arguments += text
        return [this.chunk({ ...this.delta(), tool_calls: [{ index, function: { arguments: text } }] }, null)]
      }

      // `response.incomplete` means the reply was cut short by a cap, which is `length` — reporting
      // it as `stop` would tell the client a truncated answer was a finished one.
      case 'response.completed':
      case 'response.incomplete': {
        const usage = get(get(event, 'response'), 'usage')
        // A present `usage: null` still maps (to zeros), as Rust's `if let Some(usage)` does.
        if (usage !== undefined) this.usage = mapUsageReverse(usage)
        this.finished = true
        this.incomplete = kind === 'response.incomplete'
        return [this.chunk({}, this.finishReason(), this.usage === undefined ? undefined : { ...this.usage })]
      }

      case 'response.failed':
      case 'error': {
        // `response.error` wins whenever the key exists, even without a usable `message`; only
        // its absence falls back to the top-level `error`.
        const nested = get(get(event, 'response'), 'error')
        const err = nested === undefined ? get(event, 'error') : nested
        this.errorMessage = asStr(get(err, 'message')) ?? DEFAULT_FAILURE_MESSAGE
        this.finished = true
        return [this.chunk({}, 'stop')]
      }

      default:
        return []
    }
  }

  private pushTool(itemId: string, tool: ToolAcc): number {
    const index = this.tools.length
    this.tools.push(tool)
    this.toolIndexByItem.set(itemId, index)
    return index
  }

  private newestToolIndex(): number | undefined {
    let max: number | undefined
    for (const index of this.toolIndexByItem.values()) if (max === undefined || index > max) max = index
    return max
  }

  /**
   * Close out a stream that ended without a terminal event — a dropped connection, say. Emits the
   * finish chunk the client is still waiting for; nothing if a terminal event was already seen.
   */
  finish(): JsonValue[] {
    if (this.finished) return []
    this.finished = true
    return [this.chunk({}, this.finishReason())]
  }

  /**
   * `into_chat_completion`: the whole reply as one `chat.completion`, for a caller that asked for
   * `stream: false`. The upstream only streams, so this is the aggregate of what was seen.
   */
  intoChatCompletion(): JsonValue {
    const message: JsonObject = { role: 'assistant', content: this.text === '' ? null : this.text }
    if (this.reasoning !== '') message['reasoning_content'] = this.reasoning
    if (this.tools.length > 0) {
      message['tool_calls'] = this.tools.map((t) => ({
        id: t.callId,
        type: 'function',
        function: { name: t.name, arguments: t.arguments },
      }))
    }
    const out: JsonObject = {
      id: this.id,
      object: 'chat.completion',
      created: this.created,
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finishReason() }],
    }
    if (this.usage !== undefined) out['usage'] = this.usage
    return out
  }

  error(): string | null {
    return this.errorMessage
  }
}
