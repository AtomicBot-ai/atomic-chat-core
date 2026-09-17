/**
 * The tunnel as a real core runs it: a real public listener, a real child process (the fake
 * cloudflared), the ordering between the two, and the Host gate that follows the tunnel. Only the
 * probe is scripted — what it would have to reach is Cloudflare.
 */
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { describe, expect, it } from 'vitest'
import { cores, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { FAKE_TUNNEL_URL, fakeCloudflaredCommand } from '../../test/helpers/fake-cloudflared.js'
import type { FakeCloudflaredMode } from '../../test/helpers/fake-cloudflared.js'
import { CoreClient } from '../client/index.js'
import type { RemoteAccessStatus } from '../contracts/index.js'
import { spawnTunnel } from '../remote-access/index.js'
import type { TunnelProcess } from '../remote-access/index.js'
import { AtomicCore } from './index.js'

useCoreHarness()

const TUNNEL_HOST = new URL(FAKE_TUNNEL_URL).hostname

async function coreWithTunnel(mode: FakeCloudflaredMode = 'url-then-registered', reachable = true) {
  const spawned: TunnelProcess[] = []
  const origins: string[] = []
  const core = await AtomicCore.create({
    dataFolder: data.root,
    controlPort: 0,
    remoteAccess: {
      spawner: (origin, protocol) => {
        origins.push(origin)
        const tunnel = spawnTunnel(fakeCloudflaredCommand(protocol ? ['--protocol', protocol] : [], { mode }))
        spawned.push(tunnel)
        return tunnel
      },
      prober: { verify: async () => reachable },
      timings: { readyMs: 5000, probeTotalMs: 1000, termGraceMs: 2000, killGraceMs: 2000 },
    },
  })
  cores.push(core)
  const events: RemoteAccessStatus[] = []
  core.events.on('remote-access:status', (status) => events.push(status))
  const until = async (state: RemoteAccessStatus['state']) => {
    for (let i = 0; i < 500; i++) {
      const found = events.find((status) => status.state === state)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`no ${state} event: ${events.map((e) => e.state).join(', ')}`)
  }
  return { core, spawned, origins, events, until }
}

/** The status of one `GET /v1/models` sent to the public listener with exactly this `Host`. */
function hostRequest(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (raw += chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(Number(raw.split(' ')[1])))
    socket.write(`GET /v1/models HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`)
  })
}

const alive = (pid: number | undefined): boolean => {
  try {
    process.kill(pid as number, 0)
    return true
  } catch {
    return false
  }
}

