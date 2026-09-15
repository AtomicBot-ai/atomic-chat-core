import { describe, expect, it } from 'vitest'
import { loadFixtureSet } from './fixtures.js'

/**
 * Fixture sets emitted in phase 0 whose port lands in phase 4 (`src/server/`). Until then this test
 * only proves the imported sets are complete and well-formed; it is NOT replay evidence.
 * `docs/testing-critical-flows.md` lists them as not replayed.
 */
const DEFERRED: Array<{ set: string; comparators: string[]; placeholders: RegExp }> = [
  {
    set: 'responses-shim',
    comparators: ['json-exact', 'sse-sequence'],
    placeholders: /<(msg_id|fc_id)_\d+>/,
  },
  {
    set: 'chat-to-responses-shim',
    comparators: ['json-exact', 'sse-sequence'],
    placeholders: /<(chatcmpl_id|call_id)_\d+>/,
  },
  { set: 'state-file', comparators: ['state-file-schema'], placeholders: /<pid>/ },
]

describe.each(DEFERRED)(
  'deferred fixture set $set (shape only; replay in phase 4)',
  ({ set, comparators, placeholders }) => {
    const { index, cases } = loadFixtureSet<unknown, unknown>(set)

    it('lists every case exactly once and every case file is indexed', () => {
      expect(new Set(index.cases).size).toBe(index.cases.length)
      expect(cases.map((c) => c.name).sort()).toEqual([...index.cases].sort())
      expect(cases.length).toBeGreaterThan(0)
    })

    it('every case names its Rust source, commit and a comparator this set declares', () => {
      for (const c of cases) {
        expect(c.source.file, c.name).toMatch(/\.rs$/)
        expect(c.source.commit, c.name).toMatch(/^[0-9a-f]{7,40}$/)
        expect(comparators, `${c.name}: ${c.comparator}`).toContain(c.comparator)
        expect(c, c.name).toHaveProperty('input')
        expect(c, c.name).toHaveProperty('expected')
      }
    })

    it('sse-sequence cases carry an ordered {event,data} list', () => {
      for (const c of cases.filter((c) => c.comparator === 'sse-sequence')) {
        const events = (c.expected as { events?: unknown }).events ?? c.expected
        expect(Array.isArray(events), c.name).toBe(true)
        for (const e of events as Array<Record<string, unknown>>) {
          expect(typeof e['event'], c.name).toBe('string')
          expect(e, c.name).toHaveProperty('data')
        }
      }
    })

    it('placeholders for dynamic ids follow the documented form', () => {
      const text = JSON.stringify(cases.map((c) => c.expected))
      const tokens = text.match(/<[a-z_]+(?:_\d+)?>/g) ?? []
      for (const t of new Set(tokens)) expect(t, `${set}: unexpected placeholder ${t}`).toMatch(placeholders)
    })
  }
)
