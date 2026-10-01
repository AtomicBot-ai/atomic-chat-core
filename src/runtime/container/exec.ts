/**
 * Running one already-built docker argv (`argv.ts`) against the real `docker` binary. No shell:
 * `spawn` receives the executable and every argument as its own array element, so nothing a
 * descriptor, a probe or a mount path contains is ever interpreted by a shell. Modeled on
 * `src/hardware/probe.ts`'s `runTool` and `src/runtime/environment/host-exec.ts`'s `hostExec`: a
 * command that could not answer (missing binary, spawn failure, past its deadline) resolves with
 * `code: null` rather than rejecting, so a caller always gets one shape back.
 *
 * `options.dockerConfigDir` is required (review round 1, item 5 ruling): every call creates it if
 * missing and points `DOCKER_CONFIG` at it, so the docker CLI never falls back to the user's own
 * `~/.docker/config.json` — see `env.ts`'s doc comment for why that fallback matters.
 */
import { spawn } from 'node:child_process'
import type { DockerCommandResult, DockerExec, DockerExecCallOptions } from './types.js'
import { HeadAndTail } from '../shared/index.js'
import { dockerChildEnv, ensureDockerConfigDir } from './env.js'

export interface DockerCommandOptions {
  /** How long one docker call may take before it counts as unanswered. Default 30 s; a per-call `timeoutMs` overrides it for just that call. */
  timeoutMs?: number
  /**
   * Per stream (so stdout and stderr together hold up to twice this). Past it the whole lines within
   * the first half and within the last half are kept and the middle is dropped; the command still
   * counts as answered. Default 4 MiB.
   */
  maxOutputBytes?: number
  env?: NodeJS.ProcessEnv
  /** An empty, core-owned directory the docker CLI reads as `$DOCKER_CONFIG` (review round 1, item 5 ruling). Created if missing before every call. */
  dockerConfigDir: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** `spawn(exe, args)` with no shell, a sanitized environment (`env.ts`), a deadline and a bounded buffer. */
export async function runDockerCommand(
  exe: string,
  args: string[],
  options: DockerCommandOptions,
  callOptions: DockerExecCallOptions = {}
): Promise<DockerCommandResult> {
  const timeoutMs = callOptions.timeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  await ensureDockerConfigDir(options.dockerConfigDir)
  const env = dockerChildEnv({ dockerConfigDir: options.dockerConfigDir, base: options.env ?? process.env })

  return new Promise((resolve) => {
    let settled = false
    const stdout = new HeadAndTail(limit)
    const stderr = new HeadAndTail(limit)
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
        env,
      })
    } catch (error) {
      // Some malformed calls throw synchronously; that is an unanswered command, not a crash.
      finish({ code: null, stdout: '', stderr: (error as Error).message })
      return
    }

    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))

    // A binary that is not on the machine arrives here as ENOENT, not as an exit code.
    child.on('error', (error) => finish({ code: null, stdout: '', stderr: error.message }))
    child.on('close', (code) => {
      finish({
        code,
        stdout: stdout.text(),
        stderr: stderr.text(),
      })
    })
  })
}

export interface CreateDockerExecOptions extends DockerCommandOptions {
  /** The docker executable to run. Defaults to `'docker'` on `PATH`; tests inject a fake binary. */
  dockerPath?: string
}

/**
 * The production `DockerExec`: real `docker`, the system socket already forced by `argv.ts`'s
 * builders. `dockerConfigDir` is required — see `env.ts`'s doc comment for why this module never
 * runs `docker` without one. The returned function accepts a per-call `DockerExecCallOptions`
 * (review round 1, item 3): `stopContainer` uses it to extend the deadline past a long `--time`.
 */
export function createDockerExec(options: CreateDockerExecOptions): DockerExec {
  const dockerPath = options.dockerPath ?? 'docker'
  return (args: string[], callOptions?: DockerExecCallOptions) =>
    runDockerCommand(dockerPath, args, options, callOptions)
}
