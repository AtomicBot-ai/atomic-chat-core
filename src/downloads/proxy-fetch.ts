/**
 * `fetch` for downloads that carry a proxy policy. A dependency-free HTTP/1.1 client over
 * `node:net`/`node:tls` that establishes the tunnel itself (HTTP forward, CONNECT, SOCKS5 with
 * RFC 1929 auth) and applies the TLS policy via `tls.connect`. Chosen over `undici`/agent overrides
 * because it behaves identically on Node, Bun and the compiled binary — see
 * docs/decisions/2026-09-15-proxied-downloads-use-a-raw-socket-client.md.
 *
 * Scope: what the downloader needs. GET/HEAD, status + headers, `Content-Length`/chunked/
 * close-delimited bodies as a `ReadableStream` with backpressure, `AbortSignal`, fetch-shaped
 * redirects (each hop re-evaluates `no_proxy` and opens a fresh tunnel). One connection per request,
 * no content encoding. Downloads without a proxy never come here; the remote-access probe does, for
 * `connectTo` and because it must behave the same under Node, Bun and the compiled binary.
 */

import { connect as netConnect, isIP } from 'node:net'
import type { Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'
import type { ConnectionOptions } from 'node:tls'
import { shouldBypassProxy } from './protocol.js'
import type { ProxyConfig } from './protocol.js'

export interface ProxyPolicy {
  proxy?: ProxyConfig | null
  /** Accept any server certificate (the app's `ignore_ssl`); falls back to `proxy.ignore_ssl`. */
  ignore_ssl?: boolean | null | undefined
  /** Extra trusted CA certificates, PEM. Not exposed by the app today; kept for tests and future policy. */
  ca?: string | Buffer | Array<string | Buffer> | undefined
  /**
   * Dial this address instead of resolving the URL's host, while the TLS server name, certificate
   * verification and `Host` stay the URL's — reqwest's `resolve`. It is how the remote-access probe
   * reaches a new tunnel through Cloudflare's edge before its name resolves anywhere. Ignored when a
   * proxy carries the request: the proxy does the dialling then.
   */
  connectTo?: { host: string; port?: number | undefined } | undefined
}

export const MAX_REDIRECTS = 10
export const PROXY_CONNECT_TIMEOUT_MS = 30_000

type PlainHeaders = Record<string, string>
type RequestBody = NonNullable<RequestInit['body']>
type RequestHeaders = NonNullable<RequestInit['headers']>

export class ProxyTunnelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProxyTunnelError'
  }
}

/** Default `fetchFor` of the downloader: items with a proxy get the policy fetch, others the base. */
export function policyFetchFor(item: { proxy?: ProxyConfig | null }, base: typeof fetch): typeof fetch {
  if (!item.proxy) return base
  return createPolicyFetch({ proxy: item.proxy, ignore_ssl: item.proxy.ignore_ssl })
}

