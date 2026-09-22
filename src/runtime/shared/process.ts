/**
 * Spawn a backend process and wait until it is ready. Port of the process half of
 * `load_llama_model_impl` (`commands.rs`) and `process.rs` in the llama.cpp plugin; MLX and
 * Foundation Models reuse it with their own ready markers and no `/health` poll.
 *
 * Readiness = a stdout/stderr line whose lowercase form contains one of `readyMarkers`, OR the
 * injected `healthCheck` reporting success (polled every 200 ms). An early exit is classified by the
 * caller-provided `classifyExit`; a timeout kills the child and raises `MODEL_LOAD_TIMED_OUT`.
 *
 * Two signals can stop a start, and they mean different things. `signal` is the owner shutting
 * down: the child gets a grace period and the caller sees `CORE_NOT_RUNNING`. `cancelSignal` is the
 * user cancelling this load: the child is killed at once, so its memory is back before the error
 * reaches anyone, and the caller sees `MODEL_LOAD_CANCELLED`.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { AtomicCoreError } from '../../contracts/index.js'
import type { SessionInfo } from '../../contracts/index.js'
import type { ExitInfo } from '../llamacpp/index.js'
import { loadCancelledError } from './load-cancel.js'

/** Substrings (lowercase) that mean llama-server's HTTP server is up; stable across upstream rewordings. */
export const LLAMA_READY_MARKERS = [
  'listening on',
  'all slots are idle',
  'starting the main loop',
  'http server listening',
]

export function isReadyLogLine(lineLower: string, markers: readonly string[] = LLAMA_READY_MARKERS): boolean {
  return markers.some((m) => lineLower.includes(m))
}

export interface SpawnSpec {
  exe: string
  args: string[]
  env: Record<string, string>
  cwd?: string | undefined
}

export interface ReadyOptions {
  timeoutMs: number
  /** Cancel process startup (owner shutdown); the child is terminated before rejection. */
  signal?: AbortSignal
  /** The user cancelled this load: kill the child immediately and raise `MODEL_LOAD_CANCELLED`. */
  cancelSignal?: AbortSignal
  readyMarkers?: readonly string[]
  /** Poll for readiness (e.g. `GET /health` → 2xx); omitted for backends without a health route. */
  healthCheck?: () => Promise<boolean>
  healthIntervalMs?: number
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void
  /** Turn an early exit into the error the caller wants. */
  classifyExit: (exit: ExitInfo, stderr: string, stdout: string) => AtomicCoreError
  /** Details for the timeout error (`Timeout: Ns\n\nStderr:\n…` in the app). */
  timeoutMessage?: string
  /** Build the timeout error yourself, for backends whose timeout has its own code (MLX, Foundation Models). */
  timeoutError?: (stderr: string) => AtomicCoreError
  /** Grace before SIGKILL when the startup times out; 0 kills at once, as the MLX plugin does. */
  timeoutGraceMs?: number
  /**
   * A line that means the startup has already failed, before the process exits — Foundation Models
   * writes its reason and only then exits. The child is terminated and this error is raised.
   */
  failOnLine?: (stream: 'stdout' | 'stderr', line: string) => AtomicCoreError | undefined
  /** Separate readiness markers per stream, when a backend says "ready" differently on each (MLX). */
  streamReadyMarkers?: { stdout: readonly string[]; stderr: readonly string[] }
}

export interface ManagedProcess {
  child: ChildProcess
  pid: number
  /** Resolves when the process exits (never rejects). */
  exited: Promise<ExitInfo>
  /** SIGTERM → wait `graceMs` → SIGKILL on unix; `kill()` (TerminateProcess) on Windows. */
  terminate: (graceMs?: number) => Promise<ExitInfo>
  /** Everything the process wrote so far (kept for later classification). */
  output: () => { stdout: string; stderr: string }
  /** Set when the process could not be started at all (ENOENT, EACCES, …). */
  spawnFailure: () => Error | undefined
}

export const DEFAULT_TERMINATE_GRACE_MS = 5000

function exitInfo(code: number | null, signal: NodeJS.Signals | null): ExitInfo {
  return { code, signal }
}

/**
 * What a caller that reads the output itself asks for
 * (ADR 2026-09-17-spawnmanaged-reports-raw-chunks-and-can-skip-capturing-output).
 */
