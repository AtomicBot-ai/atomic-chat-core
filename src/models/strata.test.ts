import { expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { readStrataBlock } from './strata.js'
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
