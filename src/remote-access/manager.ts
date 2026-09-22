/**
 * Remote access: a Cloudflare quick tunnel in front of the Local API Server.
 *
 * `cloudflared` gives the OpenAI-compatible API a temporary public `https://<words>.trycloudflare.com`
 * address, so another Atomic Chat, an SDK or a coding agent can use this machine's models from
 * anywhere. No account, no domain, a new URL on every start.
 *
 * Shape of the code:
 *
 *  - `RemoteAccessManager` is the state machine the control routes talk to. JavaScript gives it what
 *    the Rust original needed a mutex for: nothing here awaits between reading the state and writing
 *    it, so `start` and `stop` decide on a consistent view.
 *  - One *supervisor* per run owns the child process. It waits for the tunnel to register, proves the
 *    URL reaches this server before anybody sees it, then watches for the process to exit. A `run`
 *    counter makes a supervisor that was overtaken (a stop timed out, the core is shutting down)
 *    unable to write state any more.
 *  - Every transition is pushed to clients as `remote-access:status`, because the URL arrives seconds
 *    after the request that asked for it has answered.
 *
 * The API key is deliberately not a precondition: exposing the server without one is the user's
 * call, made explicit by the frontend.
 *
 * PRIVACY: the tunnel URL is never logged.
 *
 * Ported from: src-tauri/src/core/server/remote_access/mod.rs (image-generation line, `767ff6350`).
 * ADR 2026-09-17-the-core-owns-the-cloudflare-quick-tunnel.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type { ErrorCode, RemoteAccessRefusal, RemoteAccessStatus } from '../contracts/index.js'
import type { Prober } from './probe.js'
import { DEFAULT_TUNNEL_TIMINGS } from './process.js'
import type { TunnelProcess, TunnelSpawner, TunnelTimings } from './process.js'
import { OFF, deriveStatus, failed, hostOf } from './status.js'
import type { Phase, ServerEndpoint } from './status.js'

/**
 * cloudflared picks QUIC (UDP) by itself. Networks that drop UDP still let the HTTP/2 (TCP)
 * transport through, on the same port 7844, so that is the one retry worth making.
 */
const PROTOCOL_ATTEMPTS: ReadonlyArray<string | undefined> = [undefined, 'http2']

/** How long `stop` waits for the supervisor beyond its own grace periods. */
const STOP_SUPERVISOR_MARGIN_MS = 2_000

const REFUSAL_CODES: Record<RemoteAccessRefusal, ErrorCode> = {
  server_stopped: 'REMOTE_ACCESS_SERVER_STOPPED',
  operation_in_progress: 'REMOTE_ACCESS_OPERATION_IN_PROGRESS',
  stop_failed: 'REMOTE_ACCESS_STOP_FAILED',
}

const REFUSAL_MESSAGES: Record<RemoteAccessRefusal, string> = {
  server_stopped: 'Start the Local API Server before opening a tunnel to it.',
  operation_in_progress: 'The tunnel is being stopped; try again once it is down.',
  stop_failed: 'The previous tunnel may still be running; stop it first.',
}

/** The refusal of a start. `details` is the app's machine-readable reason, which its parser reads. */
export function remoteAccessRefusal(reason: RemoteAccessRefusal): AtomicCoreError {
  return new AtomicCoreError(REFUSAL_CODES[reason], REFUSAL_MESSAGES[reason], reason)
}

/** Where the tunnel name is trusted while the tunnel is up (the listener's `DynamicTrustedHosts`). */
export interface TunnelHosts {
  setTunnelHost(host: string): void
  clearTunnelHost(): void
}

export interface RemoteAccessManagerDeps {
  spawner: TunnelSpawner
  prober: Prober
  timings?: Partial<TunnelTimings>
  /** The running public server; `undefined` while it is stopped or stopping. */
  server: () => ServerEndpoint | undefined
  hosts: TunnelHosts
  emit: (status: RemoteAccessStatus) => void
  /** Crash recovery; a tunnel is simply not journalled without one. */
  journal?: { record(pid: number, exe: string): Promise<void>; clear(): Promise<void> }
  /**
   * Run `hook` if this process exits while a tunnel may still be alive; returns how to unregister.
   * The last line of defence, as `kill_on_drop` was: a public URL must not outlive its owner.
   */
  onProcessExit?: (hook: () => void) => () => void
  log?: (level: 'info' | 'warn', message: string) => void
}

const defaultExitHook = (hook: () => void): (() => void) => {
  process.once('exit', hook)
  return () => process.off('exit', hook)
}

type Verified = 'stopped' | 'exited' | 'reachable' | 'unreachable'

export class RemoteAccessManager {
  private phase: Phase = OFF
  private url: string | undefined
  /** Identifies the supervisor allowed to write this state. */
  private run = 0
  /** Kept while the process may still be alive: for shutdown, and to retry a stop that was not confirmed. */
  private tunnel: TunnelProcess | undefined
  private signalStop: (() => void) | undefined
  private supervisor: Promise<void> | undefined
  private stopping: Promise<RemoteAccessStatus> | undefined
  private probe: AbortController | undefined
  private removeExitHook: (() => void) | undefined
  private readonly timings: TunnelTimings