export interface SpawnHooks {
  /**
   * Raw bytes as they arrive, before any line splitting. For a process that redraws a line in place
   * (`\r…ESC[K`): a reader keyed on line ends sees every redraw one step late.
   */
  onData?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void
  /** `false` keeps nothing: `output()` stays empty. For a verbose process that runs for hours. */
  captureOutput?: boolean
}

/** Spawn without waiting; used by `spawnAndAwaitReady` and by probes that just want output. */
export function spawnManaged(
  spec: SpawnSpec,
  onLine?: ReadyOptions['onLine'],
  hooks: SpawnHooks = {}
): ManagedProcess {
  const child = spawn(spec.exe, spec.args, {
    env: spec.env,
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  const capture = hooks.captureOutput !== false
  let stdoutBuf = ''
  let stderrBuf = ''
  const wire = (stream: 'stdout' | 'stderr') => {
    const src = stream === 'stdout' ? child.stdout : child.stderr
    if (!src) return
    const { onData } = hooks
    if (onData) src.on('data', (chunk: Buffer) => onData(stream, chunk))
    // Nobody wants lines: leave the pipe to `onData`, or drain it so the child never blocks on a full one.
    if (!capture && !onLine) {
      if (!onData) src.resume()
      return
    }
    const rl = createInterface({ input: src, crlfDelay: Infinity })
    rl.on('line', (raw) => {
      const line = raw.replace(/\s+$/, '')
      if (line === '') return
      if (capture) {
        if (stream === 'stdout') stdoutBuf += line + '\n'
        else stderrBuf += line + '\n'
      }
      onLine?.(stream, line)
    })
  }
  wire('stdout')
  wire('stderr')
  let spawnFailure: Error | undefined
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('exit', (code, signal) => resolve(exitInfo(code, signal)))
    child.once('error', (e) => {
      spawnFailure = e
      resolve(exitInfo(null, null))
    })
  })
  const terminate = async (graceMs = DEFAULT_TERMINATE_GRACE_MS): Promise<ExitInfo> => {
    if (child.exitCode !== null || child.signalCode !== null) return exited
    if (process.platform === 'win32') {
      child.kill()
      return exited
    }
    if (graceMs <= 0) {
      child.kill('SIGKILL')
      return exited
    }
    child.kill('SIGTERM')
    const timer = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), graceMs).unref())
    const outcome = await Promise.race([exited, timer])
    if (outcome === 'timeout') {
      child.kill('SIGKILL')
      return exited
    }
    return outcome
  }
  return {
    child,
    pid: child.pid ?? -1,
    exited,
    terminate,
    output: () => ({ stdout: stdoutBuf, stderr: stderrBuf }),
    spawnFailure: () => spawnFailure,
  }
}

export interface SpawnReadyResult {
  process: ManagedProcess
  /** Which signal reported readiness. */
  readyVia: 'log' | 'health'
}

