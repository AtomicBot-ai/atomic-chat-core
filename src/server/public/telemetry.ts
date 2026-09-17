/**
 * What the request inspector reports about one request: a preview of the prompt, and the numbers a
 * response yields — time to first token, token counts, rates, finish reason, a reply preview.
 *
 * Ported from: src-tauri/src/core/server/request_inspector.rs (`prompt_preview`, `StreamTelemetry`,
 * `extract_reasoning`, `maybe_inject_stream_usage`, `is_usage_only_chunk`).
 * Contract: test/fixtures/app/inspector-telemetry.
 *
 * PRIVACY (ATO-113): previews are user content. They leave the core only in `api:request` events,
 * and only while the app's API screen is open; they are never logged or written to disk.
 */

import { isJsonObject, serdeToString } from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'

export const PREVIEW_MAX_CHARS = 1000

export interface PromptPreview {
  text: string | null
  /** Length before truncation, in characters (Unicode scalar values). */
  chars: number | null
  message_count: number | null
  has_non_text_parts: boolean
}

function get(value: JsonValue | undefined, key: string): JsonValue | undefined {
  return isJsonObject(value) && Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined
}

/** serde_json's `Value::pointer` over object keys and array indices. */
function pointer(value: JsonValue | undefined, path: string[]): JsonValue | undefined {
  let current = value
  for (const part of path) {
    if (Array.isArray(current)) current = /^\d+$/.test(part) ? current[Number(part)] : undefined
    else current = get(current, part)
    if (current === undefined) return undefined
  }
  return current
}

function asStr(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asU64(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined
}

function charCount(text: string): number {
  let n = 0
  for (const _ of text) n++
  return n
}

function takeChars(text: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of text) {
    if (n >= max) break
    out += ch
    n++
  }
  return out
}

export function promptPreview(body: JsonValue, maxChars = PREVIEW_MAX_CHARS): PromptPreview {
  const out: PromptPreview = { text: null, chars: null, message_count: null, has_non_text_parts: false }
  const setText = (text: string) => {
    out.chars = charCount(text)
    out.text = takeChars(text, maxChars)
  }

  const input = asStr(get(body, 'input'))
  if (input !== undefined) {
    setText(input)
    return out
  }
  // `messages` present in any shape is what is looked at; only its absence falls back to `input`.
  const container = get(body, 'messages') ?? get(body, 'input')
  if (!Array.isArray(container)) return out
  out.message_count = container.length

  const chosen = [...container].reverse().find((m) => get(m, 'role') === 'user') ?? container.at(-1)
  if (chosen === undefined) return out

  const content = get(chosen, 'content')
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    for (const part of content) {
      const type = asStr(get(part, 'type'))
      if (type === 'text' || type === 'input_text' || type === 'output_text') {
        const s = asStr(get(part, 'text'))
        if (s !== undefined) {
          if (text !== '') text += '\n'
          text += s
        }
      } else if (type !== undefined) {
        out.has_non_text_parts = true
      }
    }
  }
  if (text !== '') setText(text)
  return out
}

/** A chunk's reasoning text, whichever spelling the server used; the first one found wins. */
export function extractReasoning(choice: JsonValue): string | undefined {
  for (const field of ['reasoning_content', 'reasoning']) {
    for (const parent of ['delta', 'message']) {
      const text = asStr(pointer(choice, [parent, field]))
      if (text !== undefined && text !== '') return text
    }
  }
  for (const parent of ['delta', 'message']) {
    const parts = pointer(choice, [parent, 'reasoning_details'])
    if (Array.isArray(parts)) {
      const joined = parts.map((p) => asStr(get(p, 'text')) ?? '').join('')
      if (joined !== '') return joined
    }
  }
  return undefined
}

export interface TelemetryFields {
  ttft_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  total_tokens: number | null
  tokens_estimated: boolean
  prompt_per_second: number | null
  predicted_per_second: number | null
  finish_reason: string | null
  reply_preview: string | null
  reply_chars: number | null
}

/** Folds streamed frames — OpenAI chunks, whole responses, llama.cpp timings, Anthropic events. */
export class StreamTelemetry {
  firstContentAt: number | undefined
  promptTokens: number | undefined
  completionTokens: number | undefined
  totalTokens: number | undefined
  promptPerSecond: number | undefined
  predictedPerSecond: number | undefined
  finishReason: string | undefined
  /** Content deltas seen; exact for llama.cpp (one per token), an estimate elsewhere. */
  deltaCount = 0
  replyChars = 0
  private reply = ''
  /** Apart from `reply`, so a model that answered previews the answer, not its thinking. */
  private reasoning = ''