describe('remote access through a real core', () => {
  it('refuses a tunnel with nothing to point at, over the control API too', async () => {
    const { core } = await coreWithTunnel()
    expect(core.remoteAccessStatus()).toMatchObject({
      state: 'off',
      blockReason: 'server_stopped',
      canStart: false,
    })
    expect(() => core.startRemoteAccess()).toThrowError(
      expect.objectContaining({ details: 'server_stopped' })
    )
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    await expect(client.startRemoteAccess()).rejects.toMatchObject({
      code: 'REMOTE_ACCESS_SERVER_STOPPED',
      details: 'server_stopped',
    })
  })

  it('reports an installation that carries no tunnel binary, start to stop over the control API', async () => {
    const warnings: string[] = []
    // An explicit, empty environment: a developer's own ATOMIC_CLOUDFLARED_BIN must not reach this.
    const core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      env: {},
      logger: (level, message) => void (level === 'warn' && warnings.push(message)),
    })
    cores.push(core)
    const client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    await core.startPublicServer({ port: 0 })

    expect(await client.startRemoteAccess()).toMatchObject({ state: 'starting', canStop: true })
    let status = await client.remoteAccessStatus()
    for (let i = 0; i < 200 && status.state !== 'error'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
      status = await client.remoteAccessStatus()
    }
    // The user may try again; nothing is left running.
    expect(status).toMatchObject({ state: 'error', error: 'cloudflared_unavailable', canStart: true })
    expect(warnings).toContain('remote access: no cloudflared binary was found for this installation')
    expect(await client.stopRemoteAccess()).toMatchObject({ state: 'off', error: null })
  })

  it('points the tunnel at the bound port, trusts its name only while it is up, and journals it', async () => {
    const { core, spawned, origins, until } = await coreWithTunnel()
    const { port } = await core.startPublicServer({ port: 0, apiKey: 'sk-local' })
    expect(await hostRequest(port, TUNNEL_HOST)).toBe(403)

    expect(core.startRemoteAccess()).toMatchObject({ state: 'starting', url: null, serverHasApiKey: true })
    const online = await until('online')
    expect(online.url).toBe(FAKE_TUNNEL_URL)
    expect(origins).toEqual([`http://127.0.0.1:${port}`])
    // The key still guards the API; the Host gate now lets the tunnel's name through to it.
    expect(await hostRequest(port, TUNNEL_HOST)).toBe(401)
    expect(await hostRequest(port, 'other-name.trycloudflare.com')).toBe(403)
    const journal = JSON.parse(await readFile(data.layout.core.remoteAccessTunnel, 'utf8')) as { pid: number }
    expect(journal.pid).toBe(spawned[0]?.pid)

    expect(await core.stopRemoteAccess()).toMatchObject({ state: 'off', url: null, canStart: true })
    expect(alive(spawned[0]?.pid)).toBe(false)
    expect(await hostRequest(port, TUNNEL_HOST)).toBe(403)
    await expect(readFile(data.layout.core.remoteAccessTunnel, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('ends the tunnel before the listener it points at, and says so in that order', async () => {
    const { core, spawned, until } = await coreWithTunnel()
    await core.startPublicServer({ port: 0 })
    core.startRemoteAccess()
    await until('online')

    const order: string[] = []
    core.events.on('remote-access:status', (status) => order.push(`tunnel:${status.state}`))
    core.events.on('server:stopped', () => order.push('server:stopped'))
    await core.stopPublicServer()

    expect(alive(spawned[0]?.pid)).toBe(false)
    expect(order.indexOf('tunnel:off')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('tunnel:off')).toBeLessThan(order.indexOf('server:stopped'))
    // The last word follows the server: nothing to point at any more.
    expect(core.remoteAccessStatus()).toMatchObject({
      state: 'off',
      blockReason: 'server_stopped',
      canStart: false,
    })
    expect(order.at(-1)).toBe('tunnel:off')
  })

  it('leaves the tunnel alone when a start changes nothing, and announces when the server comes up', async () => {
    const { core, spawned, events, until } = await coreWithTunnel()
    const { port } = await core.startPublicServer({ port: 0 })
    // The server coming up is announced: `canStart` follows it.
    expect(events.at(-1)).toMatchObject({ state: 'off', blockReason: null, canStart: true })
    core.startRemoteAccess()
    await until('online')

    await core.startPublicServer({ port })
    expect(alive(spawned[0]?.pid)).toBe(true)
    expect(core.remoteAccessStatus().state).toBe('online')
  })

  it('never shows a URL that does not reach this server, and takes the useless tunnel down', async () => {
    const { core, spawned, until, events } = await coreWithTunnel('url-then-registered', false)
    const { port } = await core.startPublicServer({ port: 0 })
    core.startRemoteAccess()
    const failed = await until('error')
    expect(failed).toMatchObject({ error: 'not_reachable', url: null, canStart: true })
    expect(events.map((event) => event.state)).not.toContain('online')
    expect(alive(spawned[0]?.pid)).toBe(false)
    expect(await hostRequest(port, TUNNEL_HOST)).toBe(403)
  })

  it('retries over HTTP/2 on a network that drops the default transport', async () => {
    const { core, spawned, until } = await coreWithTunnel('registers-only-on-http2')
    await core.startPublicServer({ port: 0 })
    const fast = core as unknown as { remoteAccess: { timings: { readyMs: number } } }
    fast.remoteAccess.timings.readyMs = 600
    core.startRemoteAccess()
    expect((await until('online')).url).toBe(FAKE_TUNNEL_URL)
    expect(spawned).toHaveLength(2)
    expect(alive(spawned[0]?.pid)).toBe(false)
    expect(alive(spawned[1]?.pid)).toBe(true)
  })

  it('kills the tunnel when the core shuts down, before anything that can wait', async () => {
    const { core, spawned, until } = await coreWithTunnel()
    await core.startPublicServer({ port: 0 })
    core.startRemoteAccess()
    await until('online')
    await core.shutdown()
    cores.splice(cores.indexOf(core), 1)
    await spawned[0]?.waitExit()
    expect(alive(spawned[0]?.pid)).toBe(false)
  })
})
