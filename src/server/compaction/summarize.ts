/**
 * The summary itself: the replaced turns written out as a transcript and summarized by the model the
 * session already has loaded, in one non-streamed `/v1/chat/completions` to that same session.
 *
 * - The request is a single user message, so every chat template takes it (some refuse a system
 *   role, some require turns to alternate); the replaced turns travel as text inside it.
 * - Thinking is switched off where the template has the switch (`enable_thinking: false`, as
 *   `noThinkingTemplateKwargs` does for llama.cpp): a summary needs no reasoning, and a thinking
 *   model would spend the answer's budget before writing a word. Whatever thinking still comes back
 *   (`<think>` in the text) is dropped.
 * - The answer is capped at {@link summaryTokenBudget}: a tenth of the window, between 256 and 2048
 *   tokens — room for goals, decisions and identifiers, and still small beside the turns it replaces.
 * - Turns that would fill more than {@link CHUNK_WINDOW_SHARE} of the window are summarized in rolling
 *   chunks: the first chunk alone, then the summary so far plus the next chunk, so no request comes
 *   near the window. At most {@link MAX_SUMMARY_CALLS} calls: past that, the middle chunks are left
 *   out and the first one (where the task is usually stated) and the latest ones are kept.
 *
 * Every failure is an outcome, never a throw: the caller sends the request as it was.
 */

import type { ContextChatMessage } from '../../contracts/index.js'
import { sessionHeaders, takesThinkingSwitch } from './engine.js'
import type { CompactionTarget } from './engine.js'
import { CHARS_PER_TOKEN, estimateTextTokens, messageText } from './estimate.js'

export const SUMMARY_MIN_TOKENS = 256
export const SUMMARY_MAX_TOKENS = 2048
export const SUMMARY_WINDOW_SHARE = 0.1
/** Share of the window the turns of one summary request may fill. */
export const CHUNK_WINDOW_SHARE = 0.6
/** Model calls one compaction makes at most. */
export const MAX_SUMMARY_CALLS = 12
/** A summary of a long chunk on a slow machine takes minutes; a client that leaves cancels it sooner. */
export const SUMMARY_TIMEOUT_MS = 15 * 60_000
/** The instruction and the tags around the turns, in tokens. */
const PROMPT_OVERHEAD_TOKENS = 400
const MIN_CHUNK_TOKENS = 256
const TOKENS_PER_WORD = 1.4

