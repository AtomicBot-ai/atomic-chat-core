import { describe, expect, it } from 'vitest'
import type { ContextChatMessage } from '../../contracts/index.js'
import { compactionBoundaries, keptTokens, planCompaction } from './plan.js'

const sys = (content = 's'): ContextChatMessage => ({ role: 'system', content })
const user = (content = 'u'): ContextChatMessage => ({ role: 'user', content })
const bot = (content = 'a'): ContextChatMessage => ({ role: 'assistant', content })
const call = (id: string): ContextChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'f', arguments: '{}' } }],
})
const result = (id: string): ContextChatMessage => ({ role: 'tool', tool_call_id: id, content: 'r' })

describe('compactionBoundaries', () => {
  it.each([
    ['a lone turn has nothing ahead of it', [sys(), user()], []],
    ['nothing but systems ahead does not count', [sys(), sys(), user(), bot()], []],
    ['every later user turn is a cut', [user(), bot(), user(), bot(), user()], [2, 4]],
    ['systems in between are fine', [sys(), user(), bot(), sys(), user()], [4]],
    [
      'a user message between a call and its result is no cut',
      [user(), call('c1'), user('steer'), result('c1'), bot(), user()],
      [5],
    ],
    [
      'a result right after a user message is taken as answering a call ahead',
      [user(), call('x'), user(), { role: 'tool', content: 'r' }, user()],
      [4],
    ],
    [
      'a finished tool exchange leaves the next turn a cut',
      [user(), call('c1'), result('c1'), bot(), user()],
      [4],
    ],
  ] as const)('%s', (_name, messages, expected) => {
    expect(compactionBoundaries(messages)).toEqual(expected)
  })
})

describe('keptTokens', () => {
  it('keeps the system messages ahead of the cut, everything after it, and the fixed part', () => {
    const messages = [sys(), user(), bot(), sys(), user(), bot()]
    const sizes = [10, 100, 200, 5, 50, 60]
    expect(keptTokens({ messages, sizes, fixedTokens: 7 }, 4)).toBe(7 + 10 + 5 + 50 + 60)
    expect(keptTokens({ messages, sizes, fixedTokens: 0 }, 0)).toBe(425)
  })
})

describe('planCompaction', () => {
  // Ten turns of 100 tokens each (user 40 + assistant 60), behind a 20-token system prompt.
  const messages: ContextChatMessage[] = [sys()]
  const sizes: number[] = [20]
  for (let i = 0; i < 10; i++) {
    messages.push(user(`u${i}`), bot(`a${i}`))
    sizes.push(40, 60)
  }
  const base = { messages, sizes, fixedTokens: 30, reserve: 100, summaryTokens: 150, targetRatio: 0.5 }

  it.each([
    // budget 0.5 × 1000 − 100 − 150 = 250: 30 + 20 + two turns (200) = 250 fits.
    ['keeps as many recent turns as fit the target', 1000, { keepFrom: 17, keptTokens: 250 }],
    // budget 1000 − 250 = 750: seven turns (700) + 50.
    ['a larger window keeps more', 2000, { keepFrom: 7, keptTokens: 750 }],
    // budget below even the latest turn: only it is kept.
    ['a window too small for any keeps the latest turn alone', 400, { keepFrom: 19, keptTokens: 150 }],
  ] as const)('%s', (_name, window, expected) => {
    expect(planCompaction({ ...base, window })).toEqual(expected)
  })

  it('never cuts inside a tool exchange, and has nothing to do without an earlier turn', () => {
    const tools = [
      user('task'),
      call('c1'),
      result('c1'),
      call('c2'),
      result('c2'),
      bot('done'),
      user('next'),
    ]
    const plan = planCompaction({
      messages: tools,
      sizes: [10, 10, 500, 10, 500, 10, 10],
      fixedTokens: 0,
      window: 100,
      reserve: 0,
      summaryTokens: 0,
      targetRatio: 0.5,
    })
    expect(plan).toEqual({ keepFrom: 6, keptTokens: 10 })
    expect(planCompaction({ ...base, messages: [sys(), user()], sizes: [1, 1], window: 10 })).toBeUndefined()
  })
})
