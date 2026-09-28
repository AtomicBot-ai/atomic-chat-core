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
  env?: NodeJS.ProcessEnv
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024

export type HostExec = (command: string, args: string[]) => Promise<CommandOutput>

export function hostExec(options: HostExecOptions = {}): HostExec {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return (command, args) =>
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
      const timer = setTimeout(() => {
        child?.kill('SIGKILL')
        finish({ code: null, stdout: '', stderr: `timed out after ${timeoutMs} ms` })
      }, timeoutMs)
      timer.unref()

      const finish = (output: CommandOutput): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(output)
      }

      try {
        child = spawn(command, args, {
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          ...(options.env === undefined ? {} : { env: options.env }),
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
      child.on('close', (code) => {
        finish({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        })
      })
    })
}
