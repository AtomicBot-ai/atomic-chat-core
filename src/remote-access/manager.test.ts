/**
 * State-machine tests for `RemoteAccessManager`, driven by scripted tunnel processes and a scripted
 * prober: no cloudflared, no network, no sleeps beyond a few milliseconds. The real process handling
 * has its own tests in `process.test.ts`, the real probe in `probe.test.ts`.
 *
 * Port of src-tauri/src/core/server/remote_access/tests.rs (image-generation line, `767ff6350`).
 */
import { describe, expect, it } from 'vitest'
import type { RemoteAccessState, RemoteAccessStatus } from '../contracts/index.js'
import { DynamicTrustedHosts } from '../server/index.js'
import { RemoteAccessManager, remoteAccessRefusal } from './manager.js'
import type { Prober } from './probe.js'
import type { Ready, TunnelProcess } from './process.js'
import { failed } from './status.js'
import type { Phase, ServerEndpoint } from './status.js'

const URL_ = 'https://calm-river-demo.trycloudflare.com'
const HOST = 'calm-river-demo.trycloudflare.com'
const GHOST_PID = 2 ** 31 - 11

/** What one spawned process will do. */
interface Script {
  pid?: number
  /** `undefined` never becomes ready: it hangs until the supervisor is stopped. */
  ready?: Ready
  /** Exits by itself this long after somebody starts waiting for its exit. */
  exitsAfterMs?: number
  /** One answer per `terminate` call; the last one repeats. */
  terminateConfirms?: boolean[]
}

const readyWithUrl = (over: Script = {}): Script => ({ ready: { kind: 'url', url: URL_ }, ...over })
const endingIn = (ready: Ready): Script => ({ ready })
const hanging = (): Script => ({})

function rig(
  scripts: Array<Script | undefined>,
  prober: { reachable: boolean; delayMs?: number } = { reachable: true }
) {
  const log = { spawns: [] as Array<[string, string | undefined]>, terminations: 0, kills: 0 }
  const events: RemoteAccessStatus[] = []
  const hosts = new DynamicTrustedHosts()
  const journal = { recorded: [] as Array<[number, string]>, cleared: 0 }
  const exitHooks = new Set<() => void>()
  let server: ServerEndpoint | undefined = { origin: 'http://127.0.0.1:1337', hasApiKey: false }
  let probes = 0
  const queue = [...scripts]

  const fakeProcess = (script: Script): TunnelProcess => {
    const confirms = [...(script.terminateConfirms ?? [true])]
    return {
      pid: script.pid,
      exe: '/app/cloudflared',
      waitReady: () => (script.ready ? Promise.resolve(script.ready) : new Promise<Ready>(() => {})),
      waitExit: () =>
        script.exitsAfterMs === undefined
          ? new Promise<void>(() => {})
          : new Promise<void>((resolve) => setTimeout(resolve, script.exitsAfterMs)),
      terminate: async () => {
        log.terminations++
        return confirms.length > 1 ? (confirms.shift() as boolean) : (confirms[0] as boolean)
      },
      killNow: () => {
        log.kills++
      },
    }
  }
  const fakeProber: Prober = {
    verify: async (_url, _budget, signal) => {
      probes++
      if (prober.delayMs)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, prober.delayMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            resolve()
          })
        })
      return prober.reachable
    },
  }
  const manager = new RemoteAccessManager({
    spawner: (origin, protocol) => {
      log.spawns.push([origin, protocol])
      const script = queue.shift()
      return script ? fakeProcess(script) : undefined
    },
    prober: fakeProber,
    timings: { readyMs: 200, probeTotalMs: 200, termGraceMs: 50, killGraceMs: 50 },
    server: () => server,
    hosts,
    emit: (status) => events.push(status),
    journal: {
      record: async (pid, exe) => void journal.recorded.push([pid, exe]),
      clear: async () => void journal.cleared++,
    },
    onProcessExit: (hook) => {
      exitHooks.add(hook)
      return () => exitHooks.delete(hook)
    },
  })

  /** The first event in `state`, waiting for it if needed. */
  const eventIn = async (state: RemoteAccessState): Promise<RemoteAccessStatus> => {
    for (let i = 0; i < 500; i++) {
      const found = events.find((status) => status.state === state)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    throw new Error(`no ${state} event within 5s: ${events.map((e) => e.state).join(', ')}`)
  }
  return {
    manager,
    hosts,
    events,
    log,
    journal,
    exitHooks,
    eventIn,
    probes: () => probes,
    states: () => events.map((status) => status.state),
    setServer: (next: ServerEndpoint | undefined) => (server = next),
  }
}

