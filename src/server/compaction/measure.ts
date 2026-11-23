/**
 * What the control API answers about a session's context (`POST …/context/measure`, `POST …/compact`):
 * the measure result, the error a failed compaction is, and each session's device maximum, asked once.
 */

import { AtomicCoreError, contextResizeMode } from '../../contracts/index.js'
import type { ContextMeasureResult, ContextPlan, LocalProviderId } from '../../contracts/index.js'
import type { CompactOutcome } from './compact.js'
import type { PromptCount } from './count.js'
import { isLlamaCppFamily } from './engine.js'
import type { CompactionTarget } from './engine.js'

/** Plans remembered at most, one per loaded session; past it the memory starts over. */
export const MAX_REMEMBERED_PLANS = 64

/** A measure's answer: the count, the windows it is measured against, and what the engine can do. */
export function contextMeasureResult(
  provider: LocalProviderId,
  count: PromptCount,
  window: number | undefined,
  maxWindow: number | undefined
): ContextMeasureResult {
  return {
    promptTokens: count.tokens,
    exact: count.exact,
    ...(window !== undefined ? { windowTokens: window } : {}),
    ...(maxWindow !== undefined ? { maxWindowTokens: maxWindow } : {}),
    // Every local engine has a mode; one that is not local cannot grow, so it is taken as fixed.
    resize: contextResizeMode(provider) ?? 'fixed',
    supportsPromptProgress: isLlamaCppFamily(provider),
  }
}

/**
 * The error a failed compaction is: nothing to summarize is the caller's to know (`INVALID_ARGUMENT`),
 * a summary the model could not write is the engine's (`UPSTREAM_ERROR`, its words in `details`).
 */
export function compactFailureError(
  outcome: Extract<CompactOutcome, { ok: false }>,
  provider: string,
  modelId: string
): AtomicCoreError {
  return outcome.reason === 'nothing_to_compact'
    ? new AtomicCoreError('INVALID_ARGUMENT', outcome.message, `${provider}/${modelId}`)
    : new AtomicCoreError(
        'UPSTREAM_ERROR',
        `The history of ${modelId} could not be summarized.`,
        outcome.message
      )
}

/**
 * Each loaded session's device maximum (`ContextPlan.maxCtx`), for the engines that grow by reload:
 * the window a measure reports as `maxWindowTokens`, and what decides grow-or-compact on `:1337`.
 * Read once per session; an unreadable plan is no maximum.
 */
export class SessionPlans {
  private readonly known = new Map<string, Promise<number | undefined>>()

  constructor(
    private readonly read:
      ((provider: LocalProviderId, modelId: string) => Promise<ContextPlan | undefined>) | undefined,
    private readonly maxRemembered = MAX_REMEMBERED_PLANS
  ) {}

  maxWindow(target: CompactionTarget): Promise<number | undefined> {
    const read = this.read
    if (read === undefined || contextResizeMode(target.provider) !== 'reload')
      return Promise.resolve(undefined)
    const key = [target.provider, target.modelId, target.port, target.generation ?? ''].join('\0')
    const known = this.known.get(key)
    if (known) return known
    if (this.known.size >= this.maxRemembered) this.known.clear()
    const plan = read(target.provider, target.modelId).then(
      (found) => (found !== undefined && found.maxCtx > 0 ? found.maxCtx : undefined),
      () => undefined
    )
    this.known.set(key, plan)
    return plan
  }
}
