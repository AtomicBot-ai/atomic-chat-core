/**
 * Loopback servers for proxy/TLS tests: HTTP and HTTPS origins, an HTTP forward+CONNECT proxy (open
 * or Basic-auth), a SOCKS5 proxy (open or RFC 1929 user/pass), and a journal of what the proxies saw.
 * A test that only checks the downloaded bytes cannot tell a proxied transfer from a direct one,
 * so assert on `events()` too. Runs under Node and `bun test`; no dependencies.
 */
import { readFileSync } from 'node:fs'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { createServer as createNetServer, connect as netConnect } from 'node:net'
import type { Server as NetServer, Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TLS_DIR = fileURLToPath(new URL('../fixtures/tls/', import.meta.url))
export const tlsFixture = (name: string): Buffer => readFileSync(join(TLS_DIR, name))

export const PROXY_USER = 'proxyuser'
export const PROXY_PASS = 'proxypass'
export const BIG_SIZE = 4 * 1024 * 1024

export interface ProxyEvent {
  kind:
    | 'http-forward'
    | 'http-connect'
    | 'http-407'
    | 'socks5-connect'
    | 'socks5-bad-auth'
    | 'socks5-no-auth-method'
  proxy: string
  target?: string
}

export interface ProxyServers {
  httpOrigin: string
  httpsOrigin: string
  selfSignedOrigin: string
  httpProxy: string
  httpProxyAuth: string
  socks5: string
  socks5Auth: string
  events: () => ProxyEvent[]
  reset: () => void
  close: () => Promise<void>
}

function origin(name: string, ports: () => { httpOrigin: number }) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? '/'
    if (url === '/redir') {
      res.writeHead(302, { location: '/echo' })
      return res.end()
    }
    if (url === '/redir-cross') {
      res.writeHead(307, { location: `http://127.0.0.1:${ports().httpOrigin}/echo` })
      return res.end()
    }
    if (url === '/redir-loop') {
      res.writeHead(302, { location: '/redir-loop' })
      return res.end()
    }
    if (url === '/chunked') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('ab')
      res.write('cd')
      return res.end('ef')
    }
    if (url === '/empty') {
      res.writeHead(200, { 'content-length': '0' })
      return res.end()
    }
    if (url.startsWith('/big')) {
      const m = /^bytes=(\d+)-/.exec(req.headers.range ?? '')
      const start = m ? Number(m[1]) : 0
      res.writeHead(m ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(BIG_SIZE - start),
        'accept-ranges': 'bytes',
        ...(m ? { 'content-range': `bytes ${start}-${BIG_SIZE - 1}/${BIG_SIZE}` } : {}),
      })
      if (req.method === 'HEAD') return res.end()
      let sent = start
      const chunk = Buffer.alloc(64 * 1024, 0x61)
      const pump = () => {
        while (sent < BIG_SIZE) {
          const n = Math.min(chunk.length, BIG_SIZE - sent)
          sent += n
          if (!res.write(chunk.subarray(0, n))) return res.once('drain', pump)
        }
        res.end()
      }
      return pump()
    }
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        origin: name,
        method: req.method,
        url,
        via: req.headers['x-via-proxy'] ?? null,
        auth: req.headers['authorization'] ?? null,
      })
    )
  }
}

const okAuth = (header: string | undefined) =>
  header === `Basic ${Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString('base64')}`

function makeHttpProxy(name: string, auth: boolean, record: (e: ProxyEvent) => void): Server {
  const server = createHttpServer((req, res) => {
    if (auth && !okAuth(req.headers['proxy-authorization'])) {
      record({ kind: 'http-407', proxy: name, target: req.url ?? '' })
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' })
      return res.end()
    }
    let target: URL
    try {
      target = new URL(req.url ?? '')
    } catch {
      res.writeHead(400)
      return res.end('forward proxy needs an absolute URI')
    }
    record({ kind: 'http-forward', proxy: name, target: target.href })
    const headers: Record<string, string | string[] | undefined> = { ...req.headers, 'x-via-proxy': name }
    delete headers['proxy-authorization']
    delete headers['proxy-connection']
    const up = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (ur) => {
        res.writeHead(ur.statusCode ?? 502, { ...ur.headers, 'x-via-proxy': name })
        ur.pipe(res)
      }
    )
    up.on('error', (e) => {
      res.writeHead(502)
      res.end(String(e))
    })
    req.pipe(up)
  })
  server.on('connect', (req, socket: Socket, head: Buffer) => {
    if (auth && !okAuth(req.headers['proxy-authorization'])) {
      record({ kind: 'http-407', proxy: name, target: req.url ?? '' })
      socket.end(
        'HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="test"\r\nContent-Length: 0\r\n\r\n'
      )
      return
    }
    const [host, port] = (req.url ?? '').split(':')
    record({ kind: 'http-connect', proxy: name, target: req.url ?? '' })
    const up = netConnect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    up.on('error', () => socket.destroy())
    socket.on('error', () => up.destroy())
  })
  return server
}