/** The answer cap of a summary request for a session serving `window` tokens. */
export function summaryTokenBudget(window: number): number {
  return Math.min(SUMMARY_MAX_TOKENS, Math.max(SUMMARY_MIN_TOKENS, Math.floor(window * SUMMARY_WINDOW_SHARE)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function mediaLabels(message: ContextChatMessage): string[] {
  if (!Array.isArray(message.content)) return []
  return message.content.flatMap((part) => {
    if (!isRecord(part) || typeof part['text'] === 'string') return []
    const type = String(part['type'] ?? 'attachment')
    return [type.includes('image') ? '[image]' : type.includes('audio') ? '[audio]' : `[${type}]`]
  })
}

function toolCallLines(message: ContextChatMessage): string[] {
  if (!Array.isArray(message.tool_calls)) return []
  return message.tool_calls.map((call) => {
    const fn = isRecord(call) && isRecord(call['function']) ? call['function'] : {}
    const name = typeof fn['name'] === 'string' ? fn['name'] : 'tool'
    const args = typeof fn['arguments'] === 'string' ? fn['arguments'] : JSON.stringify(fn['arguments'] ?? {})
    return `(called ${name} with ${args})`
  })
}

/** One message as a transcript entry: who spoke, what they said, the tools they called. */
export function transcriptEntry(message: ContextChatMessage): string {
  const role = message.role === 'tool' ? 'tool result' : message.role
  const name = typeof message['name'] === 'string' ? ` (${message['name']})` : ''
  const lines: string[] = []
  const { content } = message
  if (typeof content === 'string') lines.push(content)
  else if (Array.isArray(content)) {
    for (const part of content)
      if (isRecord(part) && typeof part['text'] === 'string') lines.push(part['text'])
  }
  lines.push(...mediaLabels(message), ...toolCallLines(message))
  return `[${role}${name}]\n${lines.join('\n').trim()}`
}

/** `text` cut to about `maxChars`: its head and its tail, with what was left out marked between them. */
export function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.7)
  const tail = Math.max(0, maxChars - head)
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters left out …]\n${text.slice(text.length - tail)}`
}

/**
 * `entries` joined into chunks of at most `maxTokens` each (by `tokensOf`), in order; an entry
 * larger than a chunk is cut in its middle to fit one.
 */
export function chunkEntries(
  entries: readonly string[],
  maxTokens: number,
  tokensOf: (text: string) => number
): string[] {
  const chunks: string[] = []
  let current: string[] = []
  let used = 0
  for (const raw of entries) {
    let entry = raw
    let size = tokensOf(entry)
    if (size > maxTokens) {
      entry = truncateMiddle(entry, Math.max(1, Math.floor((entry.length * maxTokens) / size)))
      size = tokensOf(entry)
    }
    if (current.length > 0 && used + size > maxTokens) {
      chunks.push(current.join('\n\n'))
      current = []
      used = 0
    }
    current.push(entry)
    used += size
  }
  if (current.length > 0) chunks.push(current.join('\n\n'))
  return chunks
}

/** The chunks a capped compaction keeps: the first and the latest ones. */
export function boundedChunks(chunks: readonly string[], maxCalls = MAX_SUMMARY_CALLS): string[] {
  if (chunks.length <= maxCalls) return [...chunks]
  return [chunks[0] as string, ...chunks.slice(chunks.length - (maxCalls - 1))]
}

/** The one user message a summary request is: the instruction, the summary so far, the turns. */
export function summaryPrompt(transcript: string, options: { previous?: string; maxWords: number }): string {
  const merge = options.previous
    ? [
        '',
        'The part of the conversation before these messages was summarized already, in <previous_summary>.',
        'Merge that summary and the new messages into one updated summary that replaces both.',
      ]
    : []
  return [
    'You are compacting a conversation so it can go on within a limited context window. Summarize the',
    'conversation in <conversation> so that the assistant can carry on as if it had read all of it.',
    ...merge,
    '',
    'Write the summary in the language the conversation itself is written in.',
    'Cover, as briefly as the content allows:',
    "- the user's goals and requests, and how they changed;",
    '- decisions made, and the reasons given for them;',
    '- facts, constraints and preferences that were stated;',
    '- names of files, paths, functions, variables, commands, URLs and other identifiers, exactly as written;',
    '- tasks still open and questions not answered yet;',
    '- the current state: what the latest messages were working on and what comes next.',
    `Keep it under about ${options.maxWords} words. Write only the summary, with no preamble.`,
    '',
    ...(options.previous ? ['<previous_summary>', options.previous.trim(), '</previous_summary>', ''] : []),
    '<conversation>',
    transcript,
    '</conversation>',
    '',
    "Now write the summary, in the conversation's own language.",
  ].join('\n')
}

/** The non-streamed chat body of one summary request to `target`. */
export function summaryRequestBody(
  target: CompactionTarget,
  prompt: string,
  maxTokens: number
): Record<string, unknown> {
  return {
    model: target.modelId,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
    max_tokens: maxTokens,
    ...(takesThinkingSwitch(target.provider) ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  }
}

/** The summary in a chat completion: its first choice's text, thinking dropped; `undefined` when empty. */
export function summaryFromResponse(json: unknown): string | undefined {
  const choices = isRecord(json) ? json['choices'] : undefined
  const first = Array.isArray(choices) ? choices[0] : undefined
  const message = isRecord(first) ? first['message'] : undefined
  const content = isRecord(message) ? message['content'] : undefined
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((part) => (isRecord(part) && typeof part['text'] === 'string' ? part['text'] : ''))
      .join('')
  }
  const summary = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^[\s\S]*<\/think>/i, '')
    .trim()
  return summary === '' ? undefined : summary
}

export type SummaryOutcome =
  | { ok: true; summary: string; calls: number }
  | { ok: false; reason: 'aborted' | 'unreachable' | 'engine_error' | 'empty'; message: string }

export interface SummarizeOptions {
  /** The window the session serves; sizes the chunks and the answer. */
  window: number
  /** The summary of the turns before `messages`, to merge them into. */
  previous?: string
  /** The session's tokens per estimated token (exact count ÷ text estimate); 1 when unknown. */
  scale?: number
}

export interface SummarizeDeps {
  fetch?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

async function summarizeOnce(
  target: CompactionTarget,
  prompt: string,
  maxTokens: number,
  deps: SummarizeDeps
): Promise<SummaryOutcome> {
  const timeout = AbortSignal.timeout(deps.timeoutMs ?? SUMMARY_TIMEOUT_MS)
  let response: Response
  try {
    response = await (deps.fetch ?? fetch)(`http://127.0.0.1:${target.port}/v1/chat/completions`, {
      method: 'POST',
      headers: sessionHeaders(target),
      body: JSON.stringify(summaryRequestBody(target, prompt, maxTokens)),
      signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
    })
  } catch (e) {
    if (deps.signal?.aborted) return { ok: false, reason: 'aborted', message: 'The client went away.' }
    return { ok: false, reason: 'unreachable', message: (e as Error).message }
  }
  let json: unknown
  try {
    const text = await response.text()
    if (!response.ok)
      return { ok: false, reason: 'engine_error', message: `${response.status}: ${text.slice(0, 500)}` }
    json = JSON.parse(text)
  } catch (e) {
    if (deps.signal?.aborted) return { ok: false, reason: 'aborted', message: 'The client went away.' }
    return { ok: false, reason: 'engine_error', message: (e as Error).message }
  }
  const summary = summaryFromResponse(json)
  if (summary === undefined) return { ok: false, reason: 'empty', message: 'The model wrote no summary.' }
  return { ok: true, summary, calls: 1 }
}

