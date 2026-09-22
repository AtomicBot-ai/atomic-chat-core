import { describe, expect, it } from 'vitest'
import { BAKED_TELEMETRY, CORE_SENTRY_DSN, isTestRun, resolveTelemetryConfig } from './config.js'

const DSN = 'https://key@o1.ingest.us.sentry.io/42'

describe('BAKED_TELEMETRY', () => {
  it('is empty outside the release build', () => {
    expect(BAKED_TELEMETRY).toEqual({})
  })
})

describe('isTestRun', () => {
  it('knows vitest and a test NODE_ENV', () => {
    expect(isTestRun({ VITEST: 'true' })).toBe(true)
    expect(isTestRun({ NODE_ENV: 'test' })).toBe(true)
    expect(isTestRun({ NODE_ENV: 'production' })).toBe(false)
  })
})

describe('resolveTelemetryConfig', () => {
  it("reports to the core's own project from any build, as `source` unless the release says otherwise", () => {
    const config = resolveTelemetryConfig({ baked: {}, env: {}, version: '0.3.0' })
    expect(config?.dsn.dsn).toBe(CORE_SENTRY_DSN)
    expect(config?.dsn.projectId).toBe('4512125097476096')
    expect(config).toMatchObject({ environment: 'source', release: 'atomic-chat-core@0.3.0' })
  })

  it('never uses the built-in project under a test runner, but honours an explicit DSN there', () => {
    expect(resolveTelemetryConfig({ baked: {}, env: { VITEST: 'true' }, version: '1' })).toBeNull()
    expect(resolveTelemetryConfig({ baked: {}, env: { NODE_ENV: 'test' }, version: '1' })).toBeNull()
    expect(resolveTelemetryConfig({ baked: {}, env: {}, version: '1', testRun: true })).toBeNull()
    const fake = resolveTelemetryConfig({
      baked: {},
      env: { VITEST: 'true', ATOMIC_CORE_SENTRY_DSN: 'http://k@127.0.0.1:9/7' },
      version: '1',
    })
    expect(fake?.dsn.envelopeUrl).toBe('http://127.0.0.1:9/api/7/envelope/')
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

  it('is off in development and for a malformed DSN', () => {
    expect(
      resolveTelemetryConfig({
        baked: {},
        env: { ATOMIC_CORE_SENTRY_ENVIRONMENT: 'development' },
        version: '1',
      })
    ).toBeNull()
    expect(resolveTelemetryConfig({ baked: { dsn: 'nope' }, env: {}, version: '1' })).toBeNull()
  })
})
