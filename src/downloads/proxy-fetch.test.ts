import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  BIG_SIZE,
  PROXY_PASS,
  PROXY_USER,
  startProxyServers,
  tlsFixture,
} from '../../test/helpers/proxy-servers.js'
import type { ProxyServers } from '../../test/helpers/proxy-servers.js'
import { createPolicyFetch, policyFetchFor, proxyAuthorization } from './proxy-fetch.js'

let s: ProxyServers
beforeAll(async () => {
  s = await startProxyServers()
})
afterAll(() => s.close())
beforeEach(() => s.reset())

const ca = tlsFixture('ca.pem')
const kinds = () => s.events().map((e) => e.kind)

describe('createPolicyFetch through an HTTP proxy', () => {
  it('sends plain http as an absolute-form request through the forward proxy', async () => {
    const f = createPolicyFetch({ proxy: { url: s.httpProxy } })
    const res = await f(`${s.httpOrigin}/echo`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { via: string | null; url: string }
    expect(body.via).toBe('http-proxy')
    expect(body.url).toBe('/echo')
    expect(kinds()).toEqual(['http-forward'])
  })

  it('tunnels https with CONNECT and validates the origin against the given CA', async () => {
    const f = createPolicyFetch({ proxy: { url: s.httpProxy }, ca })
    const res = await f(`${s.httpsOrigin}/echo`)
    expect(((await res.json()) as { origin: string }).origin).toBe('https')
    expect(s.events()).toEqual([
      { kind: 'http-connect', proxy: 'http-proxy', target: new URL(s.httpsOrigin).host },
    ])
  })

  it('fails with 407 without credentials and passes with them (Proxy-Authorization, both forms)', async () => {
    const anonymous = createPolicyFetch({ proxy: { url: s.httpProxyAuth }, ca })
    await expect(anonymous(`${s.httpsOrigin}/echo`)).rejects.toThrow(/HTTP 407/)
    const res = await anonymous(`${s.httpOrigin}/echo`)
    expect(res.status).toBe(407)
    expect(kinds()).toEqual(['http-407', 'http-407'])

    s.reset()
    const withFields = createPolicyFetch({
      proxy: { url: s.httpProxyAuth, username: PROXY_USER, password: PROXY_PASS },
      ca,
    })
    expect((await withFields(`${s.httpsOrigin}/echo`)).status).toBe(200)
    const withUrl = createPolicyFetch({
      proxy: { url: s.httpProxyAuth.replace('://', `://${PROXY_USER}:${PROXY_PASS}@`) },
    })
    expect((await withUrl(`${s.httpOrigin}/echo`)).status).toBe(200)
    expect(kinds()).toEqual(['http-connect', 'http-forward'])
    expect(proxyAuthorization({ url: 'http://p', username: 'a', password: 'b' })).toBe(`Basic ${btoa('a:b')}`)
    expect(proxyAuthorization({ url: 'http://p' })).toBeUndefined()
  })
})

describe('createPolicyFetch through SOCKS5', () => {
  it('connects by domain name, with and without RFC 1929 credentials', async () => {
    const open = createPolicyFetch({ proxy: { url: s.socks5 }, ca })
    expect((await open(`${s.httpsOrigin}/echo`)).status).toBe(200)
    const authed = createPolicyFetch({
      proxy: { url: s.socks5Auth, username: PROXY_USER, password: PROXY_PASS },
    })
    expect(await (await authed(`${s.httpOrigin}/echo`)).json()).toMatchObject({ origin: 'http', via: null })
    expect(s.events()).toEqual([
      { kind: 'socks5-connect', proxy: 'socks5', target: new URL(s.httpsOrigin).host },
      { kind: 'socks5-connect', proxy: 'socks5-auth', target: new URL(s.httpOrigin).host },
    ])
  })

  it('reports rejected credentials and missing auth as tunnel errors', async () => {
    const bad = createPolicyFetch({ proxy: { url: s.socks5Auth, username: PROXY_USER, password: 'nope' } })
    await expect(bad(`${s.httpOrigin}/echo`)).rejects.toThrow(/authentication failed/)
    const none = createPolicyFetch({ proxy: { url: s.socks5Auth } })
    await expect(none(`${s.httpOrigin}/echo`)).rejects.toThrow(/no acceptable auth method/)
    expect(kinds()).toEqual(['socks5-bad-auth', 'socks5-no-auth-method'])
  })

  it('rejects socks4 and unknown schemes before touching the network', async () => {
    await expect(
      createPolicyFetch({ proxy: { url: 'socks4://127.0.0.1:1' } })(`${s.httpsOrigin}/echo`)
    ).rejects.toThrow(/socks4/)
    await expect(
      createPolicyFetch({ proxy: { url: 'ftp://127.0.0.1:1' } })(`${s.httpsOrigin}/echo`)
    ).rejects.toThrow(/unsupported proxy scheme/)
    expect(s.events()).toEqual([])
  })
})

describe('no_proxy and TLS policy', () => {
  it('bypasses the proxy for exact host, wildcard suffix and *', async () => {
    for (const noProxy of [['127.0.0.1'], ['*.0.0.1'], ['*']]) {
      const f = createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: noProxy } })
      expect((await f(`${s.httpOrigin}/echo`)).status).toBe(200)
    }
    expect(s.events()).toEqual([])
    const f = createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['example.com'] } })
    await f(`${s.httpOrigin}/echo`)
    expect(kinds()).toEqual(['http-forward'])
  })

  it('refuses an untrusted certificate unless ignore_ssl is set', async () => {
    const strict = createPolicyFetch({ proxy: { url: s.socks5 } })
    await expect(strict(`${s.selfSignedOrigin}/echo`)).rejects.toThrow(/self[- ]signed|certificate/i)
    const relaxed = createPolicyFetch({ proxy: { url: s.socks5, ignore_ssl: true } })
    expect((await relaxed(`${s.selfSignedOrigin}/echo`)).status).toBe(200)
    expect(kinds()).toEqual(['socks5-connect', 'socks5-connect'])
  })
})

