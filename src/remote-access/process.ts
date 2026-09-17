/**
 * The `cloudflared` child process: how it is launched, what is watched while it runs, and how it
 * is ended. The arguments and the reading of its output are pure and live next door.
 *
 * Deliberately not `spawnManaged`: that keeps every line a process ever wrote (a tunnel runs for
 * days) and waits without bound for an exit, while a tunnel needs an answer to "could its exit be
 * confirmed?" — a public URL that may still be served is a state of its own (`stop_failed`).
 *
 * PRIVACY: the output names the public URL. It is parsed and dropped, never logged or kept.
 *
 * Ported from: src-tauri/src/core/server/remote_access/process.rs (image-generation line, `767ff6350`).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { OutputParser, readyUrl } from './cloudflared-output.js'

export interface TunnelTimings {
  /** For the URL to be minted *and* an edge connection registered. */
  readyMs: number
  /** For the public URL to answer as this server, all probe phases together. */
  probeTotalMs: number
  /** After SIGTERM, before the kill (unix). */
  termGraceMs: number
  /** After the kill, for the exit to be confirmed. */
  killGraceMs: number
}

export const DEFAULT_TUNNEL_TIMINGS: TunnelTimings = {
  readyMs: 15_000,
  probeTotalMs: 45_000,
  termGraceMs: 5_000,
  killGraceMs: 5_000,
}

/** How waiting for a fresh tunnel to become usable ended. */
export type Ready =
  /** Minted and registered. */
  | { kind: 'url'; url: string }
  /** The process ended first. */
  | { kind: 'exited'; sawUrl: boolean }
  /** Still running, but not registered within the limit. */
  | { kind: 'timed-out'; sawUrl: boolean }
  /** It never ran at all (missing, not executable). */
  | { kind: 'spawn-failed' }

/** One running tunnel process, as the manager sees it; scripted in the manager's tests. */
export interface TunnelProcess {
  readonly pid: number | undefined
  /** The program that was started, for the crash-recovery journal. */
  readonly exe: string
  waitReady(limitMs: number): Promise<Ready>
  /** Resolves when the process has exited. */
  waitExit(): Promise<void>
  /** Ends the process. `false` means its exit could not be confirmed. */
  terminate(timings: Pick<TunnelTimings, 'termGraceMs' | 'killGraceMs'>): Promise<boolean>
  /** Signals only, for a shutdown that cannot wait. */
  killNow(): void
}

/** Launches a tunnel for `origin`, optionally forcing a transport. `undefined`: there is no binary. */
export type TunnelSpawner = (
  origin: string,
  protocol?: string
) => TunnelProcess | undefined | Promise<TunnelProcess | undefined>

/** A fully described child process, separate from launching it so tests can run another program. */
export interface TunnelCommand {
  program: string
  args: string[]
  env: Record<string, string>
}

/** A line longer than this is fed as it stands; cloudflared never prints one, a hostile stand-in might. */
const MAX_LINE_BYTES = 64 * 1024

export function spawnTunnel(
  command: TunnelCommand,
  platform: NodeJS.Platform = process.platform
): TunnelProcess {
  const child = spawn(command.program, command.args, {
    env: command.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  return new ChildTunnel(child, platform, command.program)
}

class ChildTunnel implements TunnelProcess {
  private readonly parser = new OutputParser()
  private readonly watchers = new Set<() => void>()
  private readonly exited: Promise<void>
  private spawnFailed = false
  private gone = false

  constructor(
    private readonly child: ChildProcess,
    private readonly platform: NodeJS.Platform,
    readonly exe: string
  ) {
    this.exited = new Promise<void>((resolve) => {
      const settle = () => {
        this.gone = true
        this.notify()
        resolve()
      }
      // Only the process decides that it has exited, never a closed pipe: on Windows a grandchild
      // can hold a pipe open, and the reverse is possible too.
      child.once('exit', settle)
      child.once('error', () => {
        this.spawnFailed = child.pid === undefined
        settle()
      })
    })
    // cloudflared logs to stderr; stdout is read too so neither pipe can fill up and stall it.
    this.drain(child.stdout)
    this.drain(child.stderr)
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  private drain(pipe: NodeJS.ReadableStream | null): void {
    if (!pipe) return
    let pending = ''
    pipe.setEncoding('utf8')
    // Keep draining after the URL is known: a full pipe blocks the child.
    pipe.on('data', (chunk: string) => {
      pending += chunk
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      if (pending.length > MAX_LINE_BYTES) {
        lines.push(pending)
        pending = ''
      }
      let changed = false
      for (const line of lines) changed = this.parser.feedLine(line) || changed
      if (changed) this.notify()
    })
    pipe.on('error', () => {})
  }

  private notify(): void {
    for (const watcher of [...this.watchers]) watcher()
  }

  waitReady(limitMs: number): Promise<Ready> {
    return new Promise<Ready>((resolve) => {
      const check = (timedOut = false): boolean => {
        const parsed = this.parser.snapshot()
        const url = readyUrl(parsed)
        const sawUrl = parsed.url !== undefined
        const outcome: Ready | undefined =
          url !== undefined
            ? { kind: 'url', url }
            : this.gone
              ? this.spawnFailed
                ? { kind: 'spawn-failed' }
                : { kind: 'exited', sawUrl }
              : timedOut
                ? { kind: 'timed-out', sawUrl }
                : undefined
        if (!outcome) return false
        clearTimeout(timer)
        this.watchers.delete(watcher)
        resolve(outcome)
        return true
      }
      const watcher = () => void check()
      const timer = setTimeout(() => void check(true), limitMs)
      timer.unref?.()
      this.watchers.add(watcher)
      check()
    })
  }

  waitExit(): Promise<void> {
    return this.exited
  }

  private exitedWithin(ms: number): Promise<boolean> {
    if (this.gone) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), ms)
      timer.unref?.()
      void this.exited.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  async terminate(timings: Pick<TunnelTimings, 'termGraceMs' | 'killGraceMs'>): Promise<boolean> {
    if (this.gone) return true
    // Windows has no graceful signal for a console-less child; go straight to TerminateProcess.
    if (this.platform !== 'win32') {
      this.signal('SIGTERM')
      if (await this.exitedWithin(timings.termGraceMs)) return true
    }
    this.signal('SIGKILL')
    return this.exitedWithin(timings.killGraceMs)
  }

  killNow(): void {
    if (!this.gone) this.signal('SIGKILL')
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      this.child.kill(signal)
    } catch {
      // Already gone, or never started.
    }
  }
}
