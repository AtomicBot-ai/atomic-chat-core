import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FAKE_TUNNEL_URL,
  fakeCloudflaredCommand,
  spawnFakeCloudflared,
} from '../../test/helpers/fake-cloudflared.js'
import { cloudflaredArgs, scrubTunnelEnv } from './cloudflared-args.js'
import { spawnTunnel } from './process.js'
import type { TunnelProcess } from './process.js'

const FAST = { termGraceMs: 300, killGraceMs: 5000 }
const started: TunnelProcess[] = []
const track = (tunnel: TunnelProcess) => {
  started.push(tunnel)
  return tunnel
}
afterEach(() => {
  for (const tunnel of started.splice(0)) tunnel.killNow()
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// The process tests of the app's `remote_access/process.rs`, against a real child.
describe('spawnTunnel', () => {
  it('reports the URL of a registered tunnel, and stops it', async () => {
    const tunnel = track(spawnFakeCloudflared({ mode: 'url-then-registered' }))
    expect(tunnel.pid).toBeGreaterThan(0)
    expect(await tunnel.waitReady(10_000)).toEqual({ kind: 'url', url: FAKE_TUNNEL_URL })
    expect(await tunnel.terminate(FAST)).toBe(true)
    expect(alive(tunnel.pid as number)).toBe(false)
  })

  it('times out with the URL seen for a tunnel that was minted but never registered', async () => {
    const tunnel = track(spawnFakeCloudflared({ mode: 'url-only' }))
    expect(await tunnel.waitReady(1500)).toEqual({ kind: 'timed-out', sawUrl: true })
    expect(await tunnel.terminate(FAST)).toBe(true)
  })

  it('times out without a URL for a silent process', async () => {
    const tunnel = track(spawnFakeCloudflared({ mode: 'silent' }))
    expect(await tunnel.waitReady(700)).toEqual({ kind: 'timed-out', sawUrl: false })
    expect(await tunnel.terminate(FAST)).toBe(true)
  })

  it('reports an early exit as an exit, not a timeout', async () => {
    const tunnel = track(spawnFakeCloudflared({ mode: 'exit-immediately' }))
    expect(await tunnel.waitReady(10_000)).toEqual({ kind: 'exited', sawUrl: false })
    // Already gone: terminating is a confirmed no-op.
    expect(await tunnel.terminate(FAST)).toBe(true)
  })

  it('sees an exit after the tunnel was ready', async () => {
    const tunnel = track(spawnFakeCloudflared({ mode: 'ready-then-exit' }))
    expect(await tunnel.waitReady(10_000)).toEqual({ kind: 'url', url: FAKE_TUNNEL_URL })
    await tunnel.waitExit()
    expect(alive(tunnel.pid as number)).toBe(false)
    // Asking again after the fact still answers with what was established.
    expect(await tunnel.waitReady(10)).toEqual({ kind: 'url', url: FAKE_TUNNEL_URL })
  })

  it.skipIf(process.platform === 'win32')(
    'kills a process that ignores SIGTERM, after its grace period',
    async () => {
      const tunnel = track(spawnFakeCloudflared({ mode: 'ignore-sigterm' }))
      expect(await tunnel.waitReady(10_000)).toEqual({ kind: 'url', url: FAKE_TUNNEL_URL })
      const startedAt = Date.now()
      expect(await tunnel.terminate(FAST)).toBe(true)
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(300)
      expect(alive(tunnel.pid as number)).toBe(false)
    }
  )

  it('says so when the exit cannot be confirmed, instead of pretending it stopped', async () => {
    const tunnel = track(spawnFakeCloudflared({ mode: 'url-then-registered' }))
    await tunnel.waitReady(10_000)
    // A process no signal reaches (a zombie parent, a debugger, a kernel that is slow to reap): the
    // signals are swallowed here, so the outcome does not depend on how fast this machine is.
    const internals = tunnel as unknown as { child: { kill: (signal?: NodeJS.Signals) => boolean } }
    const realKill = internals.child.kill.bind(internals.child)
    internals.child.kill = () => true
    try {
      expect(await tunnel.terminate({ termGraceMs: 40, killGraceMs: 40 })).toBe(false)
      expect(alive(tunnel.pid as number)).toBe(true)
    } finally {
      internals.child.kill = realKill
    }
    // The handle is kept for exactly this: a later attempt can still end it.
    expect(await tunnel.terminate(FAST)).toBe(true)
  })

  it('goes straight to the kill on Windows, where a console-less child has no graceful signal', async () => {
    const tunnel = track(spawnTunnel(fakeCloudflaredCommand([], { mode: 'ignore-sigterm' }), 'win32'))
    await tunnel.waitReady(10_000)
    const startedAt = Date.now()
    expect(await tunnel.terminate({ termGraceMs: 5000, killGraceMs: 5000 })).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(3000)
  })

  it('reports a program that cannot be started, without throwing', async () => {
    const tunnel = spawnTunnel({ program: '/nonexistent/atomic-chat/cloudflared', args: [], env: {} })
    expect(await tunnel.waitReady(5000)).toEqual({ kind: 'spawn-failed' })
    await tunnel.waitExit()
    expect(await tunnel.terminate(FAST)).toBe(true)
    tunnel.killNow()
  })

  it("passes the real command line through, and none of the user's TUNNEL_* variables", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-fake-cloudflared-'))
    const argvFile = join(dir, 'argv.jsonl')
    try {
      const command = fakeCloudflaredCommand(cloudflaredArgs('http://127.0.0.1:1337', 'http2', '/dev/null'), {
        mode: 'registers-only-on-http2',
        argvFile,
      })
      // What the production spawner does to its environment.
      command.env = scrubTunnelEnv({ ...command.env, TUNNEL_TOKEN: 'someone-elses', TUNNEL_URL: 'http://x' })
      const tunnel = track(spawnTunnel(command))
      expect(await tunnel.waitReady(10_000)).toEqual({ kind: 'url', url: FAKE_TUNNEL_URL })
      const seen = JSON.parse((await readFile(argvFile, 'utf8')).trim()) as {
        argv: string[]
        tunnelEnv: string[]
      }
      expect(seen.argv).toEqual([
        'tunnel',
        '--config',
        '/dev/null',
        '--url',
        'http://127.0.0.1:1337',
        '--no-autoupdate',
        '--protocol',
        'http2',
      ])
      expect(seen.tunnelEnv).toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not register over the default transport when only HTTP/2 gets through', async () => {
    const tunnel = track(
      spawnTunnel(
        fakeCloudflaredCommand(cloudflaredArgs('http://127.0.0.1:1337'), { mode: 'registers-only-on-http2' })
      )
    )
    expect(await tunnel.waitReady(800)).toEqual({ kind: 'timed-out', sawUrl: true })
  })
})
