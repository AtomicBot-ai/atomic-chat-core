import { describe, expect, it } from 'vitest'
import { BAKED_TELEMETRY, resolveTelemetryConfig } from './config.js'

const DSN = 'https://key@o1.ingest.us.sentry.io/42'

describe('BAKED_TELEMETRY', () => {
  it('is empty outside the release build', () => {
    expect(BAKED_TELEMETRY).toEqual({})
  })
})

describe('resolveTelemetryConfig', () => {
  it('is off when nothing names a DSN', () => {
    expect(resolveTelemetryConfig({ baked: {}, env: {}, version: '0.3.0' })).toBeNull()
  })

  it('uses the baked DSN, environment and commit', () => {
    const config = resolveTelemetryConfig({
      baked: { dsn: DSN, environment: 'production', gitSha: '97a1e50f00ddeadbeef' },
      env: {},
      version: '0.3.0',
    })
    expect(config).toMatchObject({
      environment: 'production',
      release: 'atomic-chat-core@0.3.0',
      dist: '97a1e50f00dd',
    })
    expect(config?.dsn.projectId).toBe('42')
  })

  it('lets the environment override the baked values', () => {
    const config = resolveTelemetryConfig({
      baked: { dsn: DSN },
      env: { ATOMIC_CORE_SENTRY_DSN: 'http://other@127.0.0.1:9/7', ATOMIC_CORE_SENTRY_ENVIRONMENT: 'smoke' },
      version: '1.0.0',
    })
    expect(config?.dsn.envelopeUrl).toBe('http://127.0.0.1:9/api/7/envelope/')
    expect(config?.environment).toBe('smoke')
    expect(config).not.toHaveProperty('dist')
  })

  it('defaults to production and is off in development', () => {
    expect(resolveTelemetryConfig({ baked: { dsn: DSN }, env: {}, version: '1' })?.environment).toBe(
      'production'
    )
    expect(
      resolveTelemetryConfig({
        baked: { dsn: DSN },
        env: { ATOMIC_CORE_SENTRY_ENVIRONMENT: 'development' },
        version: '1',
      })
    ).toBeNull()
  })

  it('is off for a malformed DSN', () => {
    expect(resolveTelemetryConfig({ baked: { dsn: 'nope' }, env: {}, version: '1' })).toBeNull()
  })
})
