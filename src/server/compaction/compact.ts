/**
 * One compaction of a chat request's history, shared by the control API (`POST …/compact`, the app
 * asks) and the public server (a client's request that does not fit).
 *
 * The request is counted, its messages' sizes are the engine's count shared out by their estimates,
 * and the cut is planned (`plan.ts`). A summary made before for the same leading turns is reused as
 * long as the request still fits with it: a client that sends its whole history every turn costs no
 * model call until the turns since the last compaction overflow the window again — and then only
 * those turns are summarized, into the summary that already exists.
 */

import {
  COMPACTION_TARGET_RATIO,
  CONTEXT_FIT_RATIO,
  applyCompaction,
  summaryBlock,
} from '../../contracts/index.js'
import type { CompactResult, ContextChatMessage } from '../../contracts/index.js'
import { SummaryCache, prefixKeys } from './cache.js'
import { PromptCalibration } from './calibration.js'
import { countPromptTokens } from './count.js'
import type { CountRequest, PromptCount } from './count.js'
import type { CompactionTarget } from './engine.js'
import {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  estimateMessageTokens,
  estimateTextTokens,
  estimateToolsTokens,
} from './estimate.js'
import { compactionBoundaries, keptTokens, planCompaction } from './plan.js'
import type { CompactionPlan } from './plan.js'
import { summarizeHistory, summaryTokenBudget } from './summarize.js'

/** The words `summaryBlock` puts around a summary, in tokens. */
export const SUMMARY_BLOCK_TOKENS = 48
/** A target share is kept within these bounds: below, nothing would be kept; above, nothing would be gained. */
export const MIN_TARGET_RATIO = 0.1

export interface CompactionRequest extends CountRequest {
  /** Tokens kept free for the answer; {@link DEFAULT_OUTPUT_RESERVE_TOKENS} when absent. */
  reserveTokens?: number | undefined
  /** Share of the window the compacted prompt aims at; `COMPACTION_TARGET_RATIO` when absent. */
  targetRatio?: number | undefined
}

export interface CompactDeps {
  fetch?: typeof fetch
  calibration?: PromptCalibration
  cache?: SummaryCache
  /** Fires when whoever asked has gone: the summary request is cancelled. */
  signal?: AbortSignal
  /** The request's count, when the caller has it already. */
  count?: PromptCount
  /** Summary request timeout, for tests. */
  summaryTimeoutMs?: number
}

export type CompactOutcome =
  | { ok: true; result: CompactResult }
  | { ok: false; reason: 'nothing_to_compact' | 'summary_failed'; message: string }

/** `targetRatio` within `[MIN_TARGET_RATIO, CONTEXT_FIT_RATIO]`, the default when it is not a number. */
export function boundedTargetRatio(ratio: number | undefined): number {
  if (ratio === undefined || !Number.isFinite(ratio)) return COMPACTION_TARGET_RATIO
  return Math.min(CONTEXT_FIT_RATIO, Math.max(MIN_TARGET_RATIO, ratio))
}

/** The answer reserve of a compaction: the caller's, else the default, and never half the window or more. */
export function boundedReserve(reserve: number | undefined, window: number): number {
  const asked =
    reserve !== undefined && Number.isFinite(reserve) && reserve >= 0
      ? reserve
      : DEFAULT_OUTPUT_RESERVE_TOKENS
  return Math.min(Math.floor(asked), Math.floor(window / 2))
}

