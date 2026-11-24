import { expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { readStrataBlock, strataKvBytesPerToken } from './strata.js'
const descriptor = Object.values(fixture.models)[0]!.definition
it('reads acquisition metadata without accepting a client readiness marker or execution hooks', () => {
  const raw = { schema_version: 1, source_digest: 'a'.repeat(64), descriptor }
  expect(readStrataBlock(raw)).toEqual(raw)
  for (const extra of [
    { ready: true },
    { before_load: 'shell command' },
    { schema_version: 2 },
    { source_digest: 'main' },
  ])
    expect(() => readStrataBlock({ ...raw, ...extra })).toThrow()
  expect(() => readStrataBlock({ ...raw, descriptor: { ...descriptor, sources: [] } })).toThrow()
})

it('reads what a token of window costs from the first shard, or nothing when the header cannot tell', () => {
  // qwen35moe: only the attention layers of the per-layer head_count_kv hold KV (2 heads of 256).
  const heads = Array.from({ length: 40 }, (_, il) => (il % 4 === 3 ? 2 : 0))
  expect(
    strataKvBytesPerToken({
      'general.architecture': 'qwen35moe',
      'qwen35moe.block_count': '40',
      'qwen35moe.context_length': '262144',
      'qwen35moe.attention.head_count': '16',
      'qwen35moe.attention.head_count_kv': `[${heads.join(', ')}]`,
      'qwen35moe.attention.key_length': '256',
      'qwen35moe.attention.value_length': '256',
    })
  ).toEqual({ kvBytesPerToken: 20_480 })
  expect(strataKvBytesPerToken({ 'general.architecture': 'qwen35moe' })).toEqual({})
})
