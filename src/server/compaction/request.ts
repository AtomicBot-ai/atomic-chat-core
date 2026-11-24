/**
 * Compaction of one chat request on its way to a local engine, as the public server runs it: before
 * the request is sent, when it would not fit the session's window, and once more after the engine
 * refused it (or cut its answer) for lack of room. Knows nothing of HTTP: the server hands it the
 * body and the session, and sends what comes back.
 */

import {
  CONTEXT_FIT_RATIO,
  CONTEXT_LENGTH_EXCEEDED,
  applyCompaction,
  contextResizeMode,
  decideOverflowAction,
} from '../../contracts/index.js'
import type { CompactRequest, CompactResult, ContextMeasureRequest } from '../../contracts/index.js'
import type { HistoryCompactor } from './compact.js'
import type { PromptCount } from './count.js'
import { countMethod } from './engine.js'
import type { CompactionTarget } from './engine.js'
import { answerReserve, estimatePromptTokens, promptTokenBound } from './estimate.js'
import { compactionBoundaries } from './plan.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether the `x-atomic-compaction` request header turns compaction off for this request. */
export function compactionDisabledByHeader(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === 'off'
}

/**
 * The parts of a chat body compaction reads, or `undefined` when they are not what a chat request
 * carries (`messages` an array of objects with a string `role`; `tools` an array; the kwargs an object).
 */
export function contextRequestOf(body: unknown): ContextMeasureRequest | undefined {
  if (!isRecord(body)) return undefined
  const { messages, tools, chat_template_kwargs: kwargs } = body
  if (!Array.isArray(messages) || !messages.every((m) => isRecord(m) && typeof m['role'] === 'string'))
    return undefined
  if (tools !== undefined && tools !== null && !Array.isArray(tools)) return undefined
  if (kwargs !== undefined && kwargs !== null && !isRecord(kwargs)) return undefined
  return {
    messages: messages as ContextMeasureRequest['messages'],
    ...(Array.isArray(tools) ? { tools } : {}),
    ...(isRecord(kwargs) ? { chat_template_kwargs: kwargs } : {}),
  }
}

/** A `POST …/compact` body, or `undefined` when it is not one. */
export function compactRequestOf(body: unknown): CompactRequest | undefined {
  const request = contextRequestOf(body)
  if (!request || !isRecord(body)) return undefined
  const { reserveTokens, targetRatio } = body
  if (reserveTokens !== undefined && !(Number.isInteger(reserveTokens) && (reserveTokens as number) >= 0))
    return undefined
  if (targetRatio !== undefined && !(typeof targetRatio === 'number' && targetRatio > 0 && targetRatio < 1))
    return undefined
  return {
    messages: request.messages,
    ...(request.tools ? { tools: request.tools } : {}),
    ...(typeof reserveTokens === 'number' ? { reserveTokens } : {}),
    ...(typeof targetRatio === 'number' ? { targetRatio } : {}),
  }
}

const WINDOW_PATTERNS = [
  // llama.cpp: `request (N tokens) exceeds the available context size (M tokens)`, `… max context size (M tokens)`.
  /context size \((\d+) tokens\)/i,
  // vLLM and the OpenAI wording the managed adapters map to: `maximum context length is M tokens`.
  /maximum context length is (\d+)/i,
  // SGLang: `… longer than the model's context length (M tokens)`.
  /context length \((\d+) tokens\)/i,
]

/** The window an engine's overflow error names, when it names one. */
export function windowFromOverflowError(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as unknown
    const error = isRecord(parsed) ? parsed['error'] : undefined
    const nCtx = isRecord(error) ? error['n_ctx'] : undefined
    if (typeof nCtx === 'number' && Number.isInteger(nCtx) && nCtx > 0) return nCtx
  } catch {
    // Not JSON: the wording below may still say it.
  }
  for (const pattern of WINDOW_PATTERNS) {
    const match = pattern.exec(body)
    if (match) return Number(match[1])
  }
  return undefined
}

/** Whether an error body (or the OpenAI error a policy mapped it to) is `context_length_exceeded`. */
export function isContextLengthExceeded(error: unknown): boolean {
  let value = error
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return false
    }
  }
  const inner = isRecord(value) ? value['error'] : undefined
  return isRecord(inner) && inner['code'] === CONTEXT_LENGTH_EXCEEDED
}

