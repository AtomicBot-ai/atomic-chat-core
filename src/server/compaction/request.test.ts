import { describe, expect, it } from 'vitest'
import type { ContextChatMessage } from '../../contracts/index.js'
import { fakeEngineFetch, words } from '../../../test/helpers/fake-engine-fetch.js'
import { HistoryCompactor } from './compact.js'
import type { CompactionTarget } from './engine.js'
import { estimatePromptTokens } from './estimate.js'
import {
  RequestCompaction,
  compactRequestOf,
  compactionDisabledByHeader,
  contextRequestOf,
  isContextLengthExceeded,
  windowFromOverflowError,
} from './request.js'

const llama: CompactionTarget = { provider: 'llamacpp-upstream', modelId: 'demo', port: 8080, apiKey: 'k' }
const mlx: CompactionTarget = { provider: 'mlx', modelId: 'm', port: 8081, apiKey: '' }

function turns(n: number, size = 100): ContextChatMessage[] {
  return Array.from({ length: n }, (_, i) => [
    { role: 'user', content: words(size / 2, `u${i}x`) },
    { role: 'assistant', content: words(size / 2, `a${i}x`) },
  ]).flat()
}

describe('compactionDisabledByHeader', () => {
  it.each([
    [undefined, false],
    ['off', true],
    [' OFF ', true],
    ['on', false],
    ['', false],
  ])('%j → %s', (value, expected) => {
    expect(compactionDisabledByHeader(value)).toBe(expected)
  })
})

describe('contextRequestOf and compactRequestOf', () => {
  const messages = [{ role: 'user', content: 'hi' }]
  it.each([
    [{ messages }, { messages }],
    [
      { messages, tools: [{}], chat_template_kwargs: { a: 1 }, model: 'x' },
      { messages, tools: [{}], chat_template_kwargs: { a: 1 } },
    ],
    [{ messages, tools: null }, { messages }],
    [{ messages: [{ content: 'no role' }] }, undefined],
    [{ messages: 'hi' }, undefined],
    [{ messages, tools: {} }, undefined],
    [{ messages, chat_template_kwargs: [] }, undefined],
    [[], undefined],
  ])('measure body %j', (body, expected) => {
    expect(contextRequestOf(body)).toEqual(expected)
  })

  it.each([
    [
      { messages, reserveTokens: 512, targetRatio: 0.4 },
      { messages, reserveTokens: 512, targetRatio: 0.4 },
    ],
    [
      { messages, reserveTokens: 0 },
      { messages, reserveTokens: 0 },
    ],
    [{ messages, reserveTokens: -1 }, undefined],
    [{ messages, reserveTokens: 1.5 }, undefined],
    [{ messages, targetRatio: 1 }, undefined],
    [{ messages, targetRatio: '0.5' }, undefined],
    [{ nope: true }, undefined],
  ])('compact body %j', (body, expected) => {
    expect(compactRequestOf(body)).toEqual(expected)
  })
})

describe('windowFromOverflowError and isContextLengthExceeded', () => {
  it.each([
    [
      JSON.stringify({
        error: { message: 'request (9000 tokens) exceeds …', n_prompt_tokens: 9000, n_ctx: 8192 },
      }),
      8192,
    ],
    ['request (70000 tokens) exceeds the available context size (65536 tokens), try increasing it', 65536],
    ["This model's maximum context length is 32768 tokens. However, you requested 40000 tokens.", 32768],
    ["The input (5000 tokens) is longer than the model's context length (4096 tokens).", 4096],
    ['Compute error', undefined],
  ])('%s → %s', (body, expected) => {
    expect(windowFromOverflowError(body)).toBe(expected)
  })

  it('reads the OpenAI code from a body or an object, and nothing else', () => {
    const mapped = { error: { code: 'context_length_exceeded', message: 'too long' } }
    expect(isContextLengthExceeded(mapped)).toBe(true)
    expect(isContextLengthExceeded(JSON.stringify(mapped))).toBe(true)
    expect(isContextLengthExceeded({ error: { code: 'server_error' } })).toBe(false)
    expect(isContextLengthExceeded('context_length_exceeded')).toBe(false)
    expect(isContextLengthExceeded(null)).toBe(false)
  })
})

