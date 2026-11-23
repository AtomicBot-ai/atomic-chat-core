import { describe, expect, it } from 'vitest'
import { COMPACTION_TARGET_RATIO, CONTEXT_FIT_RATIO, applyCompaction } from '../../contracts/index.js'
import type { ContextChatMessage } from '../../contracts/index.js'
import { fakeEngineFetch, renderedPrompt, wordCount, words } from '../../../test/helpers/fake-engine-fetch.js'
import { SummaryCache } from './cache.js'
import {
  HistoryCompactor,
  MIN_TARGET_RATIO,
  boundedReserve,
  boundedTargetRatio,
  compactRequest,
} from './compact.js'
import type { CompactionTarget } from './engine.js'
import { DEFAULT_OUTPUT_RESERVE_TOKENS } from './estimate.js'

const llama: CompactionTarget = { provider: 'llamacpp-upstream', modelId: 'demo', port: 8080, apiKey: 'k' }

/** A system prompt of 20 words and `turns` turns of 100 words (user 40, assistant 60). */
function history(turns: number, from = 0): ContextChatMessage[] {
  const out: ContextChatMessage[] = []
  for (let i = from; i < from + turns; i++) {
    out.push(
      { role: 'user', content: words(40, `u${i}x`) },
      { role: 'assistant', content: words(60, `a${i}x`) }
    )
  }
  return out
}
const system: ContextChatMessage = { role: 'system', content: words(20, 's') }

describe('boundedTargetRatio and boundedReserve', () => {
  it.each([
    [undefined, COMPACTION_TARGET_RATIO],
    [Number.NaN, COMPACTION_TARGET_RATIO],
    [0.3, 0.3],
    [0.01, MIN_TARGET_RATIO],
    [0.99, CONTEXT_FIT_RATIO],
  ])('target %s → %s', (ratio, expected) => {
    expect(boundedTargetRatio(ratio)).toBe(expected)
  })

  it.each([
    [undefined, 8192, DEFAULT_OUTPUT_RESERVE_TOKENS],
    [-1, 8192, DEFAULT_OUTPUT_RESERVE_TOKENS],
    [300.7, 8192, 300],
    [6000, 8192, 4096],
  ])('reserve %s in a %i window → %i', (reserve, window, expected) => {
    expect(boundedReserve(reserve, window)).toBe(expected)
  })
})