export interface RequestCompactionDeps {
  compactor: HistoryCompactor
  /** The window the session serves, when known. */
  window: () => Promise<number | undefined>
  /** The largest window this device holds for the model (`ContextPlan.maxCtx`), when known. */
  maxWindow?: () => Promise<number | undefined>
  /** Fires when the client leaves; asked for only when a summary is about to be requested. */
  signal?: () => AbortSignal
}

/** The chat body to send instead, and what was done to it. */
export interface CompactedChat {
  body: Record<string, unknown>
  result: CompactResult
}

/**
 * One request's compaction. At most one compaction happens per request: one made before sending is
 * not followed by another after an overflow, and an overflow is compacted and replayed once.
 */
export class RequestCompaction {
  /** The request, when it has turns compaction could summarize. */
  private readonly request: ContextMeasureRequest | undefined
  /** The request as parsed, compactable or not: what calibration learns from. */
  private readonly parsed: ContextMeasureRequest | undefined
  private sent: ContextMeasureRequest | undefined
  private done = false

  constructor(
    private readonly target: CompactionTarget,
    private readonly body: Record<string, unknown>,
    private readonly deps: RequestCompactionDeps
  ) {
    const request = contextRequestOf(body)
    this.parsed = request
    // A history with no earlier turn to summarize is never counted: there is nothing to do with it.
    this.request = request && compactionBoundaries(request.messages).length > 0 ? request : undefined
  }

  /**
   * Before sending: the compacted body when the request does not fit the window and the one overflow
   * rule (`decideOverflowAction`) says to compact rather than grow; `undefined` to send it as it is.
   * A request that surely fits — its bytes bound its tokens — costs no count at all.
   */
  async beforeSend(): Promise<CompactedChat | undefined> {
    const request = this.request
    if (!request || this.done) return undefined
    const window = await this.deps.window()
    if (window === undefined || !(window > 0)) return undefined
    const reserve = answerReserve(this.body, window)
    const bound = promptTokenBound(request)
    if (bound !== undefined && bound + reserve <= window * CONTEXT_FIT_RATIO) return undefined
    const count = await this.deps.compactor.count(this.target, request)
    const neededTokens = count.tokens + reserve
    if (neededTokens <= window * CONTEXT_FIT_RATIO) return undefined
    const resize = contextResizeMode(this.target.provider)
    const maxWindowTokens = resize === 'reload' ? await this.deps.maxWindow?.() : undefined
    const action = decideOverflowAction({ resize, neededTokens, windowTokens: window, maxWindowTokens })
    if (action !== 'compact') return undefined
    return this.compact(this.target, request, window, reserve, count)
  }

  /**
   * After the engine refused the request for its size (`errorBody`) or cut its answer at the window:
   * the compacted body to replay once, or `undefined` to answer as before. `target` is the session as
   * it is now (a grow that failed may have reloaded it). With no window known, the error's own
   * number is used, else the request's size.
   */
  async afterOverflow(
    target: CompactionTarget = this.target,
    errorBody?: string
  ): Promise<CompactedChat | undefined> {
    const request = this.request
    if (!request || this.done) return undefined
    this.done = true
    const count = await this.deps.compactor.count(target, request)
    const window =
      (await this.deps.window()) ??
      (errorBody === undefined ? undefined : windowFromOverflowError(errorBody)) ??
      count.tokens
    if (!(window > 0)) return undefined
    return this.compact(target, request, window, answerReserve(this.body, window), count)
  }

  /**
   * The prompt size the engine reported for what was sent, which teaches the session's calibration
   * how far off the text estimate is. Only a session without an exact count needs it.
   */
  observe(promptTokens: number | undefined): void {
    if (promptTokens === undefined || countMethod(this.target) !== 'estimate') return
    const sent = this.sent ?? this.parsed
    if (!sent) return
    this.deps.compactor.calibrate(this.target, estimatePromptTokens(sent), promptTokens)
  }

  private async compact(
    target: CompactionTarget,
    request: ContextMeasureRequest,
    window: number,
    reserve: number,
    count: PromptCount
  ): Promise<CompactedChat | undefined> {
    this.done = true
    const signal = this.deps.signal?.()
    const outcome = await this.deps.compactor.compact(
      target,
      { ...request, reserveTokens: reserve },
      window,
      { count, ...(signal ? { signal } : {}) }
    )
    if (!outcome.ok) return undefined
    const messages = applyCompaction(request.messages, outcome.result)
    this.sent = { ...request, messages }
    return { body: { ...this.body, messages }, result: outcome.result }
  }
}
