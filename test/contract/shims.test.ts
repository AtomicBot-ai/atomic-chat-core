/**
 * Replay of the protocol-shim fixtures dumped from the Rust proxy (PLAN.md §4, stage 4a).
 *
 * Each case says how the Rust dump drove the shim (`input.kind` plus its parameters); the procedure
 * is written down in the set's `index.json` → `comparator_notes`, and this harness repeats it
 * against the TypeScript port. The port's output is then normalised exactly as the dump normalised
 * Rust's — random ids replaced by placeholders numbered in order of first appearance — and compared
 * as a whole tree.
 *
 * `PENDING` exists for the length of the port and must be empty when the stage closes: a pending
 * set is reported as skipped, never as passed, so nothing here can look like parity it is not.
 */

import { describe, expect, it } from 'vitest'
import { loadFixtureSet } from './fixtures.js'
import {
  AnthropicStreamConverter,
  ChatChunkStreamConverter,
  anthropicRequestToChat,
  chatResponseToAnthropic,
  ResponsesStreamConverter,
  chatRequestToResponses,
  chatResponseToResponses,
  responsesRequestToChat,
} from '../../src/server/shims/index.js'
import type { JsonValue } from '../../src/server/shims/index.js'

const PENDING = new Set<string>([])

/**
 * `ATOMIC_REPLAY_SETS=responses-shim,…` replays a pending set anyway — how a port in progress runs
 * its own fixtures without declaring them passed for everyone else.
 */
const FORCED = new Set(
  (process.env['ATOMIC_REPLAY_SETS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
)

/**
 * Replace ids a converter mints at random with numbered placeholders, in order of first appearance
 * within one case. The linkage between an item's `added`, `delta` and `done` events survives; the
 * random bytes do not.
 */
export function normalizeIds(value: JsonValue, rules: Array<{ prefix: string; kind: string }>): JsonValue {
  const seen = new Map<string, string>()
  const counts = new Map<string, number>()
  const placeholder = (s: string): string | undefined => {
    for (const { prefix, kind } of rules) {
      const rest = s.startsWith(prefix) ? s.slice(prefix.length) : undefined
      if (rest === undefined || !/^[0-9a-f]{32}$/i.test(rest)) continue
      const known = seen.get(s)
      if (known) return known
      const n = counts.get(kind) ?? 0
      counts.set(kind, n + 1)
      const p = `<${kind}_${n}>`
      seen.set(s, p)
      return p
    }
    return undefined
  }
  const walk = (v: JsonValue): JsonValue => {
    if (typeof v === 'string') return placeholder(v) ?? v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, JsonValue> = {}
      // Object key order matters for the numbering, and matches serde_json's (sorted keys) walk.
      for (const key of Object.keys(v).sort()) out[key] = walk(v[key] as JsonValue)
      return out
    }
    return v
  }
  return walk(value)
}

const RESPONSES_IDS = [
  { prefix: 'msg_', kind: 'msg_id' },
  { prefix: 'fc_', kind: 'fc_id' },
]
const CHAT_IDS = [
  { prefix: 'chatcmpl-', kind: 'chatcmpl_id' },
  { prefix: 'call_', kind: 'call_id' },
]

type Doc = { error?: string | null }

function describeSet(set: string, body: () => void) {
  if (PENDING.has(set) && !FORCED.has(set)) describe.skip(`${set} (pending port)`, body)
  else describe(set, body)
}

describeSet('responses-shim', () => {
  const { cases } = loadFixtureSet<Record<string, JsonValue>, JsonValue>('responses-shim')

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const input = c.input
    let actual: JsonValue
    switch (input['kind']) {
      case 'request':
        actual = { chat: responsesRequestToChat(input['body'] as JsonValue) }
        break
      case 'response':
        actual = {
          responses: chatResponseToResponses(
            input['chat'] as JsonValue,
            input['response_id'] as string,
            input['model_fallback'] as string
          ),
        }
        break
      case 'stream': {
        const conv = new ResponsesStreamConverter(input['response_id'] as string, input['model'] as string)
        const events: JsonValue[] = [conv.createdEvent()]
        let usage: JsonValue | undefined
        for (const chunk of input['chunks'] as JsonValue[]) {
          const u = (chunk as Record<string, JsonValue>)['usage']
          if (u !== undefined && u !== null) usage = u
          events.push(...conv.onChunk(chunk))
        }
        events.push(...conv.finish(usage))
        actual = events.map((ev) => ({
          event: ((ev as Record<string, JsonValue>)['type'] as string) ?? 'message',
          data: ev,
        }))
        break
      }
      default:
        throw new Error(`unknown case kind ${String(input['kind'])}`)
    }
    expect(normalizeIds(actual, RESPONSES_IDS)).toEqual(c.expected)
  })
})