/** Summarize `messages` (with `options.previous` ahead of them) by the session's own model. */
export async function summarizeHistory(
  target: CompactionTarget,
  messages: readonly ContextChatMessage[],
  options: SummarizeOptions,
  deps: SummarizeDeps = {}
): Promise<SummaryOutcome> {
  const scale = options.scale !== undefined && options.scale > 0 ? options.scale : 1
  const maxTokens = summaryTokenBudget(options.window)
  const maxWords = Math.max(100, Math.floor(maxTokens / TOKENS_PER_WORD / 1.2))
  const chunkTokens = Math.max(
    MIN_CHUNK_TOKENS,
    Math.floor(options.window * CHUNK_WINDOW_SHARE) - PROMPT_OVERHEAD_TOKENS - maxTokens
  )
  const tokensOf = (text: string) => Math.ceil(estimateTextTokens(text) * scale)
  const entries = messages
    .filter((m) => messageText(m) !== '' || Array.isArray(m.content))
    .map(transcriptEntry)
  if (entries.length === 0 && options.previous) return { ok: true, summary: options.previous, calls: 0 }
  const chunks = boundedChunks(chunkEntries(entries, chunkTokens, tokensOf))
  let previous = options.previous
  let calls = 0
  for (const chunk of chunks) {
    // The chunks leave the answer cap's room for the summary so far; one written by another, larger
    // window (a cached summary) is cut to that room.
    const prompt = summaryPrompt(
      chunk,
      previous === undefined
        ? { maxWords }
        : { previous: truncateMiddle(previous, Math.floor(maxTokens * CHARS_PER_TOKEN)), maxWords }
    )
    const outcome = await summarizeOnce(target, prompt, maxTokens, deps)
    if (!outcome.ok) return outcome
    calls++
    previous = outcome.summary
  }
  if (previous === undefined) return { ok: false, reason: 'empty', message: 'Nothing to summarize.' }
  return { ok: true, summary: previous, calls }
}