export function createPolicyFetch(policy: ProxyPolicy): typeof fetch {
  const once = async (url: URL, init: RequestInit & { headers?: PlainHeaders }): Promise<Response> => {
    const signal = init.signal ?? null
    throwIfAborted(signal)
    const proxy = policy.proxy ?? null
    const useProxy = proxy !== null && !shouldBypassProxy(url.href, proxy.no_proxy ?? [])
    const isHttps = url.protocol === 'https:'
    if (!isHttps && url.protocol !== 'http:') throw new TypeError(`unsupported URL scheme ${url.protocol}`)
    const port = Number(url.port) || (isHttps ? 443 : 80)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers: PlainHeaders = { host: url.host }
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v
    headers['connection'] = 'close'

    let socket: Socket
    let requestTarget = url.pathname + url.search
    if (useProxy && !isHttps && isHttpProxy(proxy)) {
      // plain HTTP through an HTTP proxy: absolute-form request line, no tunnel
      socket = await connectToProxy(proxy, policy, signal)
      requestTarget = url.href
      const auth = proxyAuthorization(proxy)
      if (auth) headers['proxy-authorization'] = auth
    } else {
      socket = useProxy
        ? await tunnel(proxy, url.hostname, port, policy, signal)
        : await connectTcp(policy.connectTo?.host ?? url.hostname, policy.connectTo?.port ?? port, signal)
      if (isHttps) socket = await upgradeTls(socket, url.hostname, policy, signal)
    }

    const onAbort = () => socket.destroy(abortError())
    if (signal?.aborted) onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('close', () => signal?.removeEventListener('abort', onAbort))

    const head =
      `${method} ${requestTarget} HTTP/1.1\r\n` +
      Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join('') +
      '\r\n'
    socket.write(head)
    if (init.body !== undefined && init.body !== null) socket.write(await bodyBytes(init.body))

    const { status, statusText, headers: responseHeaders, rest } = await readHead(socket, signal)
    const body = bodyStream(socket, rest, responseHeaders, method, status)
    return new Response(body, { status, statusText, headers: responseHeaders })
  }

  return async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const request = input instanceof Request ? input : null
    let url = new URL(request ? request.url : String(input))
    let method = init.method ?? request?.method ?? 'GET'
    let body: RequestBody | null = init.body ?? null
    const headers = headersToPlain(init.headers ?? request?.headers)
    const signal = init.signal ?? request?.signal ?? null
    for (let hop = 0; ; hop++) {
      const res = await once(url, { method, body, headers, signal })
      const location = res.headers.get('location')
      if (![301, 302, 303, 307, 308].includes(res.status) || location === null || init.redirect === 'manual')
        return res
      if (init.redirect === 'error') throw new TypeError('redirect not allowed')
      if (hop >= MAX_REDIRECTS) throw new TypeError('too many redirects')
      await res.body?.cancel()
      const next = new URL(location, url)
      if (url.origin !== next.origin) {
        for (const k of Object.keys(headers))
          if (/^(authorization|proxy-authorization|cookie)$/i.test(k)) delete headers[k]
      }
      if (
        res.status === 303 ||
        ((res.status === 301 || res.status === 302) && method.toUpperCase() === 'POST')
      ) {
        method = 'GET'
        body = null
      }
      url = next
    }
  }
}

// ---- tunnels ---------------------------------------------------------------------------------

function isHttpProxy(proxy: ProxyConfig): boolean {
  const scheme = new URL(proxy.url).protocol
  return scheme === 'http:' || scheme === 'https:'
}

export function proxyAuthorization(proxy: ProxyConfig): string | undefined {
  const url = new URL(proxy.url)
  const user = proxy.username ?? (url.username ? decodeURIComponent(url.username) : '')
  const pass = proxy.password ?? (url.password ? decodeURIComponent(url.password) : '')
  return user ? `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` : undefined
}

function connectTcp(host: string, port: number, signal: AbortSignal | null = null): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, host)
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      const error = abortError()
      socket.destroy()
      reject(error)
    }
    const timer = setTimeout(
      () => socket.destroy(new ProxyTunnelError(`connect ${host}:${port} timed out`)),
      PROXY_CONNECT_TIMEOUT_MS
    )
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    })
    socket.once('error', (e) => {
      if (settled) return
      settled = true
      cleanup()
      reject(e)
    })
  })
}

async function connectToProxy(
  proxy: ProxyConfig,
  policy: ProxyPolicy,
  signal: AbortSignal | null
): Promise<Socket> {
  const url = new URL(proxy.url)
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80)
  const socket = await connectTcp(url.hostname, port, signal)
  return url.protocol === 'https:' ? upgradeTls(socket, url.hostname, policy, signal) : socket
}

/** A raw socket connected to `host:port` through the proxy, ready for the request (or a TLS upgrade). */
export async function tunnel(
  proxy: ProxyConfig,
  host: string,
  port: number,
  policy: ProxyPolicy,
  signal: AbortSignal | null = null
): Promise<Socket> {
  const scheme = new URL(proxy.url).protocol
  if (scheme === 'http:' || scheme === 'https:')
    return connectViaHttpConnect(proxy, host, port, policy, signal)
  if (scheme === 'socks5:' || scheme === 'socks5h:') return connectViaSocks5(proxy, host, port, signal)
  if (scheme === 'socks4:') throw new ProxyTunnelError('socks4 proxies are not supported')
  throw new ProxyTunnelError(`unsupported proxy scheme ${scheme}`)
}

