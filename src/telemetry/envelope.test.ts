import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { authHeader, buildEnvelope, buildEvent } from './envelope.js'
import type { EventContext } from './envelope.js'
import { parseDsn } from './dsn.js'

const dsn = parseDsn('https://pubkey@o1.ingest.us.sentry.io/42')!

const ctx: EventContext = {
  config: { dsn, environment: 'production', release: 'atomic-chat-core@0.3.0', dist: 'abc123' },
  eventId: 'e'.repeat(32),
  timestamp: 1_700_000_000,
  platform: 'darwin',
  arch: 'arm64',
  coreVersion: '0.3.0',
  ownerScope: 'app',
  userId: 'distinct-1',
  appTags: { gpu_model: 'Apple M3', arch: 'aarch64' },
  breadcrumbs: [{ timestamp: 1, level: 'warning', message: 'slow' }],
  scrub: { dataFolder: '/Users/misha/Library/Atomic', homeDir: '/Users/misha' },
}

describe('buildEvent', () => {
  it('turns a thrown error into a scrubbed, zero-PII exception event', () => {
    const error = new TypeError('cannot read /Users/misha/Library/Atomic/models/x.gguf')
    error.stack = 'TypeError: …\n    at load (src/core/sessions.ts:10:2)\n    at run (src/core/create.ts:1:1)'
    const event = buildEvent(
      {
        source: 'control_route',
        level: 'error',
        error,
        tags: { route: '/models/:id', http_status: 500 },
        extra: { engine_errors: 'failed at /home/bob/x' },
      },
      ctx
    )
    expect(event).toEqual({
      event_id: 'e'.repeat(32),
      timestamp: 1_700_000_000,
      platform: 'node',
      level: 'error',
      logger: 'atomic-chat-core',
      release: 'atomic-chat-core@0.3.0',
      dist: 'abc123',
      environment: 'production',
      sdk: { name: 'atomic-chat-core.telemetry', version: '0.3.0' },
      user: { id: 'distinct-1', ip_address: null },
      contexts: { os: { name: 'darwin' } },
      tags: {
        core_version: '0.3.0',
        arch: 'aarch64',
        owner_scope: 'app',
        gpu_model: 'Apple M3',
        source: 'control_route',
        route: '/models/:id',
        http_status: '500',
      },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'cannot read <data>/models/x.gguf',
            mechanism: { type: 'control_route', handled: true },
            stacktrace: {
              frames: [
                { function: 'run', filename: 'src/core/create.ts', lineno: 1, colno: 1, in_app: true },
                { function: 'load', filename: 'src/core/sessions.ts', lineno: 10, colno: 2, in_app: true },
              ],
            },
          },
        ],
      },
      breadcrumbs: { values: [{ timestamp: 1, level: 'warning', message: 'slow', category: 'log' }] },
      extra: { engine_errors: 'failed at /home/<redacted>/x' },
    })
  })

  it('names a coded core error by its code and marks a fatal one unhandled', () => {
    const error = new AtomicCoreError('OUT_OF_MEMORY', 'Out of memory\nlog…')
    delete error.stack
    const event = buildEvent({ source: 'model_load', level: 'fatal', error, fingerprint: ['a', 'b'] }, ctx)
    expect(event.exception.values[0]).toEqual({
      type: 'OUT_OF_MEMORY',
      value: 'Out of memory',
      mechanism: { type: 'model_load', handled: false },
    })
    expect(event.fingerprint).toEqual(['a', 'b'])
  })

  it('describes what was not an Error without stringifying objects', () => {
    const { dist: _dist, ...config } = ctx.config
    const bare = { ...ctx, breadcrumbs: [], userId: undefined, config }
    const text = buildEvent({ source: 'unhandled_rejection', level: 'fatal', error: 'token hf_abc' }, bare)
    expect(text.exception.values[0]).toMatchObject({ type: 'NonError', value: 'token <redacted>' })
    expect(text.user).toEqual({ ip_address: null })
    expect(text).not.toHaveProperty('dist')
    expect(text).not.toHaveProperty('breadcrumbs')
    expect(text).not.toHaveProperty('extra')
    const object = buildEvent({ source: 'unhandled_rejection', level: 'fatal', error: { prompt: 'x' } }, bare)
    expect(object.exception.values[0]?.value).toBe('A non-Error object was thrown')
    expect(
      buildEvent({ source: 'startup', level: 'fatal', error: null }, bare).exception.values[0]?.value
    ).toBe('A non-Error null was thrown')
    expect(
      buildEvent({ source: 'startup', level: 'fatal', error: '' }, bare).exception.values[0]?.value
    ).toBe('NonError')
    const nameless = Object.assign(new Error(''), { name: '' })
    expect(
      buildEvent({ source: 'startup', level: 'fatal', error: nameless }, bare).exception.values[0]
    ).toMatchObject({ type: 'Error', value: 'Error' })
  })

  it('uses the report type and headline when nothing was thrown', () => {
    const event = buildEvent(
      { source: 'backend_crash', level: 'error', type: 'BackendCrash', message: 'died' },
      ctx
    )
    expect(event.exception.values[0]).toEqual({
      type: 'BackendCrash',
      value: 'died',
      mechanism: { type: 'backend_crash', handled: true },
    })
    const bare = buildEvent({ source: 'inference', level: 'warning' }, ctx)
    expect(bare.exception.values[0]).toMatchObject({ type: 'inference', value: 'inference' })
  })

  it('cuts a long extra value', () => {
    const event = buildEvent({ source: 'inference', level: 'warning', extra: { x: 'y'.repeat(5000) } }, ctx)
    expect(event.extra?.['x']).toHaveLength(4096)
  })
})

describe('buildEnvelope / authHeader', () => {
  it('writes the three newline-separated JSON lines Sentry ingests', () => {
    const event = buildEvent({ source: 'inference', level: 'warning', message: 'x' }, ctx)
    const lines = buildEnvelope(event, dsn, new Date('2026-09-21T00:00:00Z')).split('\n')
    expect(JSON.parse(lines[0]!)).toEqual({
      event_id: 'e'.repeat(32),
      sent_at: '2026-09-21T00:00:00.000Z',
      dsn: 'https://pubkey@o1.ingest.us.sentry.io/42',
    })
    expect(JSON.parse(lines[1]!)).toEqual({ type: 'event' })
    expect(JSON.parse(lines[2]!).event_id).toBe('e'.repeat(32))
    expect(lines[3]).toBe('')
  })

  it('authenticates with the public key', () => {
    expect(authHeader(dsn, '0.3.0')).toBe(
      'Sentry sentry_version=7, sentry_client=atomic-chat-core/0.3.0, sentry_key=pubkey'
    )
  })
})