describe('HTTP semantics the downloader relies on', () => {
  it('streams a Range request as 206 with Content-Range through the tunnel, honouring backpressure', async () => {
    const f = createPolicyFetch({ proxy: { url: s.httpProxy }, ca })
    const res = await f(`${s.httpsOrigin}/big`, { headers: { Range: 'bytes=1024-' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe(`bytes 1024-${BIG_SIZE - 1}/${BIG_SIZE}`)
    let total = 0
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) total += chunk.byteLength
    expect(total).toBe(BIG_SIZE - 1024)
  })

  it('handles HEAD, chunked and empty bodies', async () => {
    const f = createPolicyFetch({ proxy: { url: s.httpProxy } })
    const head = await f(`${s.httpOrigin}/big`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe(String(BIG_SIZE))
    expect(head.body).toBeNull()
    expect(await (await f(`${s.httpOrigin}/chunked`)).text()).toBe('abcdef')
    expect(await (await f(`${s.httpOrigin}/empty`)).text()).toBe('')
  })

  it('aborts mid-stream with an AbortError', async () => {
    const f = createPolicyFetch({ proxy: { url: s.socks5 }, ca })
    const controller = new AbortController()
    const res = await f(`${s.httpsOrigin}/big`, { signal: controller.signal })
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toMatchObject({ name: 'AbortError' })
    const early = createPolicyFetch({ proxy: { url: s.httpProxy } })
    await expect(early(`${s.httpOrigin}/echo`, { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('follows redirects with a fresh tunnel per hop, drops Authorization cross-origin, caps loops', async () => {
    const f = createPolicyFetch({ proxy: { url: s.httpProxy }, ca })
    const same = await f(`${s.httpsOrigin}/redir`, { headers: { Authorization: 'Bearer t' } })
    expect((await same.json()) as object).toMatchObject({ origin: 'https', url: '/echo', auth: 'Bearer t' })
    const cross = await f(`${s.httpsOrigin}/redir-cross`, { headers: { Authorization: 'Bearer t' } })
    expect((await cross.json()) as object).toMatchObject({ origin: 'http', auth: null })
    expect(kinds()).toEqual(['http-connect', 'http-connect', 'http-connect', 'http-forward'])
    await expect(f(`${s.httpOrigin}/redir-loop`)).rejects.toThrow(/too many redirects/)
    const manual = await f(`${s.httpOrigin}/redir`, { redirect: 'manual' })
    expect(manual.status).toBe(302)
  })
})

describe('policyFetchFor', () => {
  it('returns the base fetch for items without a proxy and a policy fetch otherwise', async () => {
    const base = (() => Promise.resolve(new Response('base'))) as unknown as typeof fetch
    expect(policyFetchFor({}, base)).toBe(base)
    expect(policyFetchFor({ proxy: null }, base)).toBe(base)
    const f = policyFetchFor({ proxy: { url: s.httpProxy, ignore_ssl: true } }, base)
    expect(f).not.toBe(base)
    expect((await f(`${s.selfSignedOrigin}/echo`)).status).toBe(200)
    expect(kinds()).toEqual(['http-connect'])
  })
})
