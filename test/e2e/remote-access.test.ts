/**
 * Stage 7d: the remote-access tunnel, through the compiled app-core binary.
 *
 * What is real: the binary, its control and public listeners, the child process it spawns (a launcher
 * named `cloudflared` that runs the fake), the probe — a TLS request through a stand-in for Cloudflare's
 * edge, pinned by address and reached by the tunnel's name, which forwards to the core's own public
 * server so the document that comes back is really this server's. What is not: Cloudflare.
 *
 * No imports from `src/`: a packaging change that breaks the route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createTlsServer } from 'node:https'
import type { Server } from 'node:https'
import { connect } from 'node:net'
import type { AddressInfo } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { APP_BIN } = core
const FAKE = fileURLToPath(new URL('../helpers/fake-cloudflared.mjs', import.meta.url))
const TLS_DIR = fileURLToPath(new URL('../fixtures/tls/', import.meta.url))
const TUNNEL_URL = 'https://calm-river-demo.trycloudflare.com'
const TUNNEL_HOST = 'calm-river-demo.trycloudflare.com'

let dataFolder: string
let argvFile: string
const daemons: ChildProcess[] = []
const edges: Server[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-tunnel-'))
  argvFile = join(dataFolder, 'fake-cloudflared.jsonl')
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  // The fake is in no backend journal; end whatever this test started.
  for (const { pid } of launched()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone, which is what most of these tests assert.
    }
  }
  await Promise.all(edges.splice(0).map((edge) => new Promise((resolve) => edge.close(resolve))))
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, init)

interface Launch {
  argv: string[]
  tunnelEnv: string[]
  pid: number
}

function launched(): Launch[] {
  try {
    return readFileSync(argvFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Launch)
  } catch {
    return []
  }
}

/** An executable named `cloudflared` that runs the fake. */
async function writeLauncher(mode: string): Promise<string> {
  const dir = join(dataFolder, 'app-bin')
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'cloudflared')
  await writeFile(
    path,
    `#!/bin/sh\nexport FAKE_CLOUDFLARED_MODE=${mode}\nexport FAKE_CLOUDFLARED_ARGV_FILE=${JSON.stringify(argvFile)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`
  )
  await chmod(path, 0o755)
  return path
}

/**
 * Cloudflare's edge, as far as the probe can tell: it presents a certificate for the tunnel's name
 * and hands the request to the origin the tunnel points at.
 */
async function startEdge(
  originPort: () => number
): Promise<{ address: string; hosts: Array<string | undefined> }> {
  const hosts: Array<string | undefined> = []
  const edge = createTlsServer(
    { key: readFileSync(join(TLS_DIR, 'tunnel.key')), cert: readFileSync(join(TLS_DIR, 'tunnel.pem')) },
    (req, res) => {
      hosts.push(req.headers.host)
      void fetch(`http://127.0.0.1:${originPort()}${req.url ?? '/'}`).then(
        async (origin) => {
          res.writeHead(origin.status, { 'content-type': origin.headers.get('content-type') ?? 'text/plain' })
          res.end(Buffer.from(await origin.arrayBuffer()))
        },
        () => res.writeHead(502).end('no origin')
      )
    }
  )
  await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve))
  edges.push(edge)
  return { address: `127.0.0.1:${(edge.address() as AddressInfo).port}`, hosts }
}

async function startDaemon(cloudflared: string | undefined, edgeAddress: string) {
  return core.startDaemon(
    dataFolder,
    daemons,
    cloudflared ? ['--cloudflared-bin', cloudflared] : [],
    {
      ATOMIC_REMOTE_ACCESS_EDGE: edgeAddress,
      ATOMIC_REMOTE_ACCESS_CA: join(TLS_DIR, 'tunnel.pem'),
      // A user who runs their own tunnels may have these exported; they must not steer ours.
      TUNNEL_TOKEN: 'someone-elses',
      TUNNEL_URL: 'http://elsewhere.invalid',
    },
    APP_BIN
  )
}

interface Status {
  state: string
  url: string | null
  error: string | null
  blockReason: string | null
  canStart: boolean
  canStop: boolean
  serverHasApiKey: boolean
}

