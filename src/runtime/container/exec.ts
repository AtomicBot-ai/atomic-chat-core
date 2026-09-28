/**
 * Running one already-built docker argv (`argv.ts`) against the real `docker` binary. No shell:
 * `spawn` receives the executable and every argument as its own array element, so nothing a
 * descriptor, a probe or a mount path contains is ever interpreted by a shell. Modeled on
 * `src/hardware/probe.ts`'s `runTool` and `src/runtime/environment/host-exec.ts`'s `hostExec`: a
 * command that could not answer (missing binary, spawn failure, past its deadline) resolves with
 * `code: null` rather than rejecting, so a caller always gets one shape back.
 */
import { spawn } from 'node:child_process'
import type { DockerCommandResult, DockerExec } from './types.js'
import { dockerChildEnv } from './env.js'

export interface DockerCommandOptions {
  /** How long one docker call may take before it counts as unanswered. Default 30 s. */
  timeoutMs?: number
  /** Per stream; anything past it is dropped and the command still counts as answered. Default 4 MiB. */
  maxOutputBytes?: number
  env?: NodeJS.ProcessEnv
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** `spawn(exe, args)` with no shell, a sanitized environment (`env.ts`), a deadline and a bounded buffer. */
export function runDockerCommand(
  exe: string,
  args: string[],
  options: DockerCommandOptions = {}
): Promise<DockerCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise((resolve) => {
    let settled = false
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    // Unset until spawn succeeds: a spawn that throws synchronously leaves nothing to kill.
    let child: ReturnType<typeof spawn> | undefined

    const finish = (result: DockerCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    // Armed before the spawn so a spawn that throws on the spot still has a real timer to clear.
    const timer = setTimeout(() => {
      child?.kill('SIGKILL')
      finish({ code: null, stdout: '', stderr: `docker did not answer within ${timeoutMs} ms` })
    }, timeoutMs)
    timer.unref()

    try {
      child = spawn(exe, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: dockerChildEnv(options.env ?? process.env),
      })
    } catch (error) {
      // Some malformed calls throw synchronously; that is an unanswered command, not a crash.
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

export interface CreateDockerExecOptions extends DockerCommandOptions {
  /** The docker executable to run. Defaults to `'docker'` on `PATH`; tests inject a fake binary. */
  dockerPath?: string
}

/** The production `DockerExec`: real `docker`, the system socket already forced by `argv.ts`'s builders. */
export function createDockerExec(options: CreateDockerExecOptions = {}): DockerExec {
  const dockerPath = options.dockerPath ?? 'docker'
  return (args: string[]) => runDockerCommand(dockerPath, args, options)
}