function makeSocks5(name: string, auth: boolean, record: (e: ProxyEvent) => void): NetServer {
  return createNetServer((sock) => {
    let buf = Buffer.alloc(0)
    let stage: 'greeting' | 'auth' | 'request' | 'tunnel' = 'greeting'
    sock.on('error', () => {})
    sock.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        if (stage === 'greeting') {
          if (buf.length < 2) return
          const n = buf[1] as number
          if (buf.length < 2 + n) return
          if (buf[0] !== 5) return sock.destroy()
          const methods = [...buf.subarray(2, 2 + n)]
          buf = buf.subarray(2 + n)
          if (auth) {
            if (!methods.includes(2)) {
              record({ kind: 'socks5-no-auth-method', proxy: name })
              return sock.end(Buffer.from([5, 0xff]))
            }
            sock.write(Buffer.from([5, 2]))
            stage = 'auth'
          } else {
            sock.write(Buffer.from([5, 0]))
            stage = 'request'
          }
        } else if (stage === 'auth') {
          if (buf.length < 2) return
          const ulen = buf[1] as number
          if (buf.length < 3 + ulen) return
          const plen = buf[2 + ulen] as number
          if (buf.length < 3 + ulen + plen) return
          const user = buf.subarray(2, 2 + ulen).toString()
          const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString()
          buf = buf.subarray(3 + ulen + plen)
          if (user === PROXY_USER && pass === PROXY_PASS) {
            sock.write(Buffer.from([1, 0]))
            stage = 'request'
          } else {
            record({ kind: 'socks5-bad-auth', proxy: name })
            return sock.end(Buffer.from([1, 1]))
          }
        } else if (stage === 'request') {
          if (buf.length < 4) return
          const atyp = buf[3]
          let host: string
          let hdr: number
          if (atyp === 1) {
            if (buf.length < 10) return
            host = [...buf.subarray(4, 8)].join('.')
            hdr = 8
          } else if (atyp === 3) {
            const l = buf[4] as number
            if (buf.length < 5 + l + 2) return
            host = buf.subarray(5, 5 + l).toString()
            hdr = 5 + l
          } else return sock.destroy()
          const port = buf.readUInt16BE(hdr)
          const rest = buf.subarray(hdr + 2)
          if (buf[1] !== 1) return sock.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]))
          record({ kind: 'socks5-connect', proxy: name, target: `${host}:${port}` })
          stage = 'tunnel'
          const up = netConnect(port, host, () => {
            sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
            if (rest.length) up.write(rest)
            sock.pipe(up)
            up.pipe(sock)
          })
          up.on('error', () => sock.destroy())
          return
        } else return
      }
    })
  })
}

export async function startProxyServers(): Promise<ProxyServers> {
  const journal: ProxyEvent[] = []
  const record = (e: ProxyEvent) => journal.push(e)
  const ports = { httpOrigin: 0 }
  const tls = { key: tlsFixture('server.key'), cert: tlsFixture('server.pem') }
  const selfSigned = { key: tlsFixture('selfsigned.key'), cert: tlsFixture('selfsigned.pem') }
  const servers = {
    httpOrigin: createHttpServer(origin('http', () => ports)),
    httpsOrigin: createHttpsServer(
      tls,
      origin('https', () => ports)
    ),
    selfSignedOrigin: createHttpsServer(
      selfSigned,
      origin('selfsigned', () => ports)
    ),
    httpProxy: makeHttpProxy('http-proxy', false, record),
    httpProxyAuth: makeHttpProxy('http-proxy-auth', true, record),
    socks5: makeSocks5('socks5', false, record),
    socks5Auth: makeSocks5('socks5-auth', true, record),
  }
  const listen = (s: Server | NetServer) =>
    new Promise<number>((r) =>
      s.listen(0, '127.0.0.1', () => {
        const a = s.address()
        r(typeof a === 'object' && a ? a.port : 0)
      })
    )
  const p = Object.fromEntries(
    await Promise.all(Object.entries(servers).map(async ([k, s]) => [k, await listen(s)] as const))
  ) as Record<keyof typeof servers, number>
  ports.httpOrigin = p.httpOrigin
  // Bun has no `closeAllConnections`; track sockets ourselves so `close()` never waits on a
  // tunnel that the peer left open (the abort tests leave half-closed pipes behind).
  const sockets = new Set<Socket>()
  for (const s of Object.values(servers))
    s.on('connection', (sock: Socket) => {
      sockets.add(sock)
      sock.once('close', () => sockets.delete(sock))
    })
  const closeAll = () => {
    for (const sock of sockets) sock.destroy()
    return Promise.all(Object.values(servers).map((s) => new Promise<void>((r) => s.close(() => r())))).then(
      () => undefined
    )
  }
  return {
    httpOrigin: `http://127.0.0.1:${p.httpOrigin}`,
    httpsOrigin: `https://localhost:${p.httpsOrigin}`,
    selfSignedOrigin: `https://localhost:${p.selfSignedOrigin}`,
    httpProxy: `http://127.0.0.1:${p.httpProxy}`,
    httpProxyAuth: `http://127.0.0.1:${p.httpProxyAuth}`,
    socks5: `socks5://127.0.0.1:${p.socks5}`,
    socks5Auth: `socks5://127.0.0.1:${p.socks5Auth}`,
    events: () => [...journal],
    reset: () => {
      journal.length = 0
    },
    close: closeAll,
  }
}