async function connectViaHttpConnect(
  proxy: ProxyConfig,
  host: string,
  port: number,
  policy: ProxyPolicy,
  signal: AbortSignal | null
): Promise<Socket> {
  const socket = await connectToProxy(proxy, policy, signal)
  const auth = proxyAuthorization(proxy)
  socket.write(
    `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n${auth ? `Proxy-Authorization: ${auth}\r\n` : ''}\r\n`
  )
  const { status, rest } = await readHead(socket, signal).catch((e: Error) => {
    socket.destroy()
    if (e.name === 'AbortError') throw e
    throw new ProxyTunnelError(`CONNECT ${host}:${port} via ${new URL(proxy.url).host} failed: ${e.message}`)
  })
  if (status !== 200) {
    socket.destroy()
    throw new ProxyTunnelError(`CONNECT ${host}:${port} via ${new URL(proxy.url).host} -> HTTP ${status}`)
  }
  if (rest.length) socket.unshift(rest)
  return socket
}

/** RFC 1928 CONNECT with domain-name address type; RFC 1929 user/pass when credentials exist. */
async function connectViaSocks5(
  proxy: ProxyConfig,
  host: string,
  port: number,
  signal: AbortSignal | null
): Promise<Socket> {
  const url = new URL(proxy.url)
  const user = proxy.username ?? (url.username ? decodeURIComponent(url.username) : '')
  const pass = proxy.password ?? (url.password ? decodeURIComponent(url.password) : '')
  const socket = await connectTcp(url.hostname, Number(url.port) || 1080, signal)
  const reader = new SocketReader(socket, signal)
  const fail = (msg: string): never => {
    reader.detach()
    socket.destroy()
    throw new ProxyTunnelError(`socks5 via ${url.host}: ${msg}`)
  }
  const read = (count: number) =>
    reader.read(count).catch((error: Error) => {
      if (error.name === 'AbortError') throw error
      return fail(error.message)
    })
  socket.write(Buffer.from(user ? [5, 2, 0, 2] : [5, 1, 0]))
  const greeting = await read(2)
  if (greeting[0] !== 5) fail('bad version')
  if (greeting[1] === 0xff) fail('no acceptable auth method')
  if (greeting[1] === 2) {
    const u = Buffer.from(user)
    const p = Buffer.from(pass)
    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]))
    const reply = await read(2)
    if (reply[1] !== 0) fail('authentication failed')
  } else if (greeting[1] !== 0) fail(`unexpected auth method ${greeting[1]}`)
  const h = Buffer.from(host)
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, h.length]), h, Buffer.from([port >> 8, port & 0xff])]))
  const reply = await read(4)
  if (reply[1] !== 0) fail(`connect rejected (rep=${reply[1]})`)
  const atyp = reply[3]
  if (atyp === 1) await read(4 + 2)
  else if (atyp === 3) {
    const [len] = await read(1)
    await read((len as number) + 2)
  } else if (atyp === 4) await read(16 + 2)
  else fail('bad address type in reply')
  const rest = reader.detach()
  if (rest.length) socket.unshift(rest)
  return socket
}

function upgradeTls(
  socket: Socket,
  servername: string,
  policy: ProxyPolicy,
  signal: AbortSignal | null
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const options: ConnectionOptions = { socket }
    if (!isIP(servername)) options.servername = servername
    if (policy.ignore_ssl ?? policy.proxy?.ignore_ssl) options.rejectUnauthorized = false
    if (policy.ca) options.ca = policy.ca
    const secure = tlsConnect(options)
    let settled = false
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      secure.destroy()
      reject(abortError())
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    secure.once('secureConnect', () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(secure)
    })
    secure.once('error', (e) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(e)
    })
  })
}