const status = async (ready: ReadyLine) => (await (await control(ready, '/remote-access')).json()) as Status

async function until(ready: ReadyLine, state: string, timeoutMs = 15_000): Promise<Status> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const current = await status(ready)
    if (current.state === state) return current
    if (Date.now() > deadline) throw new Error(`the tunnel never became ${state}: ${JSON.stringify(current)}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function startPublic(ready: ReadyLine, body: Record<string, unknown> = {}): Promise<number> {
  const res = await control(ready, '/server/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ port: 0, ...body }),
  })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { port: number }).port
}

/** The status of one `GET /v1/models` sent to the public listener with exactly this `Host`. */
function hostRequest(port: number, host: string, dial = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, dial)
    let raw = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => (raw += chunk))
    socket.on('error', reject)
    socket.on('close', () => resolve(Number(raw.split(' ')[1])))
    socket.write(`GET /v1/models HTTP/1.1\r\nhost: ${host}\r\nconnection: close\r\n\r\n`)
  })
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe.skipIf(!existsSync(APP_BIN) || process.platform === 'win32')('the remote-access tunnel', () => {
  it('refuses without a public server, then goes online, trusts the tunnel name while it is up, and stops', async () => {
    let publicPort = 0
    const edge = await startEdge(() => publicPort)
    const { ready } = await startDaemon(await writeLauncher('url-then-registered'), edge.address)

    expect(await status(ready)).toMatchObject({
      state: 'off',
      blockReason: 'server_stopped',
      canStart: false,
    })
    const refused = await control(ready, '/remote-access/start', { method: 'POST' })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({
      error: { code: 'REMOTE_ACCESS_SERVER_STOPPED', details: 'server_stopped' },
    })

    publicPort = await startPublic(ready)
    expect(await hostRequest(publicPort, TUNNEL_HOST)).toBe(403)

    const started = await control(ready, '/remote-access/start', { method: 'POST' })
    expect(started.status, await started.clone().text()).toBe(200)
    // The URL is not shown before it is proven.
    expect(await started.json()).toMatchObject({ state: 'starting', url: null, canStop: true })

    const online = await until(ready, 'online')
    expect(online).toMatchObject({ url: TUNNEL_URL, error: null, canStart: false, canStop: true })
    // The probe went through the stand-in edge under the tunnel's name, and the answer was this server's.
    expect(edge.hosts).toContain(TUNNEL_HOST)
    expect(await hostRequest(publicPort, TUNNEL_HOST)).toBe(200)
    expect(await hostRequest(publicPort, 'other-name.trycloudflare.com')).toBe(403)

    const [launch] = launched()
    expect(launch?.argv).toEqual([
      'tunnel',
      '--config',
      '/dev/null',
      '--url',
      `http://127.0.0.1:${publicPort}`,
      '--no-autoupdate',
    ])
    expect(launch?.tunnelEnv).toEqual([])
    const journal = JSON.parse(
      readFileSync(join(dataFolder, 'atomic-core', 'remote-access-tunnel.json'), 'utf8')
    ) as { pid: number; instance_id: string }
    expect(journal).toMatchObject({ pid: launch?.pid, instance_id: ready.instance_id })

    const stopped = await control(ready, '/remote-access/stop', { method: 'POST' })
    expect(await stopped.json()).toMatchObject({ state: 'off', url: null, canStart: true })
    expect(alive(launch?.pid as number)).toBe(false)
    expect(await hostRequest(publicPort, TUNNEL_HOST)).toBe(403)
    expect(existsSync(join(dataFolder, 'atomic-core', 'remote-access-tunnel.json'))).toBe(false)
  })

  it('ends the tunnel before the public server it points at', async () => {
    let publicPort = 0
    const edge = await startEdge(() => publicPort)
    const { ready } = await startDaemon(await writeLauncher('url-then-registered'), edge.address)
    publicPort = await startPublic(ready)
    await control(ready, '/remote-access/start', { method: 'POST' })
    await until(ready, 'online')
    const pid = launched()[0]?.pid as number

    const snapshot = (await (await control(ready, '/snapshot')).json()) as { cursor: string }
    const stream = await control(ready, `/events?cursor=${encodeURIComponent(snapshot.cursor)}`)
    const reader = stream.body?.getReader() as ReadableStreamDefaultReader<Uint8Array>
    try {
      const stop = await control(ready, '/server/stop', { method: 'POST' })
      expect(stop.status).toBe(200)
      expect(alive(pid)).toBe(false)

      let seen = ''
      const deadline = Date.now() + 10_000
      while (!seen.includes('event: server:stopped') && Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        seen += new TextDecoder().decode(value)
      }
      const tunnelOff = seen.indexOf('"state":"off"')
      expect(tunnelOff).toBeGreaterThanOrEqual(0)
      expect(tunnelOff).toBeLessThan(seen.indexOf('event: server:stopped'))
    } finally {
      await reader.cancel()
    }
    expect(await status(ready)).toMatchObject({
      state: 'off',
      blockReason: 'server_stopped',
      canStart: false,
    })
  })

  it('retries over HTTP/2 when the default transport never registers', async () => {
    let publicPort = 0
    const edge = await startEdge(() => publicPort)
    const { ready } = await startDaemon(await writeLauncher('registers-only-on-http2'), edge.address)
    publicPort = await startPublic(ready)
    await control(ready, '/remote-access/start', { method: 'POST' })
    // The first attempt gets the full 15 s to register before the retry.
    const online = await until(ready, 'online', 40_000)
    expect(online.url).toBe(TUNNEL_URL)
    const attempts = launched()
    expect(attempts).toHaveLength(2)
    expect(attempts[0]?.argv).not.toContain('--protocol')
    expect(attempts[1]?.argv.slice(-2)).toEqual(['--protocol', 'http2'])
    expect(alive(attempts[0]?.pid as number)).toBe(false)
  }, 60_000)

  it('reports a missing binary instead of failing the request, and lets the user try again', async () => {
    const edge = await startEdge(() => 0)
    const { ready } = await startDaemon(join(dataFolder, 'no-such-cloudflared'), edge.address)
    await startPublic(ready)
    const started = await control(ready, '/remote-access/start', { method: 'POST' })
    expect(started.status).toBe(200)
    expect(await until(ready, 'error')).toMatchObject({ error: 'cloudflared_unavailable', canStart: true })
  })

  it('kills the tunnel when it is asked to shut down, and the next owner consumes a journal a crash left behind', async () => {
    let publicPort = 0
    const edge = await startEdge(() => publicPort)
    const launcher = await writeLauncher('url-then-registered')
    const first = await startDaemon(launcher, edge.address)
    publicPort = await startPublic(first.ready)
    await control(first.ready, '/remote-access/start', { method: 'POST' })
    await until(first.ready, 'online')
    const tunnelPid = launched()[0]?.pid as number

    // A crash runs none of the cleanup: the journal is what is left.
    first.child.kill('SIGKILL')
    await new Promise((resolve) => first.child.once('exit', resolve))
    const journalPath = join(dataFolder, 'atomic-core', 'remote-access-tunnel.json')
    expect(existsSync(journalPath)).toBe(true)

    const second = await startDaemon(launcher, edge.address)
    // Read once and never again, whatever it said. (The stand-in is a `node` process, not one named
    // `cloudflared`, so by design it is spared here; the kill itself is covered with a real child in
    // `src/remote-access/journal.test.ts`.)
    expect(existsSync(journalPath)).toBe(false)
    expect(alive(tunnelPid)).toBe(true)

    publicPort = await startPublic(second.ready)
    await control(second.ready, '/remote-access/start', { method: 'POST' })
    await until(second.ready, 'online')
    const secondPid = launched().at(-1)?.pid as number
    const shutdown = await control(second.ready, '/shutdown', {
      method: 'POST',
      body: JSON.stringify({ force: true }),
    })
    expect(shutdown.status).toBe(200)
    await new Promise((resolve) => second.child.once('exit', resolve))
    expect(alive(secondPid)).toBe(false)
  })

  it('reports a tunnel that exits after coming up, stops trusting its name, and lets the user start again', async () => {
    let publicPort = 0
    const edge = await startEdge(() => publicPort)
    const { ready } = await startDaemon(await writeLauncher('ready-then-exit'), edge.address)
    publicPort = await startPublic(ready)
    await control(ready, '/remote-access/start', { method: 'POST' })
    // The fake leaves on its own right after registering; `online` may be too brief to observe.
    const failed = await until(ready, 'error')
    expect(failed).toMatchObject({ error: 'exited', url: null, canStart: true, canStop: false })
    const pid = launched()[0]?.pid as number
    expect(alive(pid)).toBe(false)
    expect(await hostRequest(publicPort, TUNNEL_HOST)).toBe(403)
    expect(existsSync(join(dataFolder, 'atomic-core', 'remote-access-tunnel.json'))).toBe(false)
    // The public server it pointed at is untouched.
    expect(await hostRequest(publicPort, `127.0.0.1:${publicPort}`)).toBe(200)
  })

  it('kills a tunnel that ignores SIGTERM before stop answers off', async () => {
    let publicPort = 0
    const edge = await startEdge(() => publicPort)
    const { ready } = await startDaemon(await writeLauncher('ignore-sigterm'), edge.address)
    publicPort = await startPublic(ready)
    await control(ready, '/remote-access/start', { method: 'POST' })
    await until(ready, 'online')
    const pid = launched()[0]?.pid as number
    const before = Date.now()
    const stopped = await control(ready, '/remote-access/stop', { method: 'POST' })
    expect(await stopped.json()).toMatchObject({ state: 'off', url: null, error: null, canStart: true })
    // SIGTERM was given its 5 s grace before the kill; the answer waited for the process to be gone.
    expect(Date.now() - before).toBeGreaterThanOrEqual(4_500)
    expect(alive(pid)).toBe(false)
    expect(existsSync(join(dataFolder, 'atomic-core', 'remote-access-tunnel.json'))).toBe(false)
  }, 30_000)

  it('consumes the journal Atomic Chat 2.0.40 left at the data root', async () => {
    // A pid that is certainly not a running tunnel: our own, which is not named `cloudflared`.
    const legacy = join(dataFolder, 'remote-access-tunnel.json')
    await mkdir(dataFolder, { recursive: true })
    await writeFile(
      legacy,
      JSON.stringify({ pid: process.pid, started_at_secs: Math.floor(Date.now() / 1000) })
    )
    const edge = await startEdge(() => 0)
    const { ready } = await startDaemon(await writeLauncher('url-then-registered'), edge.address)
    // Read once and never again; the process it named was spared, being no tunnel.
    expect(existsSync(legacy)).toBe(false)
    expect(alive(process.pid)).toBe(true)
    expect(await status(ready)).toMatchObject({ state: 'off' })
  })

  it('lists dialable LAN addresses, and a listener on 0.0.0.0 trusts the address a socket arrived on', async () => {
    const edge = await startEdge(() => 0)
    const { ready } = await startDaemon(await writeLauncher('url-then-registered'), edge.address)
    const { addresses } = (await (await control(ready, '/lan-addresses')).json()) as { addresses: string[] }
    const mine = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === 'IPv4')
      .map((entry) => (entry as { address: string }).address)
    for (const address of addresses) {
      expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/)
      expect(address.startsWith('127.')).toBe(false)
      expect(mine).toContain(address)
    }
    const port = await startPublic(ready, { host: '0.0.0.0' })
    // The listing is what to show the user; a VPN's shared-space address (kept on purpose, it may be
    // Tailscale) can belong to a proxy that never reaches this listener. Prove it on one that does.
    let lan: string | undefined
    for (const candidate of addresses)
      if ((await hostRequest(port, `127.0.0.1:${port}`, candidate).catch(() => Number.NaN)) === 200) {
        lan = candidate
        break
      }
    if (lan === undefined) return // A machine with no network: nothing more to prove here.
    // Dialled on the LAN address, a request naming that address is trusted without configuration.
    expect(await hostRequest(port, `${lan}:${port}`, lan)).toBe(200)
    // A rebinding name arriving on the same socket is not.
    expect(await hostRequest(port, 'attacker.example', lan)).toBe(403)
    // The LAN literal presented over loopback is a stranger there.
    expect(await hostRequest(port, `${lan}:${port}`)).toBe(403)
  })
})