  constructor(private readonly deps: RemoteAccessManagerDeps) {
    this.timings = { ...DEFAULT_TUNNEL_TIMINGS, ...deps.timings }
  }

  status(): RemoteAccessStatus {
    return deriveStatus({ phase: this.phase, url: this.url }, this.deps.server())
  }

  /**
   * Computes the status and pushes it to clients. Also called when the public server starts or
   * stops: `blockReason` and `canStart` follow the server, not only the tunnel.
   */
  announce(): RemoteAccessStatus {
    const status = this.status()
    this.deps.emit(status)
    return status
  }

  /**
   * Starts a tunnel and answers at once with `starting`; the rest is reported through events.
   * Refuses with a machine-readable reason. Synchronous on purpose: the endpoint is read and the
   * phase flipped with nothing in between.
   */
  start(): RemoteAccessStatus {
    const server = this.deps.server()
    if (!server) throw remoteAccessRefusal('server_stopped')
    const phase = this.phase
    if (phase.kind === 'stopping') throw remoteAccessRefusal('operation_in_progress')
    if (phase.kind === 'failed' && phase.error === 'stop_failed') throw remoteAccessRefusal('stop_failed')
    // `starting` and `online` are already on their way or up: asking again changes nothing. A failed
    // attempt is simply dismissed by the next one.
    if (phase.kind === 'off' || phase.kind === 'failed') {
      const run = ++this.run
      this.phase = { kind: 'starting' }
      this.url = undefined
      this.tunnel = undefined
      const stopped = new Promise<void>((resolve) => (this.signalStop = resolve))
      // The endpoint carries the *bound* port (a fallback can change it) and a host that listens.
      this.supervisor = this.supervise(run, server.origin, stopped).catch((error: Error) => {
        this.deps.log?.('warn', `remote access: the tunnel supervisor failed: ${error.message}`)
        if (this.isCurrent(run)) return this.endRun(run, this.tunnel, failed('exited'))
      })
    }
    return this.announce()
  }

  /**
   * Stops the tunnel and answers once it is down (normally well under a second; up to the two
   * grace periods when the process does not react). A stop already under way is joined, so whoever
   * needs the tunnel gone — the public server, above all — can rely on the answer.
   */
  stop(): Promise<RemoteAccessStatus> {
    if (this.stopping) return this.stopping
    const stopping = this.stopNow().finally(() => {
      if (this.stopping === stopping) this.stopping = undefined
    })
    this.stopping = stopping
    return stopping
  }

  private async stopNow(): Promise<RemoteAccessStatus> {
    const phase = this.phase
    if (phase.kind === 'failed' && phase.error === 'stop_failed') {
      // The retry goes through the handle that was kept for it.
      const confirmed = this.tunnel ? await this.tunnel.terminate(this.timings) : true
      if (confirmed) await this.settleStopped()
    } else if (phase.kind === 'failed') {
      this.phase = OFF
      this.url = undefined
    } else if (phase.kind === 'starting' || phase.kind === 'online') {
      const run = this.run
      this.phase = { kind: 'stopping' }
      this.announce()
      this.signalStop?.()
      this.signalStop = undefined
      const limit = this.timings.termGraceMs + this.timings.killGraceMs + STOP_SUPERVISOR_MARGIN_MS
      const finished = await this.within(this.supervisor, limit)
      if (!finished && this.run === run && this.phase.kind === 'stopping') {
        // The supervisor is stuck. Take the state away from it so it cannot write later, and say
        // what is true: a tunnel may still be running.
        this.run++
        this.phase = failed('stop_failed')
        this.url = undefined
        this.probe?.abort()
        this.deps.hosts.clearTunnelHost()
      }
    }
    return this.announce()
  }

  /**
   * Synchronous teardown for a shutdown that cannot wait: signals only. Whatever the supervisor
   * still does, it no longer owns the state.
   */
  killNow(): void {
    this.run++
    this.phase = OFF
    this.url = undefined
    this.signalStop = undefined
    this.probe?.abort()
    this.deps.hosts.clearTunnelHost()
    this.tunnel?.killNow()
    this.tunnel = undefined
    this.removeExitHook?.()
    this.removeExitHook = undefined
    void this.deps.journal?.clear().catch(() => {})
  }

  private isCurrent(run: number): boolean {
    return this.run === run
  }