// ---- HTTP/1.1 response parsing -------------------------------------------------------------

/** Byte-exact reads from a socket while a handshake is in progress. */
class SocketReader {
  private buf = Buffer.alloc(0)
  private want: { n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void } | null = null
  private readonly onData = (chunk: Buffer) => {
    this.buf = Buffer.concat([this.buf, chunk])
    this.pump()
  }
  private ended: Error | undefined
  private readonly onEnd = () => {
    this.ended ??= new Error('connection closed during handshake')
    this.want?.reject(this.ended)
    this.want = null
  }
  private readonly onAbort = () => {
    this.ended = abortError()
    this.want?.reject(this.ended)
    this.want = null
    this.socket.destroy()
  }
  constructor(
    private readonly socket: Socket,
    private readonly signal: AbortSignal | null
  ) {
    socket.on('data', this.onData)
    socket.once('end', this.onEnd)
    socket.once('error', this.onEnd)
    if (signal?.aborted) this.onAbort()
    else signal?.addEventListener('abort', this.onAbort, { once: true })
  }
  read(n: number): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (this.ended) return reject(this.ended)
      this.want = { n, resolve, reject }
      this.pump()
    })
  }
  private pump() {
    if (this.want && this.buf.length >= this.want.n) {
      const out = this.buf.subarray(0, this.want.n)
      this.buf = this.buf.subarray(this.want.n)
      const { resolve } = this.want
      this.want = null
      resolve(out)
    }
  }
  /** Stop reading and hand back any bytes that arrived after the handshake. */
  detach(): Buffer {
    this.socket.off('data', this.onData)
    this.socket.off('end', this.onEnd)
    this.socket.off('error', this.onEnd)
    this.signal?.removeEventListener('abort', this.onAbort)
    return this.buf
  }
}

interface ResponseHead {
  status: number
  statusText: string
  headers: Headers
  rest: Buffer
}

function readHead(socket: Socket, signal: AbortSignal | null = null): Promise<ResponseHead> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('end', onEnd)
      signal?.removeEventListener('abort', onAbort)
    }
    const onError = (e: Error) => {
      cleanup()
      reject(e)
    }
    const onEnd = () => onError(new Error('connection closed before response head'))
    const onAbort = () => {
      socket.destroy()
      onError(abortError())
    }
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      const i = buf.indexOf('\r\n\r\n')
      if (i < 0) return
      cleanup()
      const lines = buf.subarray(0, i).toString('latin1').split('\r\n')
      const m = /^HTTP\/1\.[01] (\d{3}) ?(.*)$/.exec(lines[0] ?? '')
      if (!m) return reject(new Error(`bad status line: ${lines[0]}`))
      const headers = new Headers()
      for (const line of lines.slice(1)) {
        const j = line.indexOf(':')
        if (j > 0) headers.append(line.slice(0, j).trim().toLowerCase(), line.slice(j + 1).trim())
      }
      resolve({ status: Number(m[1]), statusText: m[2] ?? '', headers, rest: buf.subarray(i + 4) })
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('end', onEnd)
  })
}

interface Decoder {
  feed: (chunk: Buffer) => { out: Buffer[]; done: boolean }
  finish: () => Error | undefined
}

