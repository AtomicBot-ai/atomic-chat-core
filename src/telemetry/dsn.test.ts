import { describe, expect, it } from 'vitest'
import { parseDsn } from './dsn.js'

describe('parseDsn', () => {
  it('builds the envelope URL of a SaaS DSN', () => {
    expect(parseDsn('https://abc123@o1.ingest.us.sentry.io/4511')).toEqual({
      dsn: 'https://abc123@o1.ingest.us.sentry.io/4511',
      publicKey: 'abc123',
      host: 'o1.ingest.us.sentry.io',
      projectId: '4511',
      envelopeUrl: 'https://o1.ingest.us.sentry.io/api/4511/envelope/',
    })
  })

  it('keeps a path prefix and a port (a self-hosted relay, the e2e fake)', () => {
    const parsed = parseDsn(' http://key@127.0.0.1:9000/relay/7 ')
    expect(parsed?.envelopeUrl).toBe('http://127.0.0.1:9000/relay/api/7/envelope/')
    expect(parsed?.dsn).toBe('http://key@127.0.0.1:9000/relay/7')
  })

  it.each([
    [undefined],
    [''],
    ['not a url'],
    ['ftp://key@host/1'],
    ['https://o1.ingest.us.sentry.io/4511'],
    ['https://key@o1.ingest.us.sentry.io/'],
    ['https://key@o1.ingest.us.sentry.io/project'],
  ])('rejects %j', (raw) => {
    expect(parseDsn(raw)).toBeNull()
  })
})
