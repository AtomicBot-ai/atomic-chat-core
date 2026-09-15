import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPolicyFetch } from '../../src/downloads/proxy-fetch.js'
import { startProxyServers, tlsFixture } from '../helpers/proxy-servers.js'
import type { ProxyServers } from '../helpers/proxy-servers.js'

// The proxied download path must behave the same under Node (vitest) and Bun (`bun test`): the
// failure mode to catch is a runtime that silently sends the request direct instead of through the
// proxy, so every case asserts on what the proxy recorded. PLAN.md §6 risk 13.

let s: ProxyServers
beforeAll(async () => {
  s = await startProxyServers()
})
afterAll(() => s.close())

describe('proxied fetch on this runtime', () => {
  it('goes through CONNECT for https and through SOCKS5 by domain name', async () => {
    s.reset()
    const viaConnect = createPolicyFetch({ proxy: { url: s.httpProxy }, ca: tlsFixture('ca.pem') })
    expect((await viaConnect(`${s.httpsOrigin}/echo`)).status).toBe(200)
    const viaSocks = createPolicyFetch({ proxy: { url: s.socks5 }, ca: tlsFixture('ca.pem') })
    expect((await viaSocks(`${s.httpsOrigin}/echo`)).status).toBe(200)
    expect(s.events().map((e) => e.kind)).toEqual(['http-connect', 'socks5-connect'])
  })

  it('bypasses the proxy only for no_proxy hosts and honours ignore_ssl', async () => {
    s.reset()
    const bypass = createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['127.0.0.1'] } })
    expect((await bypass(`${s.httpOrigin}/echo`)).status).toBe(200)
    expect(s.events()).toEqual([])
    const strict = createPolicyFetch({ proxy: { url: s.httpProxy } })
    await expect(strict(`${s.selfSignedOrigin}/echo`)).rejects.toThrow()
    const relaxed = createPolicyFetch({ proxy: { url: s.httpProxy, ignore_ssl: true } })
    expect((await relaxed(`${s.selfSignedOrigin}/echo`)).status).toBe(200)
    expect(s.events().map((e) => e.kind)).toEqual(['http-connect', 'http-connect'])
  })

  it('streams a ranged body through the tunnel and aborts cleanly', async () => {
    const f = createPolicyFetch({ proxy: { url: s.socks5 } })
    const res = await f(`${s.httpOrigin}/big`, { headers: { Range: 'bytes=4096-' } })
    expect(res.status).toBe(206)
    let total = 0
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) total += chunk.byteLength
    expect(total).toBe(4 * 1024 * 1024 - 4096)
    const controller = new AbortController()
    const slow = await f(`${s.httpOrigin}/big`, { signal: controller.signal })
    const reader = (slow.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
  })
})