function makeDecoder(headers: Headers): Decoder {
  const te = headers.get('transfer-encoding')
  if (te && /chunked/i.test(te)) {
    let buf = Buffer.alloc(0)
    let size = -1
    let terminal = false
    let done = false
    return {
      feed(chunk) {
        buf = Buffer.concat([buf, chunk])
        const out: Buffer[] = []
        for (;;) {
          if (terminal) {
            if (buf.subarray(0, 2).equals(Buffer.from('\r\n'))) {
              done = true
              return { out, done }
            }
            const trailersEnd = buf.indexOf('\r\n\r\n')
            if (trailersEnd < 0) return { out, done: false }
            done = true
            return { out, done }
          }
          if (size < 0) {
            const i = buf.indexOf('\r\n')
            if (i < 0) return { out, done: false }
            const line = buf.subarray(0, i).toString('latin1').split(';', 1)[0]?.trim() ?? ''
            if (!/^[0-9a-f]+$/i.test(line)) throw new ProxyTunnelError('invalid chunk size')
            size = Number.parseInt(line, 16)
            buf = buf.subarray(i + 2)
            if (size === 0) {
              terminal = true
              continue
            }
          }
          if (buf.length < size + 2) return { out, done: false }
          if (buf[size] !== 13 || buf[size + 1] !== 10) throw new ProxyTunnelError('invalid chunk terminator')
          out.push(buf.subarray(0, size))
          buf = buf.subarray(size + 2)
          size = -1
        }
      },
      finish: () => (done ? undefined : new ProxyTunnelError('response ended before the final chunk')),
    }
  }
  const cl = headers.get('content-length')
  if (cl !== null) {
    let left = Number(cl)
    if (!Number.isSafeInteger(left) || left < 0) throw new ProxyTunnelError('invalid Content-Length')
    return {
      feed(chunk) {
        const take = chunk.subarray(0, left)
        left -= take.length
        return { out: take.length ? [take] : [], done: left === 0 }
      },
      finish: () =>
        left === 0
          ? undefined
          : new ProxyTunnelError(`response ended with ${left} Content-Length bytes missing`),
    }
  }
  return {
    feed: (chunk) => ({ out: [chunk], done: false }),
    finish: () => undefined,
  } // delimited by connection close
}

function bodyStream(
  socket: Socket,
  rest: Buffer,
  headers: Headers,
  method: string,
  status: number
): ReadableStream<Uint8Array> | null {
  if (method === 'HEAD' || status === 204 || status === 304 || status === 101) {
    socket.destroy()
    return null
  }
  const decode = makeDecoder(headers)
  const cl = headers.get('content-length')
  if (cl !== null && Number(cl) === 0 && rest.length === 0) {
    socket.destroy()
    return null
  }
  let closed = false
  const close = (ctrl: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return
    closed = true
    try {
      ctrl.close()
    } catch {
      /* already closed */
    }
    socket.destroy()
  }
  return new ReadableStream<Uint8Array>(
    {
      start(ctrl) {
        const feed = (chunk: Buffer) => {
          try {
            const { out, done } = decode.feed(chunk)
            for (const b of out) ctrl.enqueue(new Uint8Array(b))
            if (done) close(ctrl)
            else if (ctrl.desiredSize !== null && ctrl.desiredSize <= 0) socket.pause()
          } catch (error) {
            closed = true
            ctrl.error(error)
            socket.destroy()
          }
        }
        socket.on('data', feed)
        socket.on('end', () => {
          if (closed) return
          const error = decode.finish()
          if (error) {
            closed = true
            ctrl.error(error)
          } else close(ctrl)
        })
        socket.on('error', (e) => {
          if (closed) return
          closed = true
          try {
            ctrl.error(e)
          } catch {
            /* stream already errored */
          }
        })
        if (rest.length) feed(rest)
      },
      pull() {
        socket.resume()
      },
      cancel() {
        closed = true
        socket.destroy()
      },
    },
    { highWaterMark: 4 * 1024 * 1024, size: (chunk) => chunk.byteLength }
  )
}

// ---- small helpers ---------------------------------------------------------------------------

function abortError(): Error {
  return new DOMException('This operation was aborted', 'AbortError')
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) throw abortError()
}

function headersToPlain(headers: RequestHeaders | undefined): PlainHeaders {
  const out: PlainHeaders = {}
  if (!headers) return out
  if (headers instanceof Headers) headers.forEach((v, k) => (out[k] = v))
  else if (Array.isArray(headers)) for (const pair of headers) out[String(pair[0])] = String(pair[1])
  else for (const [k, v] of Object.entries(headers)) out[k] = String(v)
  return out
}

async function bodyBytes(body: RequestBody): Promise<Buffer> {
  if (typeof body === 'string') return Buffer.from(body)
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  return Buffer.from(await new Response(body).arrayBuffer())
}