describe('RemoteAccessManager', () => {
  it('goes from starting to online, and the tunnel name is trusted by the listener', async () => {
    const r = rig([readyWithUrl()])

    const immediate = r.manager.start()
    expect(immediate.state).toBe('starting')
    // The URL is not shown before it is proven.
    expect(immediate.url).toBeNull()
    expect([immediate.canStop, immediate.canStart]).toEqual([true, false])

    const online = await r.eventIn('online')
    expect(online.url).toBe(URL_)
    expect(online.error).toBeNull()
    expect([online.canStop, online.canStart]).toEqual([true, false])
    expect(r.hosts.tunnelHost()).toBe(HOST)
    // cloudflared chooses its own transport on the first attempt, and points at the address the
    // server is actually reachable on.
    expect(r.log.spawns).toEqual([['http://127.0.0.1:1337', undefined]])
    expect(r.probes()).toBe(1)
  })

  it('follows a server bound to one specific address, and reports its key', async () => {
    const r = rig([readyWithUrl()])
    // Such a server does not listen on loopback at all.
    r.setServer({ origin: 'http://192.168.1.5:8080', hasApiKey: true })
    r.manager.start()
    const online = await r.eventIn('online')
    expect(r.log.spawns[0]?.[0]).toBe('http://192.168.1.5:8080')
    expect(online.serverHasApiKey).toBe(true)
  })

  it('refuses to start without a server', () => {
    const r = rig([])
    r.setServer(undefined)
    expect(() => r.manager.start()).toThrowError(
      expect.objectContaining({ code: 'REMOTE_ACCESS_SERVER_STOPPED', details: 'server_stopped' })
    )
    expect(r.manager.status()).toMatchObject({ state: 'off', blockReason: 'server_stopped', canStart: false })
    expect(r.log.spawns).toEqual([])
  })

  it('reports a missing binary as such', async () => {
    const r = rig([undefined])
    r.manager.start()
    const failed = await r.eventIn('error')
    expect(failed.error).toBe('cloudflared_unavailable')
    // The user may try again.
    expect(failed.canStart).toBe(true)
    expect(r.hosts.tunnelHost()).toBeUndefined()
  })

  it('reports a binary that would not start the same way', async () => {
    const r = rig([endingIn({ kind: 'spawn-failed' })])
    r.manager.start()
    expect((await r.eventIn('error')).error).toBe('cloudflared_unavailable')
    expect(r.log.spawns).toHaveLength(1)
  })

  it('does not retry when no URL was minted: Cloudflare was not reached, and another transport cannot fix that', async () => {
    const r = rig([endingIn({ kind: 'exited', sawUrl: false }), readyWithUrl()])
    r.manager.start()
    expect((await r.eventIn('error')).error).toBe('no_url')
    expect(r.log.spawns).toHaveLength(1)
  })

  it('retries over HTTP/2 when a URL never registers', async () => {
    const r = rig([endingIn({ kind: 'timed-out', sawUrl: true }), readyWithUrl()])
    r.manager.start()
    expect((await r.eventIn('online')).url).toBe(URL_)
    expect(r.log.spawns.map(([, protocol]) => protocol)).toEqual([undefined, 'http2'])
    // The first attempt is ended before the second starts.
    expect(r.log.terminations).toBe(1)
  })

  it('gives up when registration fails on both transports', async () => {
    const r = rig([
      endingIn({ kind: 'timed-out', sawUrl: true }),
      endingIn({ kind: 'timed-out', sawUrl: true }),
    ])
    r.manager.start()
    expect((await r.eventIn('error')).error).toBe('not_registered')
    expect(r.log.spawns).toHaveLength(2)
    expect(r.probes()).toBe(0)
  })

  it('never shows a URL that does not reach this server', async () => {
    const r = rig([readyWithUrl()], { reachable: false })
    r.manager.start()
    const failed = await r.eventIn('error')
    expect(failed.error).toBe('not_reachable')
    expect(failed.url).toBeNull()
    // The useless tunnel is taken down.
    expect(r.log.terminations).toBe(1)
    expect(r.hosts.tunnelHost()).toBeUndefined()
    expect(r.states()).not.toContain('online')
  })

  it('turns into an error when the tunnel dies while online', async () => {
    const r = rig([readyWithUrl({ exitsAfterMs: 30 })])
    r.manager.start()
    await r.eventIn('online')
    const failed = await r.eventIn('error')
    expect(failed.error).toBe('exited')
    // A dead tunnel's URL must not linger.
    expect(failed.url).toBeNull()
    expect(failed.canStart).toBe(true)
    expect(r.hosts.tunnelHost()).toBeUndefined()
  })

  it('reports stopping, then off, when an online tunnel is stopped', async () => {
    const r = rig([readyWithUrl()])
    r.manager.start()
    await r.eventIn('online')

    const stopped = await r.manager.stop()
    expect(stopped).toMatchObject({ state: 'off', url: null, canStart: true, canStop: false })
    expect(r.log.terminations).toBe(1)
    expect(r.hosts.tunnelHost()).toBeUndefined()
    const states = r.states()
    const stopping = states.indexOf('stopping')
    expect(stopping).toBeGreaterThanOrEqual(0)
    expect(states.slice(stopping)).toContain('off')
  })

  it('still ends in off when a stop races with a failure', async () => {
    // Stop and a failure can land in the same instant (the process dies just as the button is
    // pressed). Whichever the supervisor notices first, the user asked for nothing to be running
    // and nothing is: that is `off`, not an error. Set up by hand, as the app's test does: the race
    // itself cannot be produced on demand.
    const r = rig([])
    const internals = r.manager as unknown as {
      run: number
      phase: Phase
      endRun(run: number, tunnel: TunnelProcess | undefined, outcome: Phase): Promise<void>
    }
    internals.run += 1
    internals.phase = { kind: 'stopping' }
    r.hosts.setTunnelHost(HOST)

    await internals.endRun(internals.run, undefined, failed('exited'))

    expect(r.manager.status()).toMatchObject({ state: 'off', error: null, canStart: true })
    expect(r.hosts.tunnelHost()).toBeUndefined()
    expect(r.states()).toEqual(['off'])
  })

  it('ends the attempt when stop is pressed while starting', async () => {
    const r = rig([hanging()])
    r.manager.start()
    const stopped = await r.manager.stop()
    expect(stopped.state).toBe('off')
    expect(r.log.terminations).toBe(1)
    expect(r.probes()).toBe(0)
    expect(r.states()).not.toContain('online')
  })

  it('starts one tunnel when asked twice, and refuses a start while it is stopping', async () => {
    const r = rig([hanging()])
    r.manager.start()
    expect(r.manager.start().state).toBe('starting')
    // Give a wrongly spawned second process time to show up.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(r.log.spawns).toHaveLength(1)

    const stopping = r.manager.stop()
    expect(() => r.manager.start()).toThrowError(
      expect.objectContaining({
        code: 'REMOTE_ACCESS_OPERATION_IN_PROGRESS',
        details: 'operation_in_progress',
      })
    )
    // A second stop joins the one under way instead of answering before the tunnel is gone.
    expect(r.manager.stop()).toBe(stopping)
    expect((await stopping).state).toBe('off')
  })

  it('blocks start until stop succeeds when a process cannot be confirmed dead', async () => {
    const r = rig([readyWithUrl({ pid: GHOST_PID, terminateConfirms: [false, true] })])
    r.manager.start()
    await r.eventIn('online')

    const stuck = await r.manager.stop()
    expect(stuck).toMatchObject({ state: 'error', error: 'stop_failed', url: null })
    // Only Stop may be offered while a tunnel may still be running.
    expect([stuck.canStop, stuck.canStart]).toEqual([true, false])
    // A tunnel we gave up on is not trusted any more.
    expect(r.hosts.tunnelHost()).toBeUndefined()
    expect(() => r.manager.start()).toThrowError(
      expect.objectContaining({ code: 'REMOTE_ACCESS_STOP_FAILED', details: 'stop_failed' })
    )
    // The journal is kept: the process may still be there for the next owner to find.
    expect(r.journal.cleared).toBe(0)

    // The retry goes through the handle that was kept for it.
    const cleared = await r.manager.stop()
    expect(cleared).toMatchObject({ state: 'off', canStart: true })
    expect(r.journal.cleared).toBe(1)
    expect(r.exitHooks.size).toBe(0)
  })

  it('takes the state away from a supervisor that does not come back from a stop', async () => {
    const r = rig([readyWithUrl()])
    r.manager.start()
    await r.eventIn('online')
    // A terminate that never answers: the supervisor is stuck inside it.
    const stuckTunnel = (r.manager as unknown as { tunnel: TunnelProcess }).tunnel
    stuckTunnel.terminate = () => new Promise<boolean>(() => {})

    const started = Date.now()
    const stopped = await r.manager.stop()
    // Both grace periods plus the margin, not forever.
    expect(Date.now() - started).toBeLessThan(4000)
    expect(stopped).toMatchObject({ state: 'error', error: 'stop_failed', canStop: true, canStart: false })
    expect(r.hosts.tunnelHost()).toBeUndefined()
  }, 10_000)

  it('dismisses a failed attempt on stop, and a fresh start works', async () => {
    const r = rig([undefined, readyWithUrl()])
    r.manager.start()
    await r.eventIn('error')
    expect((await r.manager.stop()).state).toBe('off')
    r.manager.start()
    await r.eventIn('online')
  })

  it('dismisses a failed attempt on the next start as well', async () => {
    const r = rig([undefined, readyWithUrl()])
    r.manager.start()
    await r.eventIn('error')
    expect(r.manager.start().state).toBe('starting')
    expect((await r.eventIn('online')).url).toBe(URL_)
  })

  it('cannot have its shutdown teardown undone by a late supervisor', async () => {
    const r = rig([readyWithUrl()], { reachable: true, delayMs: 150 })
    r.manager.start()
    // Let the supervisor reach the probe, so the host is already trusted.
    for (let i = 0; i < 100 && r.hosts.tunnelHost() === undefined; i++)
      await new Promise((resolve) => setTimeout(resolve, 5))
    expect(r.hosts.tunnelHost()).toBe(HOST)

    r.manager.killNow()
    expect(r.hosts.tunnelHost()).toBeUndefined()
    expect(r.log.kills).toBe(1)
    expect(r.exitHooks.size).toBe(0)

    // Well past the moment the probe would have succeeded.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(r.manager.status().state).toBe('off')
    expect(r.hosts.tunnelHost()).toBeUndefined()
    expect(r.states()).not.toContain('online')
  })

  it('journals the live tunnel, guards it against a process exit, and clears both on stop', async () => {
    const r = rig([readyWithUrl({ pid: GHOST_PID })])
    r.manager.start()
    await r.eventIn('online')
    expect(r.journal.recorded).toEqual([[GHOST_PID, '/app/cloudflared']])
    expect(r.exitHooks.size).toBe(1)
    // What the process-exit hook does when the core dies with a tunnel up.
    for (const hook of r.exitHooks) hook()
    expect(r.log.kills).toBe(1)

    await r.manager.stop()
    // A confirmed exit leaves nothing to recover.
    expect(r.journal.cleared).toBe(1)
    expect(r.exitHooks.size).toBe(0)
  })

  it('does not keep a process that came up after the core had already shut the tunnel down', async () => {
    let release!: (tunnel: TunnelProcess | undefined) => void
    const kills: number[] = []
    const late: TunnelProcess = {
      pid: 7,
      exe: 'x',
      waitReady: () => new Promise(() => {}),
      waitExit: () => new Promise(() => {}),
      terminate: async () => true,
      killNow: () => void kills.push(7),
    }
    const manager = new RemoteAccessManager({
      spawner: () => new Promise((resolve) => (release = resolve)),
      prober: { verify: async () => true },
      server: () => ({ origin: 'http://127.0.0.1:1337', hasApiKey: false }),
      hosts: new DynamicTrustedHosts(),
      emit: () => {},
      onProcessExit: () => () => {},
    })
    manager.start()
    manager.killNow()
    release(late)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(kills).toEqual([7])
    expect(manager.status().state).toBe('off')
  })

  it('follows the server as well as the tunnel in what it announces', () => {
    const r = rig([])
    r.setServer(undefined)
    expect(r.manager.announce()).toMatchObject({ blockReason: 'server_stopped', canStart: false })
    r.setServer({ origin: 'http://127.0.0.1:1337', hasApiKey: true })
    expect(r.manager.announce()).toMatchObject({ blockReason: null, canStart: true, serverHasApiKey: true })
    expect(r.events).toHaveLength(2)
  })
})

describe('remoteAccessRefusal', () => {
  // The app's `the_wire_format_is_camel_case_keys_with_snake_case_codes`, for the refusals.
  it('carries a core code and the app reason the frontend parses', () => {
    expect(remoteAccessRefusal('server_stopped').toJSON()).toEqual({
      code: 'REMOTE_ACCESS_SERVER_STOPPED',
      message: 'Start the Local API Server before opening a tunnel to it.',
      details: 'server_stopped',
    })
    expect(remoteAccessRefusal('operation_in_progress').details).toBe('operation_in_progress')
    expect(remoteAccessRefusal('stop_failed').details).toBe('stop_failed')
  })
})