/** Compact `request`'s history for a session serving `window` tokens. Never throws. */
export async function compactRequest(
  target: CompactionTarget,
  request: CompactionRequest,
  window: number,
  deps: CompactDeps = {}
): Promise<CompactOutcome> {
  const messages = request.messages
  if (compactionBoundaries(messages).length === 0) {
    return {
      ok: false,
      reason: 'nothing_to_compact',
      message: 'The conversation has no earlier turn to summarize: only its latest turn is left.',
    }
  }
  const reserve = boundedReserve(request.reserveTokens, window)
  const targetRatio = boundedTargetRatio(request.targetRatio)
  const count = deps.count ?? (await countPromptTokens(target, request, deps))

  // The engine's count shared out by the estimates, so every size is in the session's own tokens.
  const estimates = messages.map(estimateMessageTokens)
  const toolTokens = estimateToolsTokens(request.tools)
  const estimated = estimates.reduce((sum, n) => sum + n, toolTokens)
  const scale = estimated > 0 ? count.tokens / estimated : 1
  const sized = { messages, sizes: estimates.map((n) => n * scale), fixedTokens: toolTokens * scale }

  // What each cut replaces: the non-system messages ahead of it, the prefix its summary is keyed by.
  const summarizable: ContextChatMessage[] = []
  const replacedBefore: number[] = []
  for (const message of messages) {
    replacedBefore.push(summarizable.length)
    if (message.role !== 'system') summarizable.push(message)
  }
  replacedBefore.push(summarizable.length)
  const keys = prefixKeys(target.provider, target.modelId, summarizable)
  const keyAt = (keepFrom: number) => keys[replacedBefore[keepFrom] ?? 0] as string

  const done = async (keepFrom: number, summary: string, cached: boolean): Promise<CompactOutcome> => {
    const compacted = { ...request, messages: applyCompaction(messages, { summary, keepFrom }) }
    const after = await countPromptTokens(target, compacted, deps)
    return {
      ok: true,
      result: {
        summary,
        keepFrom,
        summarizedCount: replacedBefore[keepFrom] ?? 0,
        tokensBefore: count.tokens,
        tokensAfter: after.tokens,
        cached,
      },
    }
  }

  // The latest cut a summary already exists for, reused while the request fits with it.
  const boundaries = compactionBoundaries(messages)
  let reusable: { keepFrom: number; summary: string } | undefined
  for (let i = boundaries.length - 1; i >= 0 && reusable === undefined; i--) {
    const keepFrom = boundaries[i] as number
    const summary = deps.cache?.get(keyAt(keepFrom))
    if (summary !== undefined) reusable = { keepFrom, summary }
  }
  if (reusable) {
    const withSummary =
      keptTokens(sized, reusable.keepFrom) + estimateTextTokens(summaryBlock(reusable.summary)) * scale
    if (withSummary + reserve <= window * CONTEXT_FIT_RATIO)
      return done(reusable.keepFrom, reusable.summary, true)
  }

  // The boundaries checked above make a plan: there is an earlier turn to cut before.
  const plan = planCompaction({
    ...sized,
    window,
    reserve,
    targetRatio,
    summaryTokens: summaryTokenBudget(window) + SUMMARY_BLOCK_TOKENS,
  }) as CompactionPlan
  if (reusable && reusable.keepFrom >= plan.keepFrom) return done(reusable.keepFrom, reusable.summary, true)

  const from = reusable?.keepFrom ?? 0
  const fresh = messages.slice(from, plan.keepFrom).filter((m) => m.role !== 'system')
  const key = keyAt(plan.keepFrom)
  const summarize = () =>
    summarizeHistory(
      target,
      fresh,
      { window, scale, ...(reusable ? { previous: reusable.summary } : {}) },
      {
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
        ...(deps.signal ? { signal: deps.signal } : {}),
        ...(deps.summaryTimeoutMs !== undefined ? { timeoutMs: deps.summaryTimeoutMs } : {}),
      }
    )
  const outcome = await (deps.cache ? deps.cache.once(key, summarize) : summarize())
  if (!outcome.ok) {
    return {
      ok: false,
      reason: 'summary_failed',
      message: `The summary failed (${outcome.reason}): ${outcome.message}`,
    }
  }
  deps.cache?.set(key, outcome.summary)
  return done(plan.keepFrom, outcome.summary, false)
}

/**
 * What a host keeps for compaction across requests: the summary cache and every session's
 * calibration. The control API and the public server share one, so a chat compacted by the app and
 * then sent through `:1337` (or the other way round) is summarized once.
 */
export class HistoryCompactor {
  readonly calibration: PromptCalibration
  readonly cache: SummaryCache
  private readonly fetchImpl: typeof fetch | undefined
  private readonly summaryTimeoutMs: number | undefined

  constructor(options: { fetch?: typeof fetch; cacheEntries?: number; summaryTimeoutMs?: number } = {}) {
    this.fetchImpl = options.fetch
    this.summaryTimeoutMs = options.summaryTimeoutMs
    this.calibration = new PromptCalibration()
    this.cache = new SummaryCache(options.cacheEntries)
  }

  /** The prompt `request` makes in `target`'s session. */
  count(target: CompactionTarget, request: CountRequest, signal?: AbortSignal): Promise<PromptCount> {
    return countPromptTokens(target, request, {
      calibration: this.calibration,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      ...(signal ? { signal } : {}),
    })
  }

  compact(
    target: CompactionTarget,
    request: CompactionRequest,
    window: number,
    options: { count?: PromptCount; signal?: AbortSignal } = {}
  ): Promise<CompactOutcome> {
    return compactRequest(target, request, window, {
      calibration: this.calibration,
      cache: this.cache,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      ...(this.summaryTimeoutMs !== undefined ? { summaryTimeoutMs: this.summaryTimeoutMs } : {}),
      ...options,
    })
  }

  /** A prompt size the engine reported for a request whose text estimate was `estimate`. */
  calibrate(target: CompactionTarget, estimate: number, observed: number): void {
    this.calibration.learn(target, estimate, observed)
  }
}