describeSet('chat-to-responses-shim', () => {
  const { cases } = loadFixtureSet<Record<string, JsonValue>, JsonValue>('chat-to-responses-shim')

  const feed = (input: Record<string, JsonValue>) => {
    const conv = new ChatChunkStreamConverter(input['model'] as string, input['created'] as number)
    const chunks: JsonValue[] = []
    for (const ev of input['events'] as JsonValue[]) chunks.push(...conv.onEvent(ev))
    if (input['call_finish'] === true) chunks.push(...conv.finish())
    return { conv, chunks }
  }

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const input = c.input
    switch (input['kind']) {
      case 'request':
        expect(
          normalizeIds(
            {
              responses: chatRequestToResponses(
                input['body'] as JsonValue,
                input['prompt_cache_key'] as string
              ),
            },
            CHAT_IDS
          )
        ).toEqual(c.expected)
        return
      case 'stream': {
        const { conv, chunks } = feed(input)
        expect(
          normalizeIds(
            chunks.map((chunk) => ({ event: 'message', data: chunk })),
            CHAT_IDS
          )
        ).toEqual(c.expected)
        expect(conv.error()).toEqual((c as unknown as Doc).error ?? null)
        return
      }
      case 'aggregate': {
        const { conv } = feed(input)
        const error = conv.error()
        expect(normalizeIds({ completion: conv.intoChatCompletion(), error }, CHAT_IDS)).toEqual(c.expected)
        return
      }
      default:
        throw new Error(`unknown case kind ${String(input['kind'])}`)
    }
  })
})

/**
 * Cases where the port deliberately differs from the recorded Rust output. Each is listed in the
 * set's `index.json` → `comparator_notes.known_divergence` with the reason, and asserted here as the
 * corrected behaviour rather than skipped.
 */
const ANTHROPIC_DIVERGENCES = new Set(['stream_data_line_split_across_network_chunks'])

describeSet('anthropic-shim', () => {
  const { cases } = loadFixtureSet<Record<string, JsonValue>, JsonValue>('anthropic-shim')

  const replayStream = (chunks: string[]) => {
    const conv = new AnthropicStreamConverter()
    const events: JsonValue[] = []
    for (const chunk of chunks) events.push(...conv.onNetworkChunk(chunk))
    events.push(...conv.finish())
    return events.map((data) => ({
      event: ((data as Record<string, JsonValue>)['type'] as string) ?? 'message',
      data,
    }))
  }

  it.each(cases.map((c) => [c.name, c] as const))('%s', (name, c) => {
    const input = c.input
    switch (input['kind']) {
      case 'request':
        expect({ chat: anthropicRequestToChat(input['body'] as JsonValue) }).toEqual(c.expected)
        return
      case 'response':
        expect({ anthropic: chatResponseToAnthropic(input['chat'] as JsonValue) }).toEqual(c.expected)
        return
      case 'stream': {
        const actual = replayStream(input['chunks'] as string[])
        if (!ANTHROPIC_DIVERGENCES.has(name)) {
          expect(actual).toEqual(c.expected)
          return
        }
        // Rust drops a `data:` line cut across two network reads; the port buffers lines, so the
        // text the recorded output lost is delivered, and nothing else about the sequence changes.
        const text = actual.map((e) => (e.data as { delta?: { text?: string } }).delta?.text ?? '').join('')
        expect(text).toBe('keptlost')
        expect(actual.map((e) => e.event)).toEqual(
          [...(c.expected as Array<{ event: string }>)]
            .map((e) => e.event)
            .flatMap((event, i, all) =>
              // one extra text delta right after the one Rust kept
              event === 'content_block_delta' && all[i - 1] === 'content_block_start'
                ? [event, event]
                : [event]
            )
        )
        return
      }
      default:
        throw new Error(`unknown case kind ${String(input['kind'])}`)
    }
  })
})

describe('normalizeIds', () => {
  it('numbers ids by first appearance and reuses a placeholder for a repeated id', () => {
    const a = `msg_${'a'.repeat(32)}`
    const b = `msg_${'b'.repeat(32)}`
    expect(normalizeIds([a, b, a, 'msg_short', `fc_${'c'.repeat(32)}`], RESPONSES_IDS)).toEqual([
      '<msg_id_0>',
      '<msg_id_1>',
      '<msg_id_0>',
      'msg_short',
      '<fc_id_0>',
    ])
  })
})

describe('the pending list', () => {
  it('only names sets that exist, so it cannot quietly hide a typo', () => {
    for (const set of PENDING) expect(() => loadFixtureSet(set)).not.toThrow()
  })
})
