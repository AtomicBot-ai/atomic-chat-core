import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import type { AddressInfo, Socket } from 'node:net'
import type { TLSSocket } from 'node:tls'
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

describe('connectTo: dialling an address while the URL keeps its name', () => {
  const TUNNEL = 'calm-river-demo.trycloudflare.com'
  const tunnelCa = tlsFixture('tunnel.pem')

  /** A TLS server presenting the tunnel-name certificate, standing in for Cloudflare's edge. */
  async function startEdge() {
    const { createServer: createTlsServer } = await import('node:https')
    const seen: Array<{ servername: string | false | null | undefined; host: string | undefined }> = []
    const server = createTlsServer({ key: tlsFixture('tunnel.key'), cert: tunnelCa }, (req, res) => {
      const socket = req.socket as TLSSocket
      seen.push({ servername: socket.servername, host: req.headers.host })
      res.writeHead(200, { 'content-type': 'text/plain' }).end('through the edge')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as AddressInfo).port
    return { port, seen, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
  }

  it('reaches a name that resolves nowhere, with SNI, the certificate check and Host all on that name', async () => {
    const edge = await startEdge()
    try {
      const pinned = createPolicyFetch({ ca: tunnelCa, connectTo: { host: '127.0.0.1', port: edge.port } })
      const res = await pinned(`https://${TUNNEL}/openapi.json`)
      expect(res.status).toBe(200)
      expect(await res.text()).toBe('through the edge')
      expect(edge.seen).toEqual([{ servername: TUNNEL, host: TUNNEL }])
    } finally {
      await edge.close()
    }
  })

  it('still verifies the certificate against the URL, not against the address it dialled', async () => {
    const edge = await startEdge()
    try {
      const pinned = createPolicyFetch({ ca: tunnelCa, connectTo: { host: '127.0.0.1', port: edge.port } })
      // Same server, another tunnel's name: its certificate does not cover it.
      await expect(pinned('https://other-name.trycloudflare.com/openapi.json')).rejects.toThrow(
        /altnames|certificate|hostname/i
      )
      // And without the test CA the stand-in is simply untrusted.
      const untrusted = createPolicyFetch({ connectTo: { host: '127.0.0.1', port: edge.port } })
      await expect(untrusted(`https://${TUNNEL}/openapi.json`)).rejects.toThrow(/self[- ]signed|certificate/i)
    } finally {
      await edge.close()
    }
  })

  it('keeps the port of the URL when only a host is pinned, and leaves the dialling to a proxy when there is one', async () => {
    const plain = createPolicyFetch({ connectTo: { host: '127.0.0.1' } })
    const origin = new URL(s.httpOrigin)
    const res = await plain(`http://name-that-resolves-nowhere.invalid:${origin.port}/echo`)
    expect(res.status).toBe(200)

    const viaProxy = createPolicyFetch({
      proxy: { url: s.httpProxy },
      connectTo: { host: '203.0.113.1', port: 9 },
    })
    expect((await viaProxy(`${s.httpOrigin}/echo`)).status).toBe(200)
    expect(kinds()).toEqual(['http-forward'])
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

  it('aborts while waiting for response headers', async () => {
    const stalled = await rawServer(() => undefined)
    try {
      const controller = new AbortController()
      const pending = createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['*'] } })(stalled.url, {
        signal: controller.signal,
      })
      setTimeout(() => controller.abort(), 30)
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    } finally {
      await stalled.close()
    }
  })

  it('aborts stalled CONNECT, SOCKS5, and TLS handshakes', async () => {
    const cases: Array<(signal: AbortSignal) => Promise<Response>> = []
    const stalled = await rawServer(() => undefined)
    const port = new URL(stalled.url).port
    cases.push(
      (signal) => createPolicyFetch({ proxy: { url: stalled.url } })('https://example.test/file', { signal }),
      (signal) =>
        createPolicyFetch({ proxy: { url: `socks5://127.0.0.1:${port}` } })('http://example.test/file', {
          signal,
        }),
      (signal) =>
        createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['*'] } })(
          `https://127.0.0.1:${port}/file`,
          { signal }
        )
    )
    try {
      for (const start of cases) {
        const controller = new AbortController()
        const pending = start(controller.signal)
        setTimeout(() => controller.abort(), 30)
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      }
    } finally {
      await stalled.close()
    }
  })

  it('rejects truncated Content-Length and chunked bodies', async () => {
    for (const response of [
      'HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nshort',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nabc',
    ]) {
      const raw = await rawServer((socket) => socket.end(response))
      try {
        const res = await createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['*'] } })(raw.url)
        await expect(res.text()).rejects.toThrow(/ended/i)
      } finally {
        await raw.close()
      }
    }
  })

  it('accepts chunk trailers and close-delimited bodies, but rejects malformed chunks', async () => {
    for (const [response, expected] of [
      ['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-Test: yes\r\n\r\n', 'abc'],
      ['HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nclose body', 'close body'],
    ] as const) {
      const raw = await rawServer((socket) => socket.end(response))
      try {
        const res = await createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['*'] } })(raw.url)
        expect(await res.text()).toBe(expected)
      } finally {
        await raw.close()
      }
    }

    for (const malformed of ['Z\r\n', '3\r\nabcXX']) {
      const raw = await rawServer((socket) =>
        socket.end(`HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${malformed}`)
      )
      try {
        const res = await createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['*'] } })(raw.url)
        await expect(res.text()).rejects.toThrow(/invalid chunk/i)
      } finally {
        await raw.close()
      }
    }
  })

  it('cancels an unfinished body and serializes supported request-body types', async () => {
    const stalled = await rawServer((socket) =>
      socket.write('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc')
    )
    try {
      const res = await createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['*'] } })(stalled.url)
      await res.body?.cancel()
    } finally {
      await stalled.close()
    }

    const raw = await rawServer((socket) => socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'))
    try {
      const f = createPolicyFetch({ proxy: { url: s.httpProxy, no_proxy: ['*'] } })
      const bodies: Array<NonNullable<RequestInit['body']>> = [
        'text',
        new Uint8Array([1, 2]),
        new ArrayBuffer(2),
        new Blob(['blob']),
      ]
      for (const body of bodies) expect(await (await f(raw.url, { method: 'POST', body })).text()).toBe('ok')
    } finally {
      await raw.close()
    }
  })

  it('converts POST to GET across a 302 redirect', async () => {
    const f = createPolicyFetch({ proxy: { url: s.httpProxy } })
    const res = await f(`${s.httpOrigin}/redir`, { method: 'POST' })
    expect((await res.json()) as object).toMatchObject({ method: 'GET', url: '/echo' })
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

async function rawServer(
  reply: (socket: Socket) => void
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((socket) => {
    socket.once('data', () => reply(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing test server address')
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      }),
  }
}

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