  onJson(v: JsonValue, now: number): void {
    switch (asStr(get(v, 'type'))) {
      case 'content_block_delta': {
        const text = asStr(pointer(v, ['delta', 'text']))
        if (text !== undefined) this.onContent(text, now)
        const thinking = asStr(pointer(v, ['delta', 'thinking']))
        if (thinking !== undefined) this.onReasoning(thinking, now)
        return
      }
      case 'message_start':
        this.promptTokens = asU64(pointer(v, ['message', 'usage', 'input_tokens'])) ?? this.promptTokens
        return
      case 'message_delta': {
        const n = asU64(pointer(v, ['usage', 'output_tokens']))
        if (n !== undefined) this.completionTokens = n
        const reason = asStr(pointer(v, ['delta', 'stop_reason']))
        if (reason !== undefined) this.finishReason = reason
        return
      }
    }

    const choice = pointer(v, ['choices', '0'])
    if (choice !== undefined) {
      for (const path of [
        ['delta', 'content'],
        ['message', 'content'],
      ]) {
        const text = asStr(pointer(choice, path))
        if (text !== undefined) this.onContent(text, now)
      }
      const reasoning = extractReasoning(choice)
      if (reasoning !== undefined) this.onReasoning(reasoning, now)
      const reason = asStr(get(choice, 'finish_reason'))
      if (reason !== undefined) this.finishReason = reason
    }

    // With `include_usage` every content chunk carries `"usage": null`; only a real object counts.
    const usage = get(v, 'usage')
    if (usage !== undefined && usage !== null) {
      const prompt = asU64(get(usage, 'prompt_tokens'))
      const completion = asU64(get(usage, 'completion_tokens'))
      const total = asU64(get(usage, 'total_tokens'))
      if (prompt !== undefined) this.promptTokens = prompt
      if (completion !== undefined) this.completionTokens = completion
      if (total !== undefined) this.totalTokens = total
    }

    const timings = get(v, 'timings')
    if (isJsonObject(timings)) {
      if (this.promptTokens === undefined) this.promptTokens = asU64(timings['prompt_n'])
      if (this.completionTokens === undefined) this.completionTokens = asU64(timings['predicted_n'])
      // The upstream's own rates win: they see queue time a proxy-side clock cannot.
      const pps = timings['prompt_per_second']
      if (typeof pps === 'number' && pps > 0) this.promptPerSecond = pps
      const dps = timings['predicted_per_second']
      if (typeof dps === 'number' && dps > 0) this.predictedPerSecond = dps
    }
  }

  private onContent(text: string, now: number): void {
    if (text === '') return
    this.markToken(now)
    this.replyChars += charCount(text)
    this.reply = appendCapped(this.reply, text)
  }

  private onReasoning(text: string, now: number): void {
    if (text === '') return
    this.markToken(now)
    this.replyChars += charCount(text)
    this.reasoning = appendCapped(this.reasoning, text)
  }

  private markToken(now: number): void {
    if (this.firstContentAt === undefined) this.firstContentAt = now
    this.deltaCount++
  }

  ttftMs(start: number): number | null {
    return this.firstContentAt === undefined ? null : Math.max(0, Math.floor(this.firstContentAt - start))
  }

  completionTokensOrEstimate(): number | null {
    return this.completionTokens ?? (this.deltaCount > 0 ? this.deltaCount : null)
  }

  finishFields(start: number): TelemetryFields {
    const estimated = this.completionTokens === undefined && this.deltaCount > 0
    const completion = this.completionTokensOrEstimate()
    const total =
      this.totalTokens ??
      // Only summed when the completion count is authoritative: a total from an estimate reads as exact.
      (this.promptTokens !== undefined && completion !== null && !estimated
        ? this.promptTokens + completion
        : null)
    return {
      ttft_ms: this.ttftMs(start),
      prompt_tokens: this.promptTokens ?? null,
      completion_tokens: completion,
      total_tokens: total,
      tokens_estimated: estimated,
      prompt_per_second: this.promptPerSecond ?? null,
      predicted_per_second: this.predictedPerSecond ?? null,
      finish_reason: this.finishReason ?? null,
      reply_preview: this.reply !== '' ? this.reply : this.reasoning !== '' ? this.reasoning : null,
      reply_chars: this.replyChars > 0 ? this.replyChars : null,
    }
  }
}

function appendCapped(buffer: string, text: string): string {
  const room = PREVIEW_MAX_CHARS - charCount(buffer)
  return room > 0 ? buffer + takeChars(text, room) : buffer
}

/**
 * `stream_options: {include_usage: true}` added to a streaming body so the upstream reports real
 * token counts; `undefined` when nothing changes, including when the client already chose.
 */
export function maybeInjectStreamUsage(body: Buffer): Buffer | undefined {
  let json: JsonValue
  try {
    json = JSON.parse(body.toString('utf8')) as JsonValue
  } catch {
    return undefined
  }
  if (!isJsonObject(json) || json['stream'] !== true) return undefined
  const options = get(json, 'stream_options')
  if (options === undefined) json['stream_options'] = { include_usage: true }
  else if (isJsonObject(options)) {
    if (Object.prototype.hasOwnProperty.call(options, 'include_usage')) return undefined
    options['include_usage'] = true
  } else {
    // Present but not an object: the upstream rejects it on its own terms.
    return undefined
  }
  return Buffer.from(serdeToString(json))
}

/** The usage-only trailer `include_usage` appends: empty `choices` and a non-null `usage`. */
export function isUsageOnlyChunk(v: JsonValue): boolean {
  const choices = get(v, 'choices')
  const usage = get(v, 'usage')
  return Array.isArray(choices) && choices.length === 0 && usage !== undefined && usage !== null
}
