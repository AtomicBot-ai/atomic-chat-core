import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPolicyFetch } from '../../src/downloads/proxy-fetch.js'
import { startProxyServers, tlsFixture } from '../helpers/proxy-servers.js'
import type { ProxyServers } from '../helpers/proxy-servers.js'

// The proxied download path must behave the same under Node (vitest) and Bun (`bun test`): the
// failure mode to catch is a runtime that silently sends the request direct instead of through the
// proxy, so every case asserts on what the proxy recorded. PLAN.md §6 risk 13.
//
// Rejections are awaited directly, not through `expect(promise).rejects`: under `bun test` 1.3.10 on
// macOS that matcher intermittently segfaults Bun's event loop after a failed TLS handshake.

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
    expect(await strict(`${s.selfSignedOrigin}/echo`).catch((e: unknown) => e)).toBeInstanceOf(Error)
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
    expect(await reader.read().catch((e: unknown) => e)).toMatchObject({ name: 'AbortError' })
  })
})
