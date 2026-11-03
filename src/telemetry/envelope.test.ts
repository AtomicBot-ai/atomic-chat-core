import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { authHeader, buildEnvelope, buildEvent } from './envelope.js'
import type { EventContext } from './envelope.js'
import { parseDsn } from './dsn.js'
import type { ErrorReport } from './types.js'

const dsn = parseDsn('https://pubkey@o1.ingest.us.sentry.io/42')!

const ctx: EventContext = {
  config: { dsn, environment: 'production', release: 'atomic-chat-core@0.3.0', dist: 'abc123' },
  eventId: 'e'.repeat(32),
  timestamp: 1_700_000_000,
  platform: 'darwin',
  arch: 'arm64',
  coreVersion: '0.3.0',
  ownerScope: 'app',
  host: 'atomic-chat',
  hostVersion: '2.0.44',
  system: { osRelease: '25.5.0', cpuModel: 'Apple M3', memoryMb: 16384 },
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
      fingerprint: ['core-v1', 'http', 'request', '', 'internal', '', '', 'src/core/sessions.ts:10:2'],
      release: 'atomic-chat-core@0.3.0',
      dist: 'abc123',
      environment: 'production',
      sdk: { name: 'atomic-chat-core.telemetry', version: '0.3.0' },
      user: { id: 'distinct-1', ip_address: null },
      contexts: {
        os: { name: 'darwin', version: '25.5.0' },
        device: { arch: 'arm64', memory_size: 16 * 1024 * 1024 * 1024 },
      },
      tags: {
        core_version: '0.3.0',
        arch: 'aarch64',
        owner_scope: 'app',
        host: 'atomic-chat',
        host_version: '2.0.44',
        cpu_model: 'Apple M3',
        system_ram_mb: '16384',
        gpu_model: 'Apple M3',
        diagnostic_version: 'core-v1',
        component: 'http',
        operation: 'request',
        failure_category: 'defect',
        failure_reason: 'internal',
        source: 'control_route',
        http_status: '500',
      },
      exception: {
        values: [
          {
            type: 'TypeError',
            value: 'http request: internal',
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
    })
  })

  it('names a coded core error by its code and marks a fatal one unhandled', () => {
    const error = new AtomicCoreError('OUT_OF_MEMORY', 'Out of memory\nlog…')
    delete error.stack
    const event = buildEvent({ source: 'model_load', level: 'fatal', error, fingerprint: ['a', 'b'] }, ctx)
    expect(event.exception.values[0]).toEqual({
      type: 'OUT_OF_MEMORY',
      value: 'runtime load: out_of_memory',
      mechanism: { type: 'model_load', handled: false },
    })
    expect(event.fingerprint).toEqual([
      'core-v1',
      'runtime',
      'load',
      '',
      'out_of_memory',
      '',
      'OUT_OF_MEMORY',
      'out_of_memory',
    ])
  })

  it('describes what was not an Error without stringifying objects', () => {
    const { dist: _dist, ...config } = ctx.config
    const bare = { ...ctx, breadcrumbs: [], userId: undefined, config }
    const text = buildEvent({ source: 'unhandled_rejection', level: 'fatal', error: 'token hf_abc' }, bare)
    expect(text.exception.values[0]).toMatchObject({ type: 'NonError', value: 'core event: unknown' })
    expect(text.user).toEqual({ ip_address: null })
    expect(text).not.toHaveProperty('dist')
    expect(text).not.toHaveProperty('breadcrumbs')
    expect(text).not.toHaveProperty('extra')
    const object = buildEvent({ source: 'unhandled_rejection', level: 'fatal', error: { prompt: 'x' } }, bare)
    expect(object.exception.values[0]?.value).toBe('core event: unknown')
    expect(
      buildEvent({ source: 'startup', level: 'fatal', error: null }, bare).exception.values[0]?.value
    ).toBe('core startup: unknown')
    expect(
      buildEvent({ source: 'startup', level: 'fatal', error: '' }, bare).exception.values[0]?.value
    ).toBe('core startup: unknown')
    const nameless = Object.assign(new Error(''), { name: '' })
    expect(
      buildEvent({ source: 'startup', level: 'fatal', error: nameless }, bare).exception.values[0]
    ).toMatchObject({ type: 'Error', value: 'core startup: unknown' })
  })

  it('uses a safe report type and finite reason when nothing was thrown', () => {
    const event = buildEvent(
      { source: 'backend_crash', level: 'error', type: 'BackendCrash', message: 'died' },
      ctx
    )
    expect(event.exception.values[0]).toEqual({
      type: 'BackendCrash',
      value: 'runtime exit: process_exit',
      mechanism: { type: 'backend_crash', handled: true },
    })
    const bare = buildEvent({ source: 'inference', level: 'warning' }, ctx)
    expect(bare.exception.values[0]).toMatchObject({
      type: 'inference',
      value: 'runtime inference: upstream',
    })
    const unsafe = buildEvent({ source: 'inference', level: 'error', type: 'private prompt' }, ctx)
    expect(unsafe.exception.values[0]?.type).toBe('inference')
  })

  it('drops extra values instead of attempting to recognize arbitrary private content', () => {
    const event = buildEvent({ source: 'inference', level: 'warning', extra: { x: 'y'.repeat(5000) } }, ctx)
    expect(event).not.toHaveProperty('extra')
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

it('bounded cause metadata and new observer envelopes contain no arbitrary payloads', () => {
  const cause = Object.assign(new Error('private prompt and token'), { code: 'ENOSPC' })
  cause.stack = 'Error: private prompt\n at write (/Users/private/src/downloads/downloader.ts:12:4)'
  const error = new AtomicCoreError('IO_ERROR', 'private request body', 'raw stderr', { cause })
  error.stack = 'Error: body\n at run (src/core/create.ts:14:2)'
  const event = buildEvent(
    {
      source: 'operation',
      level: 'warning',
      error,
      diagnostic: { component: 'downloads', operation: 'download' },
    },
    ctx
  )
  const text = JSON.stringify(event)
  for (const forbidden of ['private', 'request body', 'raw stderr']) expect(text).not.toContain(forbidden)
  expect(event.exception.values).toHaveLength(2)
  expect(event.tags['cause_code']).toBe('ENOSPC')
  expect(event.exception.values[0]?.stacktrace?.frames[0]?.filename).toBe('src/downloads/downloader.ts')
})

it.each(['TypeError', 'private user prompt'])('bounds cause type %s without sending its text', (name) => {
  const cause = Object.assign(new Error('sensitive body'), { name })
  const event = buildEvent({ source: 'operation', level: 'fatal', error: new Error('outer', { cause }) }, ctx)
  expect(event.exception.values[0]).toMatchObject({
    type: name === 'TypeError' ? name : 'Error',
    value: 'Underlying failure',
    mechanism: { handled: false },
  })
  expect(JSON.stringify(event)).not.toContain('sensitive body')
  expect(JSON.stringify(event)).not.toContain('private user prompt')
})

it('does not use an arbitrary error name as an exception type', () => {
  const error = Object.assign(new Error('safe headline'), { name: '/Users/private/user prompt' })
  const event = buildEvent({ source: 'operation', level: 'error', error }, ctx)
  expect(event.exception.values.at(-1)?.type).toBe('Error')
  expect(JSON.stringify(event)).not.toContain('/Users/private')
})

it.each<ErrorReport['source']>([
  'operation',
  'startup',
  'uncaught_exception',
  'unhandled_rejection',
  'event_listener',
  'control_route',
  'public_server',
  'model_load',
  'backend_crash',
  'inference',
  'diffusion_load',
  'diffusion_job',
  'audio_load',
  'audio_job',
])('excludes free text from the entire %s envelope', (source) => {
  const privateText = 'My secret prompt at /private/project/user-model with a custom-secret-value'
  const error = new AtomicCoreError('IO_ERROR', privateText, privateText, {
    cause: new Error(privateText),
  })
  const event = buildEvent(
    {
      source,
      level: 'error',
      error,
      message: privateText,
      tags: {
        model_id: privateText,
        route: privateText,
        request_body: privateText,
        backend: 'b1234',
        oom_subtype: 'cuda',
      },
      extra: { engine_errors: privateText },
    },
    { ...ctx, breadcrumbs: [{ timestamp: 1, level: 'warning', message: privateText }] }
  )
  const envelope = buildEnvelope(event, dsn, new Date(0))
  for (const text of ['My secret prompt', '/private/project', 'custom-secret-value', 'user-model'])
    expect(envelope).not.toContain(text)
  expect(event.tags).toMatchObject({ backend: 'b1234', oom_subtype: 'cuda' })
  expect(event).not.toHaveProperty('extra')
  expect(event).not.toHaveProperty('breadcrumbs')
})

it('does not transmit private values that resemble error codes or class names', () => {
  const cause = Object.assign(new Error(), { name: 'PrivateAccountID', code: 'CUSTOM_PRIVATE_TOKEN' })
  const outer = Object.assign(new Error('', { cause }), { name: 'PrivateOuterName' })
  const event = buildEvent({ source: 'operation', level: 'error', error: outer }, ctx)
  expect(event.exception.values.map((entry) => entry.type)).toEqual(['Error', 'Error'])
  expect(event.tags).not.toHaveProperty('cause_code')
  expect(JSON.stringify(event)).not.toMatch(/PrivateAccountID|CUSTOM_PRIVATE_TOKEN|PrivateOuterName/)
})

it('keeps apparent stack frames in a multiline message out of causes and grouping', () => {
  const text = 'Bad input\n    at userPrompt (src/private/account-secret.ts:3:4)'
  const cause = new Error(text)
  cause.stack = `Error: ${text}\n    at load (src/settings/store.ts:12:1)`
  const error = new Error(text, { cause })
  error.stack = `Error: ${text}\n    at run (src/core/create.ts:31:1)`
  const event = buildEvent({ source: 'operation', level: 'error', error }, ctx)
  expect(JSON.stringify(event)).not.toMatch(/userPrompt|account-secret|Bad input/)
  expect(event.fingerprint).toContain('src/settings/store.ts:12:1')
  expect(event.exception.values.map((entry) => entry.stacktrace?.frames.length)).toEqual([1, 1])
})