export async function spawnAndAwaitReady(spec: SpawnSpec, opts: ReadyOptions): Promise<SpawnReadyResult> {
  if (opts.signal?.aborted)
    throw new AtomicCoreError('CORE_NOT_RUNNING', 'The runtime stopped before the process could start.')
  if (opts.cancelSignal?.aborted) throw loadCancelledError()
  const markers = opts.readyMarkers ?? LLAMA_READY_MARKERS
  let resolveReady: ((via: 'log' | 'health') => void) | undefined
  const ready = new Promise<'log' | 'health'>((r) => (resolveReady = r))
  let resolveFailed: ((error: AtomicCoreError) => void) | undefined
  const failed = new Promise<AtomicCoreError>((r) => (resolveFailed = r))

  const proc = spawnManaged(spec, (stream, line) => {
    opts.onLine?.(stream, line)
    const failure = opts.failOnLine?.(stream, line)
    if (failure) resolveFailed?.(failure)
    const streamMarkers = opts.streamReadyMarkers ? opts.streamReadyMarkers[stream] : markers
    if (isReadyLogLine(line.toLowerCase(), streamMarkers)) resolveReady?.('log')
  })

  let healthTimer: NodeJS.Timeout | undefined
  let healthStopped = false
  const stopHealth = () => {
    healthStopped = true
    if (healthTimer) clearTimeout(healthTimer)
  }
  if (opts.healthCheck) {
    const interval = opts.healthIntervalMs ?? 200
    const poll = async () => {
      if (healthStopped) return
      try {
        if (await opts.healthCheck!()) {
          resolveReady?.('health')
          return
        }
      } catch {
        // not ready yet
      }
      if (!healthStopped) healthTimer = setTimeout(poll, interval)
    }
    healthTimer = setTimeout(poll, interval)
  }

  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), opts.timeoutMs).unref())
  let resolveAbort: (() => void) | undefined
  const aborted = new Promise<'aborted'>((resolve) => {
    resolveAbort = () => resolve('aborted')
    opts.signal?.addEventListener('abort', resolveAbort, { once: true })
  })
  let resolveCancel: (() => void) | undefined
  const cancelled = new Promise<'cancelled'>((resolve) => {
    resolveCancel = () => resolve('cancelled')
    opts.cancelSignal?.addEventListener('abort', resolveCancel, { once: true })
  })

  try {
    const outcome = await Promise.race([
      ready.then((via) => ({ kind: 'ready' as const, via })),
      proc.exited.then((exit) => ({ kind: 'exit' as const, exit })),
      timeout.then(() => ({ kind: 'timeout' as const })),
      aborted.then(() => ({ kind: 'aborted' as const })),
      cancelled.then(() => ({ kind: 'cancelled' as const })),
      failed.then((error) => ({ kind: 'failed' as const, error })),
    ])
    if (outcome.kind === 'ready') return { process: proc, readyVia: outcome.via }
    if (outcome.kind === 'exit') {
      // A process that never started (ENOENT, EACCES, …) also settles `exited`.
      const failure = proc.spawnFailure()
      if (failure) throw new AtomicCoreError('IO_ERROR', 'An input/output error occurred.', failure.message)
      // Give the pipes a tick to flush their last lines before classifying.
      await new Promise((r) => setTimeout(r, 10))
      const { stdout, stderr } = proc.output()
      if (outcome.exit.code === 0 && outcome.exit.signal === null) {
        // Exited cleanly without ever reporting ready.
        throw opts.classifyExit({ code: 0, signal: null }, stderr, stdout)
      }
      throw opts.classifyExit(outcome.exit, stderr, stdout)
    }
    // A cancel frees the memory now: no grace, and the error is raised only once the child is gone.
    const graceMs =
      outcome.kind === 'cancelled' ? 0 : outcome.kind === 'timeout' ? (opts.timeoutGraceMs ?? 1000) : 1000
    await proc.terminate(graceMs)
    if (outcome.kind === 'cancelled') throw loadCancelledError()
    if (outcome.kind === 'failed') throw outcome.error
    if (outcome.kind === 'aborted') {
      throw new AtomicCoreError('CORE_NOT_RUNNING', 'The runtime stopped while the process was starting.')
    }
    const { stderr } = proc.output()
    if (opts.timeoutError) throw opts.timeoutError(stderr)
    throw new AtomicCoreError(
      'MODEL_LOAD_TIMED_OUT',
      opts.timeoutMessage ?? 'The model took too long to load and timed out.',
      `Timeout: ${Math.round(opts.timeoutMs / 1000)}s\n\nStderr:\n${stderr}`
    )
  } finally {
    stopHealth()
    if (resolveAbort) opts.signal?.removeEventListener('abort', resolveAbort)
    if (resolveCancel) opts.cancelSignal?.removeEventListener('abort', resolveCancel)
  }
}

/** `kill(pid, 0)` liveness probe. */
/**
 * The process id this session runs under on this machine.
 *
 * A container session has none. The Docker client that started it has already exited, and the pid
 * inside the container belongs to another kernel's numbering — on Windows, to another kernel
 * entirely. So asking for one is a mistake to report rather than a null to paper over: the native
 * journal, the reaper and the liveness probes would all end up addressing whatever else on this
 * machine happens to hold that number.
 */
export function hostPid(session: SessionInfo): number {
  if (session.execution === 'container' || session.pid === null) {
    throw new AtomicCoreError(
      'MANAGED_IDENTITY_MISMATCH',
      'This session does not run as a process on this machine.',
      `${session.model_id} (${session.execution ?? 'native'})`
    )
  }
  return session.pid
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