describe('compactRequest', () => {
  const window = 2000
  const request = { messages: [system, ...history(10)], reserveTokens: 100 }

  it('summarizes the oldest turns and keeps the recent ones that fit the target, counted by the engine', async () => {
    const engine = fakeEngineFetch({ summary: 'They planned a trip.' })
    const cache = new SummaryCache()
    const outcome = await compactRequest(llama, request, window, { fetch: engine.fetch, cache })
    // Budget 0.5 × 2000 − 100 − (256 + 48): five turns of 100 and the system prompt fit, six do not.
    expect(outcome).toEqual({
      ok: true,
      result: {
        summary: 'They planned a trip.',
        keepFrom: 11,
        summarizedCount: 10,
        tokensBefore: 1020,
        tokensAfter: wordCount(
          renderedPrompt({
            messages: applyCompaction(request.messages, { summary: 'They planned a trip.', keepFrom: 11 }),
          })
        ),
        cached: false,
      },
    })
    expect(engine.summaryPrompts).toHaveLength(1)
    expect(engine.summaryPrompts[0]).toContain('u0x0')
    expect(engine.summaryPrompts[0]).toContain('a4x59')
    expect(engine.summaryPrompts[0]).not.toContain('u5x0')
    // The system prompt is kept, never summarized.
    expect(engine.summaryPrompts[0]).not.toContain('s0 s1')
    expect(cache.size).toBe(1)
  })

  it('answers the same history again from the cache, without asking the model', async () => {
    const engine = fakeEngineFetch()
    const cache = new SummaryCache()
    await compactRequest(llama, request, window, { fetch: engine.fetch, cache })
    const again = await compactRequest(llama, request, window, { fetch: engine.fetch, cache })
    expect(again).toMatchObject({ ok: true, result: { keepFrom: 11, summary: 'summary 1', cached: true } })
    expect(engine.summaryPrompts).toHaveLength(1)
  })

  it('reuses the summary while the grown history still fits with it', async () => {
    const engine = fakeEngineFetch()
    const cache = new SummaryCache()
    await compactRequest(llama, request, window, { fetch: engine.fetch, cache })
    const grown = { ...request, messages: [...request.messages, ...history(4, 10)] }
    const outcome = await compactRequest(llama, grown, window, { fetch: engine.fetch, cache })
    expect(outcome).toMatchObject({ ok: true, result: { keepFrom: 11, cached: true, summarizedCount: 10 } })
    expect(engine.summaryPrompts).toHaveLength(1)
  })

  it('adds only the turns since the last summary to it once the history outgrows it', async () => {
    const engine = fakeEngineFetch({ summary: (_prompt, call) => `summary ${call}` })
    const cache = new SummaryCache()
    await compactRequest(llama, request, window, { fetch: engine.fetch, cache })
    const grown = { ...request, messages: [...request.messages, ...history(17, 10)] }
    const outcome = await compactRequest(llama, grown, window, { fetch: engine.fetch, cache })
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Five latest turns kept again; everything before them summarized, the old summary merged in.
    expect(outcome.result).toMatchObject({ keepFrom: 45, summarizedCount: 44, cached: false })
    const incremental = engine.summaryPrompts.slice(1)
    expect(incremental[0]).toContain('<previous_summary>\nsummary 1\n</previous_summary>')
    expect(incremental.join('\n')).not.toContain('u0x0')
    expect(incremental.join('\n')).toContain('u5x0')
    expect(incremental.join('\n')).not.toContain('u22x0')
    expect(outcome.result.summary).toBe(`summary ${engine.summaryPrompts.length}`)
  })

  it('has nothing to do with a single turn, and asks nothing', async () => {
    const engine = fakeEngineFetch()
    expect(
      await compactRequest(llama, { messages: [system, { role: 'user', content: words(5000) }] }, window, {
        fetch: engine.fetch,
      })
    ).toMatchObject({ ok: false, reason: 'nothing_to_compact' })
    expect(engine.calls).toEqual([])
  })

  it('fails cleanly when the model cannot write the summary, and caches nothing', async () => {
    const engine = fakeEngineFetch({
      replies: { '/v1/chat/completions': () => ({ status: 503, text: 'Loading model' }) },
    })
    const cache = new SummaryCache()
    const outcome = await compactRequest(llama, request, window, { fetch: engine.fetch, cache })
    expect(outcome).toMatchObject({ ok: false, reason: 'summary_failed' })
    expect(!outcome.ok && outcome.message).toContain('Loading model')
    expect(cache.size).toBe(0)
  })
})

describe('HistoryCompactor', () => {
  it('shares one cache and one calibration between counting and compacting', async () => {
    const engine = fakeEngineFetch()
    const compactor = new HistoryCompactor({ fetch: engine.fetch })
    const request = { messages: [system, ...history(10)], reserveTokens: 100 }
    expect(await compactor.count(llama, request)).toEqual({ tokens: 1020, exact: true })
    const first = await compactor.compact(llama, request, 2000)
    const second = await compactor.compact(llama, request, 2000)
    expect(first).toMatchObject({ ok: true, result: { cached: false } })
    expect(second).toMatchObject({ ok: true, result: { cached: true } })
    expect(compactor.cache.size).toBe(1)

    const mlx: CompactionTarget = { provider: 'mlx', modelId: 'm', port: 1, apiKey: '' }
    compactor.calibrate(mlx, 1000, 1300)
    expect(compactor.calibration.ratio(mlx)).toBe(1.3)
  })
})
