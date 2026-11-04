/**
 * The launch gate of a llama.cpp pack on Windows: `llama-server.exe --version`, run from the staging
 * directory with the environment a model load gives the server, before the pack replaces anything.
 *
 * A Windows pack that cannot start — a DLL missing from the archive, a `ggml-*.dll` antivirus
 * quarantined while it was being unpacked, a build for another CPU — used to install without
 * complaint and die at the first model load with nothing on stderr, because the loader ends the
 * process before `main` prints anything. Here that exit code is read instead, the pack is refused
 * with a code the app can name, and the staging directory is removed, so the next install starts
 * clean. A check that runs out of time proves nothing (a first run of a 1 GB CUDA tree waits on the
 * scanner): the pack is then kept, as before this gate existed.
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AtomicCoreError, withLoadDiag } from '../../contracts/index.js'
import type { ErrorCode, LoadDiag } from '../../contracts/index.js'
import { isTransientFsError } from '../../downloads/index.js'
import { buildProcessEnv, discoverCudaPaths, nodeCudaProbeEnv } from '../../runtime/shared/index.js'

/** Long enough for a scanner to look at an unseen tree, short enough not to stall an install on a hang. */
export const WINDOWS_LAUNCH_CHECK_TIMEOUT_MS = 60_000
/** A scanner can hold a just-written executable for a moment, which surfaces as a spawn error. */
export const WINDOWS_LAUNCH_SPAWN_ATTEMPTS = 3
export const WINDOWS_LAUNCH_SPAWN_RETRY_MS = 1_000

/** NTSTATUS codes the Windows loader ends a process with before `main`: the build cannot start. */
const LOADER_FAILURES = new Map<number, string>([
  [0xc000_0135, 'STATUS_DLL_NOT_FOUND'],
  [0xc000_0138, 'STATUS_ORDINAL_NOT_FOUND'],
  [0xc000_0139, 'STATUS_ENTRYPOINT_NOT_FOUND'],
  [0xc000_007b, 'STATUS_INVALID_IMAGE_FORMAT'],
  [0xc000_0142, 'STATUS_DLL_INIT_FAILED'],
])
/** `STATUS_ILLEGAL_INSTRUCTION`: the build uses an instruction this CPU does not have. */
const ILLEGAL_INSTRUCTION = 0xc000_001d
/** Engine output kept in `details`; the app keeps only the last ~2 KB of them. */
const OUTPUT_TAIL_CHARS = 800

/** How one `--version` run ended. */
export interface LaunchOutcome {
  /** The exit code; `null` when the process ended on a signal or never started. */
  code: number | null
  signal: string | null
  stdout: string
  stderr: string
  /** The run was stopped at the deadline: inconclusive. */
  timedOut: boolean
  /** Windows would not start the file at all (`ENOENT`, `EACCES`, a file that is not an executable). */
  spawnError?: { code: string; message: string }
}

/** `execFile`'s promise form, as the check uses it; replaced in tests. */
export type LaunchExec = (
  file: string,
  args: string[],
  options: { env: Record<string, string>; cwd: string | undefined; timeout: number; windowsHide: true }
) => Promise<{ stdout: string; stderr: string }>

export interface WindowsLaunchCheckDeps {
  /** The environment a model load starts from; `process.env` by default, as the runtime's. */
  env?: NodeJS.ProcessEnv
  exec?: LaunchExec
  timeoutMs?: number
  spawnAttempts?: number
  spawnRetryMs?: number
  sleep?: (ms: number) => Promise<void>
  log?: (message: string) => void
}

/** A Windows exit code the way the load-diag line spells it: `0xC0000135`, `0x1`. */
export function windowsExitCodeHex(code: number): string {
  return `0x${(code >>> 0).toString(16).toUpperCase()}`
}

function tail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > OUTPUT_TAIL_CHARS ? `…${trimmed.slice(-OUTPUT_TAIL_CHARS)}` : trimmed
}

/**
 * The verdict on one finished run: nothing when the pack started (or the run timed out, which proves
 * nothing), otherwise the error to fail the install with. Its `details` end with the load-diag line.
 */
