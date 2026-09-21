/**
 * Replay of what the app tells the core about error reporting, dumped from the app's Rust
 * (`src-tauri/src/core/atomic_core/{launch,telemetry}.rs`): the `daemon --telemetry on|off` pair it
 * launches with, and the exact `PUT /atomic/v1/telemetry` bodies its `set_telemetry_*` commands send.
 * The core must accept every one and hold what it says.
 */

import { describe, expect, it } from 'vitest'
import { loadFixtureSet } from './fixtures.js'
import { parseTelemetryUpdate } from '../../src/server/control/routes/telemetry.js'
import { APP_TAG_KEYS, ErrorReporter, parseTelemetryFlag } from '../../src/telemetry/index.js'

type Input =
  | { op: 'launch'; consent: boolean }
  | { op: 'update'; consent: boolean; user_id: string | null; tags: Record<string, string> }
type Expected =
  | { argv_tail: [string, string] }
  | { body: { enabled: boolean; user_id: string | null; tags: Record<string, string> } }

describe('telemetry', () => {
  const { cases } = loadFixtureSet<Input, Expected>('telemetry')

  it('covers both operations', () => {
    expect(new Set(cases.map((c) => c.input.op))).toEqual(new Set(['launch', 'update']))
  })

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    if ('argv_tail' in c.expected) {
      const [flag, value] = c.expected.argv_tail
      expect(flag).toBe('--telemetry')
      expect(parseTelemetryFlag(value)).toBe(c.input.consent)
      return
    }
    const update = parseTelemetryUpdate(c.expected.body)
    if (typeof update === 'string') throw new Error(`the core refused the app's body: ${update}`)
    const reporter = new ErrorReporter({ config: null, coreVersion: '0', platform: 'darwin', arch: 'arm64' })
    reporter.update(update)
    const allowed = Object.fromEntries(
      Object.entries(c.expected.body.tags).filter(([key]) => APP_TAG_KEYS.has(key))
    )
    expect(reporter.state()).toEqual({
      enabled: c.expected.body.enabled,
      reporting: false,
      has_user: c.expected.body.user_id !== null,
      tags: allowed,
    })
  })
})
