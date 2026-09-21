import { describe, expect, it, vi } from 'vitest'
import { parseDsn } from './dsn.js'
import {
  DEDUP_WINDOW_MS,
  ErrorReporter,
  PER_ISSUE_HOURLY_CAP,
  TOTAL_HOURLY_CAP,
  retryAfterMs,
} from './reporter.js'
import type { ErrorReporterOptions } from './reporter.js'
import type { ErrorReport } from './types.js'

const config = {
  dsn: parseDsn('https://pub@o1.ingest.us.sentry.io/42')!,
  environment: 'production',
  release: 'atomic-chat-core@0.3.0',
}

function harness(overrides: Partial<ErrorReporterOptions> = {}) {
  let clock = 1_000_000
  let ids = 0
  const sent: Array<{ url: string; init: RequestInit; event: Record<string, unknown> }> = []
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const lines = String(init?.body).split('\n')
    sent.push({ url: String(url), init: init ?? {}, event: JSON.parse(lines[2] ?? '{}') })
    return new Response(null, { status: 200 })
  })
  const errors: string[] = []
  const reporter = new ErrorReporter({
    config,
    coreVersion: '0.3.0',
    platform: 'linux',
    arch: 'x64',
    ownerScope: 'app',
    enabled: true,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => clock,
    newEventId: () => `id${++ids}`,
    onSendError: (message) => errors.push(message),
    ...overrides,
  })
  return {
    reporter,
    fetch,
    sent,
    errors,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

const report = (over: Partial<ErrorReport> = {}): ErrorReport => ({
  source: 'backend_crash',
  level: 'error',
  type: 'BackendCrash',
  message: 'died',
  fingerprint: ['backend-crash', 'mlx', 'sigsegv'],
  ...over,
})

describe('ErrorReporter', () => {
  it('posts one envelope per report once consent is given', async () => {
    const h = harness()
    h.reporter.update({
      user_id: ' distinct-1 ',
      tags: { 'gpu_model': 'RTX 4090', 'password': 'x', 'bad key': 'y' },
    })
    h.reporter.capture(report())
    await h.reporter.flush()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]?.url).toBe('https://o1.ingest.us.sentry.io/api/42/envelope/')
    expect(h.sent[0]?.init.method).toBe('POST')
    expect(h.sent[0]?.init.headers).toEqual({
      'Content-Type': 'application/x-sentry-envelope',
      'X-Sentry-Auth': 'Sentry sentry_version=7, sentry_client=atomic-chat-core/0.3.0, sentry_key=pub',
    })
    expect(h.sent[0]?.event).toMatchObject({
      event_id: 'id1',
      user: { id: 'distinct-1', ip_address: null },
      tags: { gpu_model: 'RTX 4090', owner_scope: 'app', source: 'backend_crash' },
    })
    expect(h.sent[0]?.event['tags']).not.toHaveProperty('password')
  })

  it('sends nothing without consent, or without a DSN', async () => {
    const off = harness({ enabled: undefined })
    off.reporter.capture(report())
    expect(off.fetch).not.toHaveBeenCalled()
    expect(off.reporter.state()).toEqual({ enabled: false, reporting: false, has_user: false, tags: {} })
    off.reporter.update({ enabled: true })
    off.reporter.capture(report())
    await off.reporter.flush()
    expect(off.fetch).toHaveBeenCalledTimes(1)

    const inert = harness({ config: null })
    inert.reporter.breadcrumb('error', 'x')
    inert.reporter.capture(report())
    expect(inert.fetch).not.toHaveBeenCalled()
    expect(inert.reporter.state()).toMatchObject({ enabled: true, reporting: false })
  })

  it('forgets the user and keeps the other settings on a partial update', () => {
    const h = harness()
    h.reporter.update({ user_id: 'u', tags: { os: 'macOS' } })
    expect(h.reporter.state()).toEqual({
      enabled: true,
      reporting: true,
      has_user: true,
      tags: { os: 'macOS' },
    })
    h.reporter.update({ user_id: null })
    h.reporter.update({ enabled: false })
    expect(h.reporter.state()).toEqual({
      enabled: false,
      reporting: false,
      has_user: false,
      tags: { os: 'macOS' },
    })
  })

  it('collapses an identical event inside the dedup window', async () => {
    const h = harness()
    h.reporter.capture(report())
    h.reporter.capture(report())
    h.advance(DEDUP_WINDOW_MS)
    h.reporter.capture(report())
    await h.reporter.flush()
    expect(h.sent).toHaveLength(2)
  })

  it('groups events without a fingerprint by type, headline and top frame', async () => {
    const h = harness()
    const error = new TypeError('x')
    h.reporter.capture({ source: 'control_route', level: 'error', error })
    h.reporter.capture({ source: 'control_route', level: 'error', error })
    h.reporter.capture({ source: 'control_route', level: 'error', error: new TypeError('y') })
    await h.reporter.flush()
    expect(h.sent).toHaveLength(2)
  })

  it('honours a report throttle', async () => {
    const h = harness()
    const throttled = report({ throttle: { key: 'load:m', windowMs: 300_000 } })
    h.reporter.capture(throttled)
    h.advance(DEDUP_WINDOW_MS)
    h.reporter.capture(throttled)
    h.advance(300_000)
    h.reporter.capture(throttled)
    await h.reporter.flush()
    expect(h.sent).toHaveLength(2)
  })

  it('caps one issue and the total per hour', async () => {
    const h = harness()
    for (let i = 0; i < PER_ISSUE_HOURLY_CAP + 2; i++) {
      h.reporter.capture(report())
      h.advance(DEDUP_WINDOW_MS)
    }
    await h.reporter.flush()
    expect(h.sent).toHaveLength(PER_ISSUE_HOURLY_CAP)

    const t = harness()
    for (let i = 0; i < TOTAL_HOURLY_CAP + 5; i++) t.reporter.capture(report({ fingerprint: [`f${i}`] }))
    await t.reporter.flush()
    expect(t.sent).toHaveLength(TOTAL_HOURLY_CAP)
    t.advance(3_600_000)
    t.reporter.capture(report({ fingerprint: ['after'] }))
    await t.reporter.flush()
    expect(t.sent).toHaveLength(TOTAL_HOURLY_CAP + 1)
  })

  it('stays quiet while Sentry rate-limits us', async () => {
    const h = harness()
    h.fetch.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '120' } }))
    h.reporter.capture(report({ fingerprint: ['a'] }))
    await h.reporter.flush()
    h.reporter.capture(report({ fingerprint: ['b'] }))
    h.advance(120_000)
    h.reporter.capture(report({ fingerprint: ['c'] }))
    await h.reporter.flush()
    expect(h.fetch).toHaveBeenCalledTimes(2)
  })

  it('mentions a rejected or failed send and never throws', async () => {
    const h = harness()
    h.fetch.mockResolvedValueOnce(new Response(null, { status: 413 }))
    h.fetch.mockRejectedValueOnce(new Error('offline'))
    h.fetch.mockRejectedValueOnce('down')
    h.reporter.capture(report({ fingerprint: ['a'] }))
    h.reporter.capture(report({ fingerprint: ['b'] }))
    h.reporter.capture(report({ fingerprint: ['c'] }))
    await h.reporter.flush()
    expect(h.errors).toEqual([
      'error report rejected: HTTP 413',
      'error report not sent: offline',
      'error report not sent: down',
    ])
    const tags = Object.defineProperty({}, 'boom', {
      enumerable: true,
      get() {
        throw new Error('getter')
      },
    })
    expect(() => h.reporter.capture(report({ fingerprint: ['d'], tags }))).not.toThrow()
    const odd = harness({
      newEventId: () => {
        throw 'no id'
      },
    })
    odd.reporter.capture(report())
    expect(h.errors.at(-1)).toBe('error report dropped: getter')
    expect(odd.errors).toEqual(['error report dropped: no id'])
  })

  it('stops waiting for a send after the flush timeout', async () => {
    const h = harness()
    h.fetch.mockImplementationOnce(() => new Promise(() => {}))
    h.reporter.capture(report())
    const started = Date.now()
    await h.reporter.flush(20)
    expect(Date.now() - started).toBeLessThan(1_000)
    await harness().reporter.flush()
  })

  it('attaches the last scrubbed log lines', async () => {
    const h = harness({ scrub: { homeDir: '/home/bob' } })
    for (let i = 0; i < 32; i++) h.reporter.breadcrumb('warning', `line ${i} at /home/bob/x`)
    h.reporter.breadcrumb('error', 'y'.repeat(400))
    h.reporter.setScrubContext({})
    h.reporter.capture(report())
    await h.reporter.flush()
    const values = (h.sent[0]?.event['breadcrumbs'] as { values: Array<{ message: string }> }).values
    expect(values).toHaveLength(30)
    expect(values[0]?.message).toBe('line 3 at ~/x')
    expect(values.at(-1)?.message).toHaveLength(300)
  })
})

describe('ErrorReporter defaults', () => {
  it('sends through the global fetch with random 32-hex event ids', async () => {
    const bodies: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body))
        return new Response(null, { status: 200 })
      })
    )
    try {
      const reporter = new ErrorReporter({
        config,
        coreVersion: '0.3.0',
        platform: 'linux',
        arch: 'x64',
        enabled: true,
      })
      reporter.capture(report())
      await reporter.flush()
      expect(JSON.parse(bodies[0]!.split('\n')[0]!).event_id).toMatch(/^[0-9a-f]{32}$/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('retryAfterMs', () => {
  it.each([
    [{ 'X-Sentry-Rate-Limits': '60:error;transaction:key, 300:transaction:org' }, 60_000],
    [{ 'X-Sentry-Rate-Limits': '30::organization' }, 30_000],
    [{ 'X-Sentry-Rate-Limits': '30:transaction:org', 'Retry-After': '10' }, 10_000],
    [{ 'Retry-After': 'soon' }, 60_000],
    [{}, 60_000],
  ])('%j → %i ms', (headers, ms) => {
    expect(retryAfterMs(new Headers(headers))).toBe(ms)
  })
})
