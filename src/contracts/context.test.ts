import { describe, expect, it } from 'vitest'
import {
  applyCompaction,
  carriedSummary,
  contextResizeMode,
  decideOverflowAction,
  summaryBlock,
} from './context.js'
import type { ContextChatMessage } from './context.js'

describe('contextResizeMode', () => {
  it.each([
    ['llamacpp-upstream', 'reload'],
    ['llamacpp', 'reload'],
    ['atomic-prism', 'reload'],
    ['mlx', 'reload'],
    ['vllm', 'restart'],
    ['sglang', 'restart'],
    ['tensorrt-llm', 'restart'],
    ['strata', 'restart'],
    ['fastflowlm', 'restart'],
    ['geniex', 'restart'],
    ['litert-lm', 'restart'],
    ['foundry-local', 'fixed'],
    ['foundation-models', 'fixed'],
    ['openai', undefined],
    ['anthropic', undefined],
  ])('%s → %s', (provider, mode) => {
    expect(contextResizeMode(provider)).toBe(mode)
  })
})

describe('summaryBlock', () => {
  it('wraps the trimmed summary in a tagged block', () => {
    const block = summaryBlock('  The user wants a CLI.  ')
    expect(block.startsWith('<conversation_summary>\n')).toBe(true)
    expect(block.endsWith('\nThe user wants a CLI.\n</conversation_summary>')).toBe(true)
  })
})

describe('applyCompaction', () => {
  const history: ContextChatMessage[] = [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
    { role: 'assistant', content: 'four' },
    { role: 'user', content: 'five' },
  ]

  it('appends the summary to the system prompt and keeps the tail', () => {
    const out = applyCompaction(history, { summary: 'S', keepFrom: 3 })
    expect(out).toEqual([
      { role: 'system', content: `Be brief.\n\n${summaryBlock('S')}` },
      { role: 'user', content: 'three' },
      { role: 'assistant', content: 'four' },
      { role: 'user', content: 'five' },
    ])
  })

  it('adds a leading system message when there is none', () => {
    const out = applyCompaction(history.slice(1), { summary: 'S', keepFrom: 2 })
    expect(out[0]).toEqual({ role: 'system', content: summaryBlock('S') })
    expect(out.slice(1).map((m) => m.content)).toEqual(['three', 'four', 'five'])
  })

  it('keeps every system message ahead of the boundary, merging into the first only', () => {
    const messages: ContextChatMessage[] = [
      { role: 'system', content: 'A' },
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'B' },
      { role: 'user', content: 'u2' },
    ]
    const out = applyCompaction(messages, { summary: 'S', keepFrom: 3 })
    expect(out.map((m) => [m.role, m.content])).toEqual([
      ['system', `A\n\n${summaryBlock('S')}`],
      ['system', 'B'],
      ['user', 'u2'],
    ])
  })

  it('appends a text part to a system prompt given as parts', () => {
    const out = applyCompaction(
      [
        { role: 'system', content: [{ type: 'text', text: 'Parts.' }] },
        { role: 'user', content: 'old' },
        { role: 'user', content: 'new' },
      ],
      { summary: 'S', keepFrom: 2 }
    )
    expect(out[0]?.content).toEqual([
      { type: 'text', text: 'Parts.' },
      { type: 'text', text: `\n\n${summaryBlock('S')}` },
    ])
  })

  it('uses the block alone for an empty system prompt and clamps the boundary', () => {
    const out = applyCompaction(
      [
        { role: 'system', content: '  ' },
        { role: 'user', content: 'x' },
      ],
      { summary: 'S', keepFrom: 99 }
    )
    expect(out).toEqual([{ role: 'system', content: summaryBlock('S') }])
  })

  it('does not mutate its input', () => {
    const copy = structuredClone(history)
    applyCompaction(history, { summary: 'S', keepFrom: 3 })
    expect(history).toEqual(copy)
  })
})

describe('decideOverflowAction', () => {
  it.each([
    ['unknown window', { resize: 'reload', neededTokens: 50_000, windowTokens: undefined }, 'none'],
    ['fits under the ratio', { resize: 'restart', neededTokens: 9000, windowTokens: 10_000 }, 'none'],
    [
      'reload below the max that would hold it',
      { resize: 'reload', neededTokens: 20_000, windowTokens: 16_384, maxWindowTokens: 65_536 },
      'expand',
    ],
    [
      'reload when not even the max holds it',
      { resize: 'reload', neededTokens: 70_000, windowTokens: 16_384, maxWindowTokens: 65_536 },
      'compact',
    ],
    [
      'reload already at the max',
      { resize: 'reload', neededTokens: 70_000, windowTokens: 65_536, maxWindowTokens: 65_536 },
      'compact',
    ],
    ['reload with no known max', { resize: 'reload', neededTokens: 20_000, windowTokens: 16_384 }, 'compact'],
    [
      'restart engines never grow',
      { resize: 'restart', neededTokens: 20_000, windowTokens: 16_384, maxWindowTokens: 131_072 },
      'compact',
    ],
    ['fixed engines never grow', { resize: 'fixed', neededTokens: 5000, windowTokens: 4096 }, 'compact'],
  ] as const)('%s', (_name, input, action) => {
    expect(decideOverflowAction(input)).toBe(action)
  })
})

describe('carriedSummary', () => {
  it('takes the summary out of the system prompt and keeps every position', () => {
    const messages: ContextChatMessage[] = [
      { role: 'system', content: `Be brief.\n\n${summaryBlock('Old facts.')}` },
      { role: 'user', content: 'u' },
    ]
    expect(carriedSummary(messages)).toEqual({
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'u' },
      ],
      summary: 'Old facts.',
    })
  })

  it('leaves a system message that held only the block empty, in place', () => {
    const out = carriedSummary([
      { role: 'system', content: summaryBlock('S') },
      { role: 'user', content: 'u' },
    ])
    expect(out).toEqual({
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: 'u' },
      ],
      summary: 'S',
    })
  })

  it('reads a block from a text part and drops the part it emptied', () => {
    const out = carriedSummary([
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Parts.' },
          { type: 'text', text: `\n\n${summaryBlock('P')}` },
        ],
      },
    ])
    expect(out).toEqual({
      messages: [{ role: 'system', content: [{ type: 'text', text: 'Parts.' }] }],
      summary: 'P',
    })
  })

  it('returns the messages as they are when there is no block', () => {
    const messages: ContextChatMessage[] = [
      { role: 'system', content: 'Plain.' },
      { role: 'user', content: '<conversation_summary> in a user turn stays' },
    ]
    expect(carriedSummary(messages)).toEqual({ messages })
  })
})

describe('applyCompaction over an earlier compaction', () => {
  it('replaces the summary block already in the system prompt instead of adding a second', () => {
    const messages: ContextChatMessage[] = [
      { role: 'system', content: `Be brief.\n\n${summaryBlock('Old.')}` },
      { role: 'user', content: 'u1' },
      { role: 'user', content: 'u2' },
    ]
    const out = applyCompaction(messages, { summary: 'New.', keepFrom: 2 })
    expect(out[0]).toEqual({ role: 'system', content: `Be brief.\n\n${summaryBlock('New.')}` })
    expect(String(out[0]?.content).match(/<conversation_summary>/g)).toHaveLength(1)
  })
})
