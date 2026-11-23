import { describe, expect, it } from 'vitest'
import { fakeEngineFetch, words } from '../../../test/helpers/fake-engine-fetch.js'
import type { CompactionTarget } from './engine.js'
import {
  MAX_SUMMARY_CALLS,
  SUMMARY_MAX_TOKENS,
  SUMMARY_MIN_TOKENS,
  boundedChunks,
  chunkEntries,
  summarizeHistory,
  summaryFromResponse,
  summaryPrompt,
  summaryRequestBody,
  summaryTokenBudget,
  transcriptEntry,
  truncateMiddle,
} from './summarize.js'

const llama: CompactionTarget = { provider: 'llamacpp-upstream', modelId: 'demo', port: 8080, apiKey: 'k' }
const mlx: CompactionTarget = { provider: 'mlx', modelId: 'm', port: 8081, apiKey: '' }

describe('summaryTokenBudget', () => {
  it.each([
    [1024, SUMMARY_MIN_TOKENS],
    [8192, 819],
    [131072, SUMMARY_MAX_TOKENS],
  ])('window %i → %i', (window, expected) => {
    expect(summaryTokenBudget(window)).toBe(expected)
  })
})

describe('transcriptEntry', () => {
  it.each([
    [{ role: 'user', content: 'Сделай отчёт' }, '[user]\nСделай отчёт'],
    [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is it' },
          { type: 'image_url', image_url: {} },
        ],
      },
      '[user]\nwhat is it\n[image]',
    ],
    [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } },
        ],
      },
      '[assistant]\n(called read_file with {"path":"a.ts"})',
    ],
    [
      { role: 'tool', tool_call_id: 'c', name: 'read_file', content: 'export {}' },
      '[tool result (read_file)]\nexport {}',
    ],
    [{ role: 'user', content: [{ type: 'input_audio', input_audio: {} }] }, '[user]\n[audio]'],
  ])('%j', (message, expected) => {
    expect(transcriptEntry(message)).toBe(expected)
  })
})

describe('truncateMiddle and chunkEntries', () => {
  it('keeps the head and the tail of a text that is too long', () => {
    expect(truncateMiddle('short', 10)).toBe('short')
    const cut = truncateMiddle('a'.repeat(70) + 'b'.repeat(30) + 'c'.repeat(100), 100)
    expect(cut.startsWith('a'.repeat(70))).toBe(true)
    expect(cut.endsWith('c'.repeat(30))).toBe(true)
    expect(cut).toContain('[… 100 characters left out …]')
  })

  it('packs entries into chunks in order, and cuts one entry larger than a chunk', () => {
    const tokens = (text: string) => text.length
    expect(chunkEntries(['aaaa', 'bbbb', 'cc', 'dddddd'], 10, tokens)).toEqual([
      'aaaa\n\nbbbb\n\ncc',
      'dddddd',
    ])
    const [big] = chunkEntries(['x'.repeat(1000)], 100, tokens)
    expect(big!.length).toBeLessThan(200)
    expect(chunkEntries([], 10, tokens)).toEqual([])
  })

  it('keeps the first chunk and the latest ones past the call cap', () => {
    const chunks = Array.from({ length: MAX_SUMMARY_CALLS + 3 }, (_, i) => `c${i}`)
    const kept = boundedChunks(chunks)
    expect(kept).toHaveLength(MAX_SUMMARY_CALLS)
    expect(kept[0]).toBe('c0')
    expect(kept.at(-1)).toBe(`c${MAX_SUMMARY_CALLS + 2}`)
    expect(kept[1]).toBe('c4')
    expect(boundedChunks(['a', 'b'])).toEqual(['a', 'b'])
  })
})

describe('summaryPrompt and summaryRequestBody', () => {
  it("asks in English for a summary in the conversation's language, merging a previous one", () => {
    const fresh = summaryPrompt('[user]\nhi', { maxWords: 300 })
    expect(fresh).toContain('in the language the conversation itself is written in')
    expect(fresh).toContain('<conversation>\n[user]\nhi\n</conversation>')
    expect(fresh).toContain('under about 300 words')
    expect(fresh).not.toContain('<previous_summary>')
    for (const topic of ['goals', 'decisions', 'constraints', 'identifiers', 'open', 'current state'])
      expect(fresh).toContain(topic)
    const merged = summaryPrompt('[user]\nnext', { previous: 'earlier work', maxWords: 300 })
    expect(merged).toContain('<previous_summary>\nearlier work\n</previous_summary>')
    expect(merged).toContain('Merge that summary')
  })

  it('sends one non-streamed user message, capped, with thinking off where the template has the switch', () => {
    expect(summaryRequestBody(llama, 'P', 500)).toEqual({
      model: 'demo',
      messages: [{ role: 'user', content: 'P' }],
      stream: false,
      max_tokens: 500,
      chat_template_kwargs: { enable_thinking: false },
    })
    expect(summaryRequestBody(mlx, 'P', 500)).not.toHaveProperty('chat_template_kwargs')
  })
})

