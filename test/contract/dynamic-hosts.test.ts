/**
 * The trusted-hosts group that is only known per request, against a real listener (stage 7c).
 *
 * Port of the app's `the_tunnel_name_is_trusted_only_while_the_tunnel_is_up`
 * (`src-tauri/src/core/server/integration_tests.rs`, image-generation line `767ff6350`), plus the LAN
 * half of `dynamic_hosts.rs`: the address of the accepted socket. Raw HTTP/1.1 over a socket, so each
 * request carries exactly the `Host` it names. Runs under Node and under Bun: `req.socket.localAddress`
 * is what the whole LAN half rests on, and both runtimes have to report it the same way.
 */

import { connect } from 'node:net'
import { networkInterfaces } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { DynamicTrustedHosts, PublicServer } from '../../src/server/public/index.js'
import type { PublicServerDeps } from '../../src/server/public/index.js'

const servers: PublicServer[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function start(hosts: DynamicTrustedHosts, host = '127.0.0.1'): Promise<PublicServer> {
  const deps: PublicServerDeps = {
    findLocal: () => undefined,
    listLocal: () => [],
    providers: () => new Map(),
    increaseCtx: async () => ({ ok: false }),
    dynamicTrustedHosts: (localAddress) => hosts.groupFor(localAddress),
  }
  const server = await PublicServer.start(deps, { host, port: 0 })
  servers.push(server)
  return server
}

interface RawResponse {
  status: number
  headers: Record<string, string>
}

/** One request on its own connection, with exactly these headers. */
function request(
  port: number,
  headers: Record<string, string>,
  options: { method?: string; path?: string; connectTo?: string } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, options.connectTo ?? '127.0.0.1')
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (raw += chunk))
    socket.on('error', reject)
    socket.on('close', () => {
      const [head = ''] = raw.split('\r\n\r\n')
      const [statusLine = '', ...lines] = head.split('\r\n')
      const parsed: Record<string, string> = {}
      for (const line of lines) {
        const colon = line.indexOf(':')
        if (colon > 0) parsed[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim()
      }
      resolve({ status: Number(statusLine.split(' ')[1]), headers: parsed })
    })
    const lines = Object.entries({ ...headers, connection: 'close' }).map(([k, v]) => `${k}: ${v}`)
    socket.write(
      `${options.method ?? 'GET'} ${options.path ?? '/v1/models'} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`
    )
  })
}

const TUNNEL = 'calm-river-demo.trycloudflare.com'

describe('the tunnel name', () => {
  it('is trusted only while the tunnel is up', async () => {
    const hosts = new DynamicTrustedHosts()
    const server = await start(hosts)

    expect((await request(server.port, { host: TUNNEL })).status).toBe(403)

    hosts.setTunnelHost(TUNNEL)
    const up = await request(server.port, { host: TUNNEL, origin: `https://${TUNNEL}` })
    expect(up.status).toBe(200)
    // The origin is reflected only because its host is trusted now.
    expect(up.headers['access-control-allow-origin']).toBe(`https://${TUNNEL}`)
    expect(up.headers['access-control-allow-credentials']).toBe('true')
    // Another quick-tunnel name is still a stranger, and so is its origin.
    expect((await request(server.port, { host: 'other-name.trycloudflare.com' })).status).toBe(403)
    const foreignOrigin = await request(server.port, {
      host: TUNNEL,
      origin: 'https://other-name.trycloudflare.com',
    })
    expect(foreignOrigin.status).toBe(200)
    expect(foreignOrigin.headers['access-control-allow-origin']).toBeUndefined()

    hosts.clearTunnelHost()
    expect((await request(server.port, { host: TUNNEL })).status).toBe(403)
  })

  it('takes effect on a connection that was opened before the tunnel came up', async () => {
    const hosts = new DynamicTrustedHosts()
    const server = await start(hosts)
    const statuses = await new Promise<number[]>((resolve, reject) => {
      const socket = connect(server.port, '127.0.0.1')
      const seen: number[] = []
      let raw = ''
      const send = () => socket.write(`GET /v1/models HTTP/1.1\r\nhost: ${TUNNEL}\r\n\r\n`)
      socket.setEncoding('utf8')
      socket.on('error', reject)
      socket.on('data', (chunk: string) => {
        raw += chunk
        const match = /^HTTP\/1\.1 (\d{3})/m.exec(raw)
        if (!match) return
        // Wait for the whole response before reusing the connection.
        const [head = '', body = ''] = raw.split('\r\n\r\n')
        const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? '0')
        if (Buffer.byteLength(body) < length) return
        seen.push(Number(match[1]))
        raw = ''
        if (seen.length === 1) {
          hosts.setTunnelHost(TUNNEL)
          send()
        } else {
          socket.end()
          resolve(seen)
        }
      })
      socket.on('connect', send)
    })
    // Same keep-alive connection: refused before, accepted after. The group is asked per request.
    expect(statuses).toEqual([403, 200])
  })

  it('answers a preflight for the tunnel origin only while the tunnel is up', async () => {
    const hosts = new DynamicTrustedHosts()
    const server = await start(hosts)
    const preflight = () =>
      request(
        server.port,
        {
          'host': TUNNEL,
          'origin': `https://${TUNNEL}`,
          'access-control-request-method': 'POST',
        },
        { method: 'OPTIONS', path: '/v1/chat/completions' }
      )
    expect((await preflight()).status).toBe(403)
    hosts.setTunnelHost(TUNNEL)
    const allowed = await preflight()
    expect(allowed.status).toBe(200)
    expect(allowed.headers['access-control-allow-origin']).toBe(`https://${TUNNEL}`)
  })
})

/** A non-internal IPv4 address of this machine, which is what a LAN client would dial. */
function lanAddress(): string | undefined {
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? [])
      if (address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.'))
        return address.address
  return undefined
}

const lan = lanAddress()

describe('the accepted socket', () => {
  it.skipIf(lan === undefined)(
    'is trusted for the address the client actually reached, on a listener bound to every interface',
    async () => {
      const address = lan as string
      const server = await start(new DynamicTrustedHosts(), '0.0.0.0')

      const reached = await request(
        server.port,
        { host: `${address}:${server.port}` },
        { connectTo: address }
      )
      expect(reached.status).toBe(200)
      // The rebinding shape: an attacker's name resolving to the LAN address still names the attacker.
      const rebound = await request(
        server.port,
        { host: `evil.example:${server.port}` },
        { connectTo: address }
      )
      expect(rebound.status).toBe(403)
      // The LAN literal over a loopback socket is not the address that socket arrived on.
      const viaLoopback = await request(server.port, { host: `${address}:${server.port}` })
      expect(viaLoopback.status).toBe(403)
    }
  )

  it('gains nothing on a loopback bind', async () => {
    const server = await start(new DynamicTrustedHosts())
    expect((await request(server.port, { host: '192.168.1.5:1337' })).status).toBe(403)
    expect((await request(server.port, { host: `127.0.0.1:${server.port}` })).status).toBe(200)
  })
})