describe('RequestCompaction', () => {
  const setup = (
    target: CompactionTarget,
    body: Record<string, unknown>,
    window?: number,
    maxWindow?: number
  ) => {
    const engine = fakeEngineFetch({ summary: 'Earlier: setup done.' })
    const compactor = new HistoryCompactor({ fetch: engine.fetch })
    const compaction = new RequestCompaction(target, body, {
      compactor,
      window: async () => window,
      ...(maxWindow !== undefined ? { maxWindow: async () => maxWindow } : {}),
      signal: () => new AbortController().signal,
    })
    return { engine, compactor, compaction }
  }

  it('asks nothing for a request whose bytes already fit, nor without a known window', async () => {
    const small = setup(llama, { model: 'demo', messages: turns(3, 10) }, 8192)
    expect(await small.compaction.beforeSend()).toBeUndefined()
    const unknown = setup(llama, { model: 'demo', messages: turns(40) })
    expect(await unknown.compaction.beforeSend()).toBeUndefined()
    expect([...small.engine.calls, ...unknown.engine.calls]).toEqual([])
  })

  it('compacts a request that does not fit, keeping every other field of the body', async () => {
    const body = { model: 'demo', stream: true, max_tokens: 200, temperature: 0.2, messages: turns(20) }
    const { compaction, engine } = setup(llama, body, 2000)
    const compacted = await compaction.beforeSend()
    expect(compacted).toBeDefined()
    expect(compacted!.body).toMatchObject({ model: 'demo', stream: true, max_tokens: 200, temperature: 0.2 })
    const messages = compacted!.body['messages'] as ContextChatMessage[]
    expect(messages[0]).toMatchObject({ role: 'system' })
    expect(String(messages[0]?.content)).toContain('Earlier: setup done.')
    expect(messages.at(-1)).toEqual(body.messages.at(-1))
    expect(compacted!.result).toMatchObject({ summarizedCount: 40 - messages.length + 1, cached: false })
    // Sixteen turns to replace fill more than 60% of the window: summarized in rolling chunks.
    const calls = engine.summaryPrompts.length
    expect(calls).toBeGreaterThan(1)
    // One compaction per request: an overflow after it is not compacted again.
    expect(await compaction.afterOverflow()).toBeUndefined()
    expect(engine.summaryPrompts).toHaveLength(calls)
  })

  it('leaves a request a llama.cpp reload would fit to the reactive grow', async () => {
    const { compaction, engine } = setup(llama, { model: 'demo', messages: turns(20) }, 2000, 8192)
    expect(await compaction.beforeSend()).toBeUndefined()
    expect(engine.summaryPrompts).toEqual([])
  })

  it('compacts a restart engine over its window whatever its maximum', async () => {
    const vllm: CompactionTarget = {
      provider: 'vllm',
      modelId: 'q',
      port: 9,
      apiKey: 'gw',
      policy: { routes: [{ method: 'POST', path: '/tokenize' }] },
    }
    const { compaction } = setup(vllm, { model: 'q', messages: turns(20) }, 2000, 8192)
    expect(await compaction.beforeSend()).toBeDefined()
  })

  it('after an overflow, compacts once at the window the error names when none is known', async () => {
    const { compaction, engine } = setup(llama, { model: 'demo', messages: turns(20) })
    const error = JSON.stringify({ error: { message: 'exceeds', n_ctx: 2000, n_prompt_tokens: 2000 } })
    const compacted = await compaction.afterOverflow(llama, error)
    expect(compacted?.result.tokensAfter).toBeLessThan(1000)
    const calls = engine.summaryPrompts.length
    expect(await compaction.afterOverflow(llama, error)).toBeUndefined()
    expect(engine.summaryPrompts).toHaveLength(calls)
  })

  it('never counts a history it could not compact', async () => {
    const { compaction, engine } = setup(
      llama,
      { model: 'demo', messages: [{ role: 'user', content: words(5000) }] },
      2000
    )
    expect(await compaction.beforeSend()).toBeUndefined()
    expect(await compaction.afterOverflow()).toBeUndefined()
    expect(engine.calls).toEqual([])
  })

  it('teaches the calibration of an engine that cannot count, from the prompt size it reported', () => {
    const body = { model: 'm', messages: turns(5) }
    const estimated = setup(mlx, body, 8192)
    estimated.compaction.observe(500)
    expect(estimated.compactor.calibration.ratio(mlx)).toBe(
      500 / estimatePromptTokens({ messages: body.messages })
    )
    estimated.compaction.observe(undefined)
    const exact = setup(llama, body, 8192)
    exact.compaction.observe(500)
    expect(exact.compactor.calibration.ratio(llama)).toBeUndefined()
  })
})