describe('summaryFromResponse', () => {
  const reply = (content: unknown) => ({ choices: [{ message: { role: 'assistant', content } }] })
  it.each([
    [reply('  The user wants X.  '), 'The user wants X.'],
    [reply('<think>hmm</think>\nThe user wants X.'), 'The user wants X.'],
    [reply('still thinking</think>Summary.'), 'Summary.'],
    [
      reply([
        { type: 'text', text: 'Part ' },
        { type: 'text', text: 'two' },
      ]),
      'Part two',
    ],
    [reply('<think>only thinking</think>'), undefined],
    [reply(null), undefined],
    [{ error: 'x' }, undefined],
  ])('%j', (json, expected) => {
    expect(summaryFromResponse(json)).toBe(expected)
  })
})

describe('summarizeHistory', () => {
  const history = [
    { role: 'user', content: 'Plan the trip to Kyoto' },
    { role: 'assistant', content: 'Day one: temples.' },
  ]

  it('asks the same session once, with its key, for a short history', async () => {
    const engine = fakeEngineFetch({ summary: 'Trip to Kyoto, day one planned.' })
    const outcome = await summarizeHistory(llama, history, { window: 8192 }, { fetch: engine.fetch })
    expect(outcome).toEqual({ ok: true, summary: 'Trip to Kyoto, day one planned.', calls: 1 })
    expect(engine.calls).toHaveLength(1)
    expect(engine.calls[0]).toMatchObject({ path: '/v1/chat/completions', authorization: 'Bearer k' })
    expect(engine.calls[0]?.body).toMatchObject({ max_tokens: 819, stream: false })
    expect(engine.summaryPrompts[0]).toContain('[user]\nPlan the trip to Kyoto')
  })

  it('rolls a history larger than its share of the window through chunks, each merged into the last', async () => {
    const engine = fakeEngineFetch({ summary: (_prompt, call) => `summary after chunk ${call}` })
    const long = Array.from({ length: 6 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: words(400, `m${i}`),
    }))
    // 1024 × 0.6 − 400 − 256 leaves the minimum chunk: about one message each.
    const outcome = await summarizeHistory(
      llama,
      long,
      { window: 1024, previous: 'cached start' },
      { fetch: engine.fetch }
    )
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.calls).toBeGreaterThan(1)
    expect(outcome.summary).toBe(`summary after chunk ${outcome.calls}`)
    expect(engine.summaryPrompts[0]).toContain('<previous_summary>\ncached start\n</previous_summary>')
    expect(engine.summaryPrompts[1]).toContain(
      '<previous_summary>\nsummary after chunk 1\n</previous_summary>'
    )
  })

  it('returns the previous summary as it is when there is nothing new', async () => {
    const engine = fakeEngineFetch()
    expect(
      await summarizeHistory(llama, [], { window: 4096, previous: 'kept' }, { fetch: engine.fetch })
    ).toEqual({
      ok: true,
      summary: 'kept',
      calls: 0,
    })
    expect(engine.calls).toEqual([])
    expect((await summarizeHistory(llama, [], { window: 4096 }, { fetch: engine.fetch })).ok).toBe(false)
  })

  it.each([
    ['engine_error', { '/v1/chat/completions': () => ({ status: 500, text: 'Compute error' }) }],
    ['unreachable', { '/v1/chat/completions': () => 'throw' as const }],
    ['empty', { '/v1/chat/completions': () => ({ json: { choices: [{ message: { content: '' } }] } }) }],
    ['engine_error', { '/v1/chat/completions': () => ({ text: 'not json' }) }],
  ])('fails as %s, never throwing', async (reason, replies) => {
    const engine = fakeEngineFetch({ replies })
    expect(await summarizeHistory(llama, history, { window: 4096 }, { fetch: engine.fetch })).toMatchObject({
      ok: false,
      reason,
    })
  })

  it('stops when the client has gone', async () => {
    const engine = fakeEngineFetch()
    const controller = new AbortController()
    controller.abort()
    expect(
      await summarizeHistory(
        llama,
        history,
        { window: 4096 },
        { fetch: engine.fetch, signal: controller.signal }
      )
    ).toMatchObject({ ok: false, reason: 'aborted' })
  })
})
