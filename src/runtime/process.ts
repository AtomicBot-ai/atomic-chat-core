/**
 * Spawn a backend process and wait until it is ready. Port of the process half of
 * `load_llama_model_impl` (`commands.rs`) and `process.rs` in the llama.cpp plugin; MLX and
 * Foundation Models reuse it with their own ready markers and no `/health` poll.
 *
 * Readiness = a stdout/stderr line whose lowercase form contains one of `readyMarkers`, OR the
 * injected `healthCheck` reporting success (polled every 200 ms). An early exit is classified by the
 * caller-provided `classifyExit`; a timeout kills the child and raises `MODEL_LOAD_TIMED_OUT`.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { AtomicCoreError } from '../contracts/index.js'
import type { ExitInfo } from './llamacpp/errors.js'

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
  readyMarkers?: readonly string[]
  /** Poll for readiness (e.g. `GET /health` → 2xx); omitted for backends without a health route. */
  healthCheck?: () => Promise<boolean>
  healthIntervalMs?: number
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void
  /** Turn an early exit into the error the caller wants. */
  classifyExit: (exit: ExitInfo, stderr: string, stdout: string) => AtomicCoreError
  /** Details for the timeout error (`Timeout: Ns\n\nStderr:\n…` in the app). */
  timeoutMessage?: string
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

/** Spawn without waiting; used by `spawnAndAwaitReady` and by probes that just want output. */
export function spawnManaged(spec: SpawnSpec, onLine?: ReadyOptions['onLine']): ManagedProcess {
  const child = spawn(spec.exe, spec.args, {
    env: spec.env,
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdoutBuf = ''
  let stderrBuf = ''
  const wire = (stream: 'stdout' | 'stderr') => {
    const src = stream === 'stdout' ? child.stdout : child.stderr
    if (!src) return
    const rl = createInterface({ input: src, crlfDelay: Infinity })
    rl.on('line', (raw) => {
      const line = raw.replace(/\s+$/, '')
      if (line === '') return
      if (stream === 'stdout') stdoutBuf += line + '\n'
      else stderrBuf += line + '\n'
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
  const markers = opts.readyMarkers ?? LLAMA_READY_MARKERS
  let resolveReady: ((via: 'log' | 'health') => void) | undefined
  const ready = new Promise<'log' | 'health'>((r) => (resolveReady = r))

  const proc = spawnManaged(spec, (stream, line) => {
    opts.onLine?.(stream, line)
    if (isReadyLogLine(line.toLowerCase(), markers)) resolveReady?.('log')
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

  try {
    const outcome = await Promise.race([
      ready.then((via) => ({ kind: 'ready' as const, via })),
      proc.exited.then((exit) => ({ kind: 'exit' as const, exit })),
      timeout.then(() => ({ kind: 'timeout' as const })),
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
    await proc.terminate(1000)
    const { stderr } = proc.output()
    throw new AtomicCoreError(
      'MODEL_LOAD_TIMED_OUT',
      opts.timeoutMessage ?? 'The model took too long to load and timed out.',
      `Timeout: ${Math.round(opts.timeoutMs / 1000)}s\n\nStderr:\n${stderr}`
    )
  } finally {
    stopHealth()
  }
}

/** `kill(pid, 0)` liveness probe. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}
