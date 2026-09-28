/**
 * Running a read-only probe command on the real machine.
 *
 * The probes (`linux-probe`, `windows-probe`) are pure over an injected `exec`; this is the one that
 * actually spawns. Three things about it are deliberate.
 *
 * There is no shell. The command and every argument go to `spawn` as they are, so nothing in a path,
 * a user name or a registry value is ever interpreted.
 *
 * A command that could not answer is reported as `code: null`, the same as one that is not on the
 * machine at all. That covers a missing binary, a spawn that failed and a command that hung past the
 * deadline. The probes turn `null` into "unknown", and unknown blocks a setup rather than being read
 * as "absent": a hung `nvidia-smi` is not evidence that there is no driver, and treating it as such
 * would tell the user to install one they already have.
 *
 * Output is capped. A probe reads a few lines; a process that floods stdout is not allowed to fill
 * the core's memory on the way to being ignored.
 */

import { spawn } from 'node:child_process'
import type { CommandOutput } from './linux-probe.js'

export interface HostExecOptions {
  /** How long one command may take before it counts as unanswered. */
  timeoutMs?: number
  /** Per stream. Anything past it is dropped, and the command still counts as answered. */
  maxOutputBytes?: number
  /** Base environment every call spawns with. Defaults to inheriting `process.env` when omitted. */
  env?: NodeJS.ProcessEnv
  /**
   * When set, a command past its deadline gets SIGTERM first and this long to exit before SIGKILL,
   * and the answer waits for it to exit. For a package manager: killed outright, dpkg can be left
   * half-configured. Unset (the default for probes): SIGKILL and answer at once.
   */
  terminateGraceMs?: number
  /** Tests only: stands in for `child_process.spawn`. */
  spawnProcess?: typeof spawn
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
/**
 * After a timed-out command has exited, how long to wait for its output pipes to close. A leftover
 * grandchild can hold them open indefinitely, and `close` would wait for it.
 */
const PIPE_SETTLE_MS = 1_000
/** After SIGKILL, answer at the latest this much later, whatever the process table says. */
const KILL_SETTLE_MS = 5_000

export type HostExec = (
  command: string,
  args: string[],
  env?: Record<string, string | undefined>
) => Promise<CommandOutput>

/**
 * Overlays `overlay` onto `base` — a key mapped to a string sets it, a key mapped to `undefined`
 * strips it, and every other key of `base` passes through untouched. This is the "merge, not
 * replace" semantics `LinuxProbeDeps.exec`'s own `env` parameter documents (round 2, item 10): a
 * caller stripping `DOCKER_HOST` for one call must not also lose `PATH` for it.
 */
function overlayEnv(base: NodeJS.ProcessEnv, overlay: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) delete merged[key]
    else merged[key] = value
  }
  return merged
}

export function hostExec(options: HostExecOptions = {}): HostExec {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return (command, args, envOverlay) =>
    new Promise<CommandOutput>((resolve) => {
      let settled = false
      const stdout: Buffer[] = []
      const stderr: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      // Unset until spawn succeeds: a spawn that throws leaves nothing to kill.
      let child: ReturnType<typeof spawn> | undefined

      // Armed before the spawn, so every way of finishing — including a spawn that throws on the
      // spot — has a real timer to clear, and none of them can reach it before it exists.
      let timedOut = false
      const timer = setTimeout(() => {
        if (options.terminateGraceMs === undefined || child === undefined) {
          child?.kill('SIGKILL')
          finish({ code: null, stdout: '', stderr: `timed out after ${timeoutMs} ms` })
          return
        }
        // Ask first, then insist. The answer comes when the process is gone (`exit`, then a moment
        // for the pipes), or at the latest shortly after SIGKILL — never only on `close`.
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => {
          child?.kill('SIGKILL')
          setTimeout(finishTimedOut, KILL_SETTLE_MS).unref()
        }, options.terminateGraceMs).unref()
      }, timeoutMs)
      timer.unref()

      const finishTimedOut = (): void => {
        const said = Buffer.concat(stderr).toString('utf8')
        finish({ code: null, stdout: '', stderr: `${said}\ntimed out after ${timeoutMs} ms` })
        // Release our ends of the pipes: a grandchild still holding theirs must not keep this
        // (root) process alive after it has answered.
        child?.stdout?.destroy()
        child?.stderr?.destroy()
      }

      const finish = (output: CommandOutput): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(output)
      }

      // No overlay for this call and no configured base: `spawn` gets no `env` key at all, which is
      // how Node inherits `process.env` on its own — the same as before this parameter existed.
      const spawnEnv =
        envOverlay === undefined ? options.env : overlayEnv(options.env ?? process.env, envOverlay)

      try {
        child = (options.spawnProcess ?? spawn)(command, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(spawnEnv === undefined ? {} : { env: spawnEnv }),
        })
      } catch (error) {
        // `spawn` throws synchronously for some malformed calls; that is an unanswered command.
        finish({ code: null, stdout: '', stderr: (error as Error).message })
        return
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        if (stdoutBytes >= limit) return
        const take = chunk.subarray(0, limit - stdoutBytes)
        stdout.push(take)
        stdoutBytes += take.length
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= limit) return
        const take = chunk.subarray(0, limit - stderrBytes)
        stderr.push(take)
        stderrBytes += take.length
      })

      // A binary that is not on the machine arrives here as ENOENT, not as an exit code.
      child.on('error', (error) => finish({ code: null, stdout: '', stderr: error.message }))
      child.on('exit', () => {
        if (timedOut) setTimeout(finishTimedOut, PIPE_SETTLE_MS).unref()
      })
      child.on('close', (code) => {
        if (timedOut) {
          finishTimedOut()
          return
        }
        finish({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      })
    })
}
