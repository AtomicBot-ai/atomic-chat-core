/**
 * The checked-in `test/fixtures/app/CHECKSUM` must equal what the importer records today. This is
 * the drift net for hand-edited fixtures: commit e3f3658 added `known_divergence` entries to
 * `backend-select/index.json` without re-recording, and the stale digest sat unnoticed. The walk
 * and hash are exactly `scripts/import-app-fixtures.mjs`'s (see `scripts/lib/fixture-checksum.mjs`);
 * the app repo computes its own digest of its own tree and never reads this file.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { computeFixtureChecksum } from '../../scripts/lib/fixture-checksum.mjs'

const FIXTURES = join(import.meta.dirname, '../fixtures/app')

describe('app fixture checksum', () => {
  it('matches the digest recorded in test/fixtures/app/CHECKSUM', () => {
    const recorded = readFileSync(join(FIXTURES, 'CHECKSUM'), 'utf8').trim()
    expect(recorded).toMatch(/^[0-9a-f]{64}$/)
    expect(computeFixtureChecksum(FIXTURES)).toBe(recorded)
  })
})
