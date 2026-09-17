import { describe, expect, it } from 'vitest'
import { OFF, deriveStatus, dialOrigin, failed, hostOf } from './status.js'
import type { Phase } from './status.js'

const URL_ = 'https://calm-river-demo.trycloudflare.com'
const server = { origin: 'http://127.0.0.1:1337', hasApiKey: true }

// The status table of the app's `remote_access/tests.rs` (`derive_status`), state by state.
describe('deriveStatus', () => {
  it.each<[string, Phase, Partial<ReturnType<typeof deriveStatus>>]>([
    ['off', OFF, { state: 'off', canStart: true, canStop: false }],
    ['starting', { kind: 'starting' }, { state: 'starting', canStart: false, canStop: true }],
    ['online', { kind: 'online' }, { state: 'online', url: URL_, canStart: false, canStop: true }],
    ['stopping', { kind: 'stopping' }, { state: 'stopping', canStart: false, canStop: false }],
    ['a failure', failed('no_url'), { state: 'error', error: 'no_url', canStart: true, canStop: false }],
    [
      'a stop that could not be confirmed',
      failed('stop_failed'),
      { state: 'error', error: 'stop_failed', canStart: false, canStop: true },
    ],
  ])('%s, with the server running', (_name, phase, expected) => {
    expect(deriveStatus({ phase, url: URL_ }, server)).toEqual({
      state: 'off',
      url: null,
      error: null,
      blockReason: null,
      canStart: false,
      canStop: false,
      serverHasApiKey: true,
      ...expected,
    })
  })

  it('shows the URL only while online, whatever is still stored', () => {
    for (const phase of [OFF, { kind: 'starting' }, { kind: 'stopping' }, failed('exited')] as Phase[])
      expect(deriveStatus({ phase, url: URL_ }, server).url).toBeNull()
    expect(deriveStatus({ phase: { kind: 'online' }, url: undefined }, server).url).toBeNull()
  })

  it('blocks a start while the public server is stopped, and reports no key for it', () => {
    expect(deriveStatus({ phase: OFF, url: undefined }, undefined)).toMatchObject({
      blockReason: 'server_stopped',
      canStart: false,
      serverHasApiKey: false,
    })
    // Stop stays available for a process that may still be alive, server or not.
    expect(deriveStatus({ phase: failed('stop_failed'), url: undefined }, undefined).canStop).toBe(true)
  })

  it('reports whether the running server was started with a key', () => {
    expect(
      deriveStatus({ phase: OFF, url: undefined }, { ...server, hasApiKey: false }).serverHasApiKey
    ).toBe(false)
  })
})

describe('dialOrigin', () => {
  it.each([
    ['127.0.0.1', 1337, 'http://127.0.0.1:1337'],
    ['0.0.0.0', 1337, 'http://127.0.0.1:1337'],
    ['', 1337, 'http://127.0.0.1:1337'],
    ['::', 1337, 'http://[::1]:1337'],
    ['[::]', 1337, 'http://[::1]:1337'],
    ['192.168.1.5', 8080, 'http://192.168.1.5:8080'],
    ['fd00::10', 1337, 'http://[fd00::10]:1337'],
    ['localhost', 1337, 'http://localhost:1337'],
  ])('%j:%i → %s', (host, port, origin) => expect(dialOrigin(host, port)).toBe(origin))
})

describe('hostOf', () => {
  it('reads the host of a tunnel URL and refuses what is not a URL', () => {
    expect(hostOf(URL_)).toBe('calm-river-demo.trycloudflare.com')
    expect(hostOf(`${URL_}/path?x=1`)).toBe('calm-river-demo.trycloudflare.com')
    expect(hostOf('not a url')).toBeUndefined()
    expect(hostOf('')).toBeUndefined()
  })
})
