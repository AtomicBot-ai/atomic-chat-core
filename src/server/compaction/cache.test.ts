import { describe, expect, it } from 'vitest'
import { SummaryCache, canonicalJson, prefixKeys } from './cache.js'

describe('canonicalJson', () => {
  it.each([
    [{ b: 1, a: [{ d: 2, c: null }] }, '{"a":[{"c":null,"d":2}],"b":1}'],
    [{ a: undefined, b: 'x' }, '{"b":"x"}'],
    [[undefined, 1], '[null,1]'],
    ['é', '"é"'],
    [undefined, 'null'],
  ])('%j → %s', (value, expected) => {
    expect(canonicalJson(value)).toBe(expected)
  })
})

describe('prefixKeys', () => {
  const history = [
    { role: 'user', content: 'a' },
    { content: 'b', role: 'assistant' },
    { role: 'user', content: 'c' },
  ]

  it('names every prefix, the same whatever the key order, and apart per model', () => {
    const keys = prefixKeys('llamacpp-upstream', 'demo', history)
    expect(keys).toHaveLength(4)
    expect(new Set(keys).size).toBe(4)
    const reordered = prefixKeys('llamacpp-upstream', 'demo', [
      { content: 'a', role: 'user' },
      { role: 'assistant', content: 'b' },
    ])
    expect(reordered).toEqual(keys.slice(0, 3))
    expect(prefixKeys('llamacpp-upstream', 'other', history)[2]).not.toBe(keys[2])
    expect(prefixKeys('mlx', 'demo', history)[2]).not.toBe(keys[2])
    // A history that differs early differs in every later key.
    const edited = prefixKeys('llamacpp-upstream', 'demo', [
      { role: 'user', content: 'A' },
      ...history.slice(1),
    ])
    expect(edited[0]).toBe(keys[0])
    expect(edited.slice(1).some((key, i) => key === keys[i + 1])).toBe(false)
  })
})

describe('SummaryCache', () => {
  it('drops the least recently used summary once full', () => {
    const cache = new SummaryCache(2)
    cache.set('a', 'A')
    cache.set('b', 'B')
    expect(cache.get('a')).toBe('A')
    cache.set('c', 'C')
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe('A')
    expect(cache.get('c')).toBe('C')
    expect(cache.size).toBe(2)
    cache.set('a', 'A2')
    expect(cache.get('a')).toBe('A2')
    expect(cache.size).toBe(2)
  })

  it('runs one production per key at a time, and a new one once it settled', async () => {
    const cache = new SummaryCache()
    let runs = 0
    let release: (value: string) => void = () => {}
    const produce = () => {
      runs++
      return new Promise<string>((resolve) => (release = resolve))
    }
    const first = cache.once('k', produce)
    const second = cache.once('k', produce)
    release('done')
    expect(await first).toBe('done')
    expect(await second).toBe('done')
    expect(runs).toBe(1)
    const third = cache.once('k', async () => {
      runs++
      return 'again'
    })
    expect(await third).toBe('again')
    expect(runs).toBe(2)
  })
})