export function windowsLaunchVerdict(
  outcome: LaunchOutcome,
  pack: { version: string; backend: string }
): AtomicCoreError | undefined {
  if (outcome.timedOut) return undefined
  if (!outcome.spawnError && outcome.code === 0 && outcome.signal === null) return undefined
  const id = `${pack.version}/${pack.backend}`
  const output = tail(`${outcome.stderr}\n${outcome.stdout}`)
  const diag: LoadDiag = {
    stage: 'spawn',
    backend: pack.backend,
    build: pack.version,
    ...(output === '' ? { empty_stderr: true } : {}),
  }
  let code: ErrorCode = 'ENGINE_BINARY_BROKEN'
  let message: string
  let status: string
  let exitCode: number | null = null
  if (outcome.spawnError) {
    message = `Windows would not start the downloaded ${id} backend (${outcome.spawnError.code}). Install it again; the current backend stays.`
    status = `llama-server.exe could not be started: ${outcome.spawnError.message}`
  } else if (outcome.code !== null) {
    exitCode = outcome.code >>> 0
    const hex = windowsExitCodeHex(exitCode)
    diag.exit_code = hex
    const loader = LOADER_FAILURES.get(exitCode)
    if (exitCode === ILLEGAL_INSTRUCTION) {
      code = 'CPU_INSTRUCTION_UNSUPPORTED'
      message = `The downloaded ${id} backend uses a CPU instruction this processor does not have. Pick another build; the current backend stays.`
      status = `llama-server.exe --version: exit code ${hex} (STATUS_ILLEGAL_INSTRUCTION)`
    } else if (loader) {
      message = `Windows could not start the downloaded ${id} backend: a library it needs is missing or was blocked. Install it again; the current backend stays.`
      status = `llama-server.exe --version: exit code ${hex} (${loader})`
    } else {
      message = `The downloaded ${id} backend failed its launch check. Install it again; the current backend stays.`
      status = `llama-server.exe --version: exit code ${hex}`
    }
  } else {
    diag.signal = String(outcome.signal)
    message = `The downloaded ${id} backend failed its launch check. Install it again; the current backend stays.`
    status = `llama-server.exe --version: ended on ${String(outcome.signal)}`
  }
  return new AtomicCoreError(code, message, withLoadDiag(output ? `${status}\n${output}` : status, diag), {
    diagnostic: {
      component: 'backend',
      operation: 'install',
      stage: 'spawn',
      exitCode,
      engineVersion: pack.version,
    },
  })
}

const execFileAsync = promisify(execFile)
const defaultExec: LaunchExec = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, args, { ...options, encoding: 'utf8' })
  return { stdout, stderr }
}
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** One run, with `execFile`'s rejection read into an outcome rather than thrown. */
export async function runLaunch(
  exec: LaunchExec,
  file: string,
  options: Parameters<LaunchExec>[2]
): Promise<LaunchOutcome> {
  try {
    const { stdout, stderr } = await exec(file, ['--version'], options)
    return { code: 0, signal: null, stdout, stderr, timedOut: false }
  } catch (error) {
    const e = error as {
      code?: unknown
      signal?: unknown
      killed?: unknown
      stdout?: unknown
      stderr?: unknown
    }
    const stdout = String(e.stdout ?? '')
    const stderr = String(e.stderr ?? '')
    if (e.killed === true)
      return { code: null, signal: String(e.signal ?? 'SIGTERM'), stdout, stderr, timedOut: true }
    if (typeof e.code === 'number') return { code: e.code, signal: null, stdout, stderr, timedOut: false }
    if (typeof e.signal === 'string') return { code: null, signal: e.signal, stdout, stderr, timedOut: false }
    return {
      code: null,
      signal: null,
      stdout,
      stderr,
      timedOut: false,
      spawnError: {
        code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

/**
 * Run the staged pack's `llama-server.exe --version` with the PATH a load gives it (its own
 * `build/bin`, then any CUDA toolkit on the host), and throw `ENGINE_BINARY_BROKEN` or
 * `CPU_INSTRUCTION_UNSUPPORTED` when it cannot start. A spawn refused with a held-handle code is
 * retried; a run that times out is logged and accepted.
 */
export async function verifyWindowsBackendBinary(
  staging: string,
  version: string,
  backend: string,
  deps: WindowsLaunchCheckDeps = {}
): Promise<void> {
  const bin = join(staging, 'build', 'bin')
  const baseEnv = deps.env ?? process.env
  const { env, cwd } = buildProcessEnv({
    platform: 'win32',
    baseEnv,
    exeDir: bin,
    cuda: discoverCudaPaths(nodeCudaProbeEnv('win32', baseEnv)),
    userEnv: {},
  })
  const exec = deps.exec ?? defaultExec
  const sleep = deps.sleep ?? defaultSleep
  const attempts = deps.spawnAttempts ?? WINDOWS_LAUNCH_SPAWN_ATTEMPTS
  const timeout = deps.timeoutMs ?? WINDOWS_LAUNCH_CHECK_TIMEOUT_MS
  let outcome: LaunchOutcome
  for (let attempt = 1; ; attempt++) {
    outcome = await runLaunch(exec, join(bin, 'llama-server.exe'), { env, cwd, timeout, windowsHide: true })
    if (!outcome.spawnError || attempt >= attempts || !isTransientFsError(outcome.spawnError)) break
    await sleep(deps.spawnRetryMs ?? WINDOWS_LAUNCH_SPAWN_RETRY_MS)
  }
  if (outcome.timedOut) {
    deps.log?.(
      `${version}/${backend}: llama-server.exe --version did not answer in ${timeout} ms; installing it unverified`
    )
    return
  }
  const verdict = windowsLaunchVerdict(outcome, { version, backend })
  if (verdict) throw verdict
}