  private within(work: Promise<unknown> | undefined, ms: number): Promise<boolean> {
    if (!work) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
      void work.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  private async settleStopped(): Promise<void> {
    this.deps.hosts.clearTunnelHost()
    this.phase = OFF
    this.url = undefined
    this.tunnel = undefined
    this.removeExitHook?.()
    this.removeExitHook = undefined
    await this.deps.journal?.clear().catch(() => {})
  }

  private recordChild(run: number, tunnel: TunnelProcess): void {
    if (!this.isCurrent(run)) return
    this.tunnel = tunnel
    this.removeExitHook?.()
    this.removeExitHook = (this.deps.onProcessExit ?? defaultExitHook)(() => tunnel.killNow())
    if (tunnel.pid !== undefined) void this.deps.journal?.record(tunnel.pid, tunnel.exe).catch(() => {})
  }

  /** Flips `starting` to `online`. `false` means a stop got there first. */
  private goOnline(run: number, url: string): boolean {
    if (!this.isCurrent(run) || this.phase.kind !== 'starting') return false
    this.phase = { kind: 'online' }
    this.url = url
    return true
  }

  /**
   * Ends the process and records how the run ended. An exit that cannot be confirmed overrides
   * `outcome`: the truth is then "may still be running".
   */
  private async endRun(run: number, tunnel: TunnelProcess | undefined, outcome: Phase): Promise<void> {
    const confirmed = tunnel ? await tunnel.terminate(this.timings) : true
    // Overtaken (a stop timed out, or the core is shutting down): whoever took over has already
    // written the state and cleared the host.
    if (!this.isCurrent(run)) return
    this.deps.hosts.clearTunnelHost()
    this.url = undefined
    this.signalStop = undefined
    if (confirmed) {
      // A stop that raced with a failure still ends in `off`: the user asked for nothing to be
      // running, and nothing is.
      this.phase = this.phase.kind === 'stopping' ? OFF : outcome
      this.tunnel = undefined
      this.removeExitHook?.()
      this.removeExitHook = undefined
      await this.deps.journal?.clear().catch(() => {})
    } else {
      this.phase = failed('stop_failed')
    }
    if (outcome.kind === 'failed')
      this.deps.log?.('warn', `remote access: the tunnel ended: ${outcome.error}`)
    this.announce()
  }

  private async supervise(run: number, origin: string, stopped: Promise<void>): Promise<void> {
    const timings = this.timings
    for (const [attempt, protocol] of PROTOCOL_ATTEMPTS.entries()) {
      const tunnel = await this.deps.spawner(origin, protocol)
      if (!tunnel) return this.endRun(run, undefined, failed('cloudflared_unavailable'))
      if (!this.isCurrent(run)) {
        // Shut down while the binary was being located: this process was never ours to keep.
        tunnel.killNow()
        return
      }
      this.recordChild(run, tunnel)

      const ready = await Promise.race([stopped.then(() => undefined), tunnel.waitReady(timings.readyMs)])
      if (ready === undefined) return this.endRun(run, tunnel, OFF)
      if (ready.kind === 'spawn-failed') return this.endRun(run, tunnel, failed('cloudflared_unavailable'))
      if (ready.kind !== 'url') {
        const isLastAttempt = attempt + 1 === PROTOCOL_ATTEMPTS.length
        // A URL without a registered connection is what a network that drops QUIC looks like; no
        // URL at all means Cloudflare was not reached, and another transport will not help.
        if (ready.sawUrl && !isLastAttempt) {
          if (!(await tunnel.terminate(timings))) return this.endRun(run, tunnel, failed('stop_failed'))
          this.deps.log?.('info', 'remote access: no edge connection registered; retrying over HTTP/2')
          continue
        }
        return this.endRun(run, tunnel, failed(ready.sawUrl ? 'not_registered' : 'no_url'))
      }

      const host = hostOf(ready.url)
      if (host === undefined) return this.endRun(run, tunnel, failed('no_url'))
      // Before the probe, not after it: the probe path is exempt from Host validation, the first
      // real request is not.
      if (this.isCurrent(run)) this.deps.hosts.setTunnelHost(host)

      const probe = new AbortController()
      this.probe = probe
      const verified = await Promise.race<Verified>([
        stopped.then(() => 'stopped'),
        tunnel.waitExit().then(() => 'exited'),
        this.deps.prober
          .verify(ready.url, timings.probeTotalMs, probe.signal)
          .then((reachable) => (reachable ? 'reachable' : 'unreachable')),
      ])
      probe.abort()
      if (verified === 'stopped') return this.endRun(run, tunnel, OFF)
      if (verified === 'exited') return this.endRun(run, tunnel, failed('exited'))
      if (verified === 'unreachable') return this.endRun(run, tunnel, failed('not_reachable'))

      // A stop arrived between the probe and here.
      if (!this.goOnline(run, ready.url)) return this.endRun(run, tunnel, OFF)
      this.deps.log?.('info', 'remote access: the tunnel is online')
      this.announce()

      const outcome = await Promise.race<Phase>([
        stopped.then(() => OFF),
        tunnel.waitExit().then(() => failed('exited')),
      ])
      return this.endRun(run, tunnel, outcome)
    }
  }
}
