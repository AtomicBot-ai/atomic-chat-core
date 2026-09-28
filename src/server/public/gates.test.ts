import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { extractHostFromOrigin, hostAndKeyGate, isValidHost, removePrefix } from './gates.js'

/** A request as `hostAndKeyGate` reads it: only `.headers` matters. */
function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage
}

describe('removePrefix', () => {
  it('strips the prefix as a string, not a path segment', () => {
    expect(removePrefix('/v1models', '/v1')).toBe('/models')
    expect(removePrefix('/v1', '/v1')).toBe('/')
    expect(removePrefix('/other', '/v1')).toBe('/other')
    expect(removePrefix('/models', '')).toBe('/models')
  })
})

describe('isValidHost', () => {
  it('matches trusted hosts with and without ports, and bracketed IPv6', () => {
    expect(isValidHost('[fe80::1]:8080', ['[fe80::1]'])).toBe(true)
    expect(isValidHost('lan.example:1', ['lan.example:9999'])).toBe(true)
    expect(isValidHost('LOCALHOST:1337', [])).toBe(true)
    expect(isValidHost('', ['lan.example'])).toBe(false)
    expect(isValidHost('', ['*'])).toBe(true)
  })

  it('does not trust the IPv6 loopback by default', () => {
    expect(isValidHost('[::1]:1337', [])).toBe(false)
  })
})

describe('extractHostFromOrigin', () => {
  it('keeps host and port and drops scheme and path', () => {
    expect(extractHostFromOrigin('http://a.example:3000/path')).toBe('a.example:3000')
    expect(extractHostFromOrigin('null')).toBe('null')
  })
})

describe('hostAndKeyGate', () => {
  const config = { apiKey: 'secret', trustedHosts: ['lan.example'] }

  it.each([
    ['missing host header', {}, 400],
    [
      'untrusted host, even with the right key',
      { host: 'evil.example', authorization: 'Bearer secret' },
      403,
    ],
    ['trusted host, no key at all', { host: '127.0.0.1' }, 401],
    ['trusted host, wrong key', { host: '127.0.0.1', authorization: 'Bearer nope' }, 401],
    [
      'trusted host, lowercase bearer scheme rejected',
      { host: '127.0.0.1', authorization: 'bearer secret' },
      401,
    ],
  ])('%s -> %d', (_label, headers, status) => {
    expect(hostAndKeyGate(req(headers), config)?.status).toBe(status)
  })

  it.each([
    ['loopback host, Bearer key', { host: '127.0.0.1', authorization: 'Bearer secret' }],
    ['configured trusted host, x-api-key', { 'host': 'lan.example', 'x-api-key': 'secret' }],
  ])('%s passes', (_label, headers) => {
    expect(hostAndKeyGate(req(headers), config)).toBeUndefined()
  })

  it('skips the key check entirely when the config key is empty (host still enforced)', () => {
    const open = { apiKey: '', trustedHosts: [] }
    expect(hostAndKeyGate(req({ host: '127.0.0.1' }), open)).toBeUndefined()
    expect(hostAndKeyGate(req({ host: 'evil.example' }), open)?.status).toBe(403)
  })

  it('never returns CORS headers or a hidden-path 404: callers with no docs paths get only host/key', () => {
    const refused = hostAndKeyGate(req({}), config)
    expect(refused?.headers).toEqual([])
  })
})
