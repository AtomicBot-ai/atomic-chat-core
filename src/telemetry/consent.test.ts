import { describe, expect, it } from 'vitest'
import { envConsent, resolveConsent } from './consent.js'

describe('envConsent', () => {
  it.each([
    [{}, undefined],
    [{ DO_NOT_TRACK: '1' }, false],
    [{ DO_NOT_TRACK: 'true', ATOMIC_CORE_TELEMETRY: 'on' }, false],
    [{ DO_NOT_TRACK: '0' }, undefined],
    [{ ATOMIC_CORE_TELEMETRY: 'off' }, false],
    [{ ATOMIC_CORE_TELEMETRY: ' 0 ' }, false],
    [{ ATOMIC_CORE_TELEMETRY: 'ON' }, true],
    [{ ATOMIC_CORE_TELEMETRY: 'maybe' }, undefined],
  ])('%j → %s', (env, consent) => {
    expect(envConsent(env)).toBe(consent)
  })
})

describe('resolveConsent', () => {
  it.each([
    [{}, { enabled: true, source: 'default' }],
    [{ stored: false }, { enabled: false, source: 'stored' }],
    [
      { env: true, stored: false },
      { enabled: true, source: 'env' },
    ],
    [
      { host: false, env: true },
      { enabled: false, source: 'host' },
    ],
    [
      { host: true, stored: false },
      { enabled: true, source: 'host' },
    ],
    [
      { env: false, host: true },
      { enabled: false, source: 'env' },
    ],
  ])('%j → %j', (input, decision) => {
    expect(resolveConsent(input)).toEqual(decision)
  })
})
