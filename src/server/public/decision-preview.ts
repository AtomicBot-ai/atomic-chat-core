/**
 * The request inspector's view of a decision exchange. A decision body has no messages and its
 * answer no generated text, so the chat readers in `telemetry.ts` find nothing in either: the
 * prompt preview is the `state` with the question names, the reply preview one line per answer.
 *
 * Built from a parse of a copy; the bytes the client and the engine see are never touched. Same
 * privacy rule as `telemetry.ts`: only while the API screen is open, never logged.
 */

import { isJsonObject } from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'
import { PREVIEW_MAX_CHARS } from './telemetry.js'
import type { PromptPreview, TelemetryFields } from './telemetry.js'

function parse(bytes: Buffer): JsonValue | undefined {
  try {
    return JSON.parse(bytes.toString('utf8')) as JsonValue
  } catch {
    return undefined
  }
}

function capped(text: string): { text: string; chars: number } {
  const chars = [...text]
  return { text: chars.slice(0, PREVIEW_MAX_CHARS).join(''), chars: chars.length }
}

const num = (value: JsonValue | undefined): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const fixed = (value: number) => value.toFixed(2)

/** `state` as text (a string as is, anything else as compact JSON), then the question names. */
export function decisionPromptPreview(body: Buffer): PromptPreview {
  const out: PromptPreview = { text: null, chars: null, message_count: null, has_non_text_parts: false }
  const json = parse(body)
  if (!isJsonObject(json)) return out
  const lines: string[] = []
  if (typeof json.task === 'string') lines.push(json.task)
  if (json.state !== undefined)
    lines.push(typeof json.state === 'string' ? json.state : JSON.stringify(json.state))
  if (isJsonObject(json.questions)) {
    const names = Object.keys(json.questions)
    if (names.length > 0) lines.push(`Questions: ${names.join(', ')}`)
  }
  if (Array.isArray(json.candidates)) {
    const ids = json.candidates.map((c) => (isJsonObject(c) && typeof c.id === 'string' ? c.id : '?'))
    if (ids.length > 0) lines.push(`Candidates: ${ids.join(', ')}`)
  }
  if (lines.length === 0) return out
  const preview = capped(lines.join('\n\n'))
  out.text = preview.text
  out.chars = preview.chars
  return out
}

/** One answer as `name: value`, with the winning choice's probability. */
function answerLine(name: string, answer: JsonValue): string | undefined {
  if (!isJsonObject(answer)) return undefined
  if (typeof answer.choice === 'string') {
    const p = isJsonObject(answer.probabilities) ? num(answer.probabilities[answer.choice]) : undefined
    return `${name}: ${answer.choice}${p === undefined ? '' : ` (${fixed(p)})`}`
  }
  const noul = num(answer.noul)
  if (noul !== undefined) return `${name}: ${fixed(noul)}`
  const score = num(answer.score)
  if (score !== undefined) return `${name}: ${fixed(score)}`
  return undefined
}

/**
 * The finish fields of a decision answer: `answers` (systemone) or `scores` (router) as the reply
 * preview, `usage.input_tokens` as the prompt tokens. An error envelope or a body that is not JSON
 * gives no preview; the status already tells the story.
 */
export function decisionReplyFields(body: Buffer): TelemetryFields {
  const fields: TelemetryFields = {
    ttft_ms: null,
    prompt_tokens: null,
    completion_tokens: null,
    total_tokens: null,
    tokens_estimated: false,
    prompt_per_second: null,
    predicted_per_second: null,
    finish_reason: null,
    reply_preview: null,
    reply_chars: null,
  }
  const json = parse(body)
  if (!isJsonObject(json)) return fields
  const lines: string[] = []
  if (isJsonObject(json.answers)) {
    for (const [name, answer] of Object.entries(json.answers)) {
      const line = answerLine(name, answer)
      if (line) lines.push(line)
    }
  }
  if (Array.isArray(json.scores)) {
    for (const score of json.scores) {
      if (!isJsonObject(score) || typeof score.id !== 'string') continue
      const p = num(score.p_success)
      lines.push(`${score.id}: ${p === undefined ? '?' : fixed(p)}`)
    }
  }
  if (lines.length > 0) {
    const preview = capped(lines.join('\n'))
    fields.reply_preview = preview.text
    fields.reply_chars = preview.chars
  }
  const tokens = isJsonObject(json.usage) ? num(json.usage.input_tokens) : undefined
  if (tokens !== undefined) {
    fields.prompt_tokens = tokens
    fields.completion_tokens = 0
    fields.total_tokens = tokens
  }
  return fields
}
