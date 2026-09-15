#!/usr/bin/env node
// Per-file coverage ratchet (copied convention from ../Atomic-Chat/scripts/check-coverage-floor.mjs).
// Floors in test/coverage-floor.json only go up. Run after `vitest --coverage` (json-summary reporter).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const floorsPath = join(ROOT, 'test/coverage-floor.json')
const summaryPath = join(ROOT, 'coverage/coverage-summary.json')

const floors = JSON.parse(readFileSync(floorsPath, 'utf8'))
const entries = Object.entries(floors)
if (entries.length === 0) {
  console.log('coverage-floor: no floors configured yet')
  process.exit(0)
}
if (!existsSync(summaryPath)) {
  console.error(`coverage-floor: ${summaryPath} not found — run vitest with --coverage first`)
  process.exit(1)
}
const summary = JSON.parse(readFileSync(summaryPath, 'utf8'))
const byFile = new Map(Object.entries(summary).map(([k, v]) => [k.replace(ROOT, '').replace(/^\//, ''), v]))

const METRICS = ['statements', 'branches', 'functions', 'lines']
const failures = []
for (const [file, floor] of entries) {
  const actual = byFile.get(file)
  if (!actual) {
    failures.push(`${file}: not in coverage summary`)
    continue
  }
  for (const m of METRICS) {
    if (floor[m] === undefined) continue
    if (actual[m].pct + 1e-9 < floor[m]) failures.push(`${file}: ${m} ${actual[m].pct}% < floor ${floor[m]}%`)
  }
}

if (failures.length) {
  console.error('Coverage floor failures:\n' + failures.map((f) => `  ${f}`).join('\n'))
  process.exit(1)
}
console.log(`coverage-floor: ok (${entries.length} files)`)
