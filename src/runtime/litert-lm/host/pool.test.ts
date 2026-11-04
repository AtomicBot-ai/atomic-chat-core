import { describe, expect, it } from 'vitest'
import type { LiteRtConversationConfig } from './library.js'
import { ConversationPool, FifoLock, historyKey } from './pool.js'

const user = (text: string) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
const SETTINGS = { tools: null, sampler: {}, constrained: false }

class Conv {
  closed = false
  constructor(readonly config: LiteRtConversationConfig) {}
  close() {
    this.closed = true
  }
}

function pool(limit = 4) {
  const made: Conv[] = []
  const p = new ConversationPool<Conv>((config) => {
    const conv = new Conv(config)
    made.push(conv)
    return conv
  }, limit)
  return { p, made }
}

describe('historyKey', () => {
  it('ignores what a client may change when it repeats a reply: spaces at the ends, call ids, argument key order', () => {
    expect(historyKey([assistant('Hi there ')])).toBe(historyKey([assistant('Hi there')]))
    const a = {
      role: 'assistant',
      content: [],
      tool_calls: [{ type: 'function', function: { name: 'w', arguments: { a: 1, b: 2 } } }],
    }
    const b = {
      role: 'assistant',
      content: [],
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'w', arguments: { b: 2, a: 1 } } }],
    }
    expect(historyKey([a])).toBe(historyKey([b]))
    expect(historyKey([user('a')])).not.toBe(historyKey([user('b')]))
    expect(historyKey([{ role: 'user', content: [{ type: 'image', blob: 'AAAA' }] }])).not.toBe(
      historyKey([{ role: 'user', content: [{ type: 'image', blob: 'BBBB' }] }])
    )
  })
})

describe('ConversationPool', () => {
  it('starts a new conversation from the history, then continues it with only the new turn', () => {
    const { p, made } = pool()
    const first = p.take([], SETTINGS)
    expect(first.reused).toBe(false)
    expect(made[0]?.config).toEqual({ messages: [], ...SETTINGS })
    p.advance(first.entry, [user('Hi'), assistant('Hello!')])

    const second = p.take([user('Hi'), assistant('Hello! ')], SETTINGS)
    expect(second.reused).toBe(true)
    expect(second.conversation).toBe(made[0])
    expect(made).toHaveLength(1)
  })

  it('keeps two chats apart when they alternate, without recreating either', () => {
    const { p, made } = pool()
    const a = p.take([], SETTINGS)
    p.advance(a.entry, [user('A1'), assistant('a1')])
    const b = p.take([], SETTINGS)
    p.advance(b.entry, [user('B1'), assistant('b1')])
    for (let turn = 2; turn < 5; turn++) {
      const historyA = [user('A1'), assistant('a1')]
      const historyB = [user('B1'), assistant('b1')]
      for (let k = 2; k < turn; k++) {
        historyA.push(user(`A${k}`), assistant(`a${k}`))
        historyB.push(user(`B${k}`), assistant(`b${k}`))
      }
      const ta = p.take(historyA, SETTINGS)
      expect(ta.reused).toBe(true)
      p.advance(ta.entry, [user(`A${turn}`), assistant(`a${turn}`)])
      const tb = p.take(historyB, SETTINGS)
      expect(tb.reused).toBe(true)
      p.advance(tb.entry, [user(`B${turn}`), assistant(`b${turn}`)])
    }
    expect(made).toHaveLength(2)
  })

  it('does not continue a conversation made with other tools, sampling or constraint', () => {
    const { p, made } = pool()
    const first = p.take([], SETTINGS)
    p.advance(first.entry, [user('Hi'), assistant('Hello')])
    const history = [user('Hi'), assistant('Hello')]
    expect(p.take(history, { ...SETTINGS, sampler: { temperature: 0.1 } }).reused).toBe(false)
    expect(p.take(history, { ...SETTINGS, constrained: true }).reused).toBe(false)
    expect(p.take(history, { ...SETTINGS, tools: [{ type: 'function' }] }).reused).toBe(false)
    expect(made).toHaveLength(4)
  })

  it('evicts the least recently used conversation when a fifth is made', () => {
    const { p, made } = pool(4)
    const entries = [0, 1, 2, 3].map((i) => {
      const taken = p.take([], SETTINGS)
      p.advance(taken.entry, [user(`u${i}`), assistant(`a${i}`)])
      return taken
    })
    // Chat 0 is used again, so chat 1 is now the oldest.
    p.advance(p.take([user('u0'), assistant('a0')], SETTINGS).entry, [user('again'), assistant('ok')])
    p.take([], SETTINGS)
    expect(made).toHaveLength(5)
    expect(made.map((conv) => conv.closed)).toEqual([false, true, false, false, false])
    expect(p.size).toBe(4)
    expect(entries).toHaveLength(4)
  })

  it('drops a conversation that cannot be continued (cancelled), and closes everything at the end', () => {
    const { p, made } = pool()
    const taken = p.take([], SETTINGS)
    p.drop(taken.entry)
    expect(made[0]?.closed).toBe(true)
    expect(p.size).toBe(0)
    p.take([], SETTINGS)
    p.closeAll()
    expect(made[1]?.closed).toBe(true)
    expect(p.size).toBe(0)
  })
})

describe('FifoLock', () => {
  it('runs work one at a time, in the order it arrived, past a failure', async () => {
    const lock = new FifoLock()
    const order: string[] = []
    const step = (name: string, ms: number, fail = false) =>
      lock.run(async () => {
        order.push(`start ${name}`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        order.push(`end ${name}`)
        if (fail) throw new Error(name)
        return name
      })
    const results = await Promise.allSettled([step('a', 20), step('b', 5, true), step('c', 1)])
    expect(order).toEqual(['start a', 'end a', 'start b', 'end b', 'start c', 'end c'])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected', 'fulfilled'])
    expect(lock.waiting).toBe(0)
  })
})
