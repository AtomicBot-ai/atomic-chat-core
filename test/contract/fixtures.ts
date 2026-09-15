/**
 * Loader for the contract fixtures emitted by the app's Rust tests
 * (`test/fixtures/app/<set>/{index.json,<case>.json}`, imported by `npm run fixtures:import`).
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURES_ROOT = fileURLToPath(new URL('../fixtures/app/', import.meta.url))

export interface FixtureSource {
  file: string
  commit: string
  provider?: string
}

export interface FixtureCase<I, E> {
  name: string
  source: FixtureSource
  comparator: string
  input: I
  expected: E
}

export interface FixtureIndex {
  source: FixtureSource
  comparator: string
  note?: string
  cases: string[]
}

export function loadFixtureSet<I, E>(set: string): { index: FixtureIndex; cases: FixtureCase<I, E>[] } {
  const dir = join(FIXTURES_ROOT, set)
  const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as FixtureIndex
  const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json')
  const cases = files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as FixtureCase<I, E>)
  const missing = index.cases.filter((n) => !cases.some((c) => c.name === n))
  if (missing.length)
    throw new Error(`fixture set ${set}: index lists cases without files: ${missing.join(', ')}`)
  return { index, cases }
}
