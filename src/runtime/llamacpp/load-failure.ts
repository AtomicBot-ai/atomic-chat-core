/**
 * What a failed llama.cpp load carries beyond its error body: the `atomic-core-diag` line the app
 * reads from the tail of `details` (`src/contracts/load-diag.ts`), the stage the load stopped at, and
 * whether the failure is one a single retry on another installed build may get past. Pure; the
 * runtime gathers the facts while it spawns.
 */

import { AtomicCoreError, parseLoadDiag, withLoadDiag } from '../../contracts/index.js'
import type { LoadDiag } from '../../contracts/index.js'
import { formatExitCode } from './errors.js'

/** What llama-server prints once the weights are in memory, before it starts listening. */
const WEIGHTS_LOADED = /\bmodel loaded\b/i

export function isWeightsLoadedLine(line: string): boolean {
  return WEIGHTS_LOADED.test(line)
}

/**
 * Where a load stopped. `spawn`: the process never ran its own code — it could not be started, the
 * Windows loader refused it, or it exited without printing a line. `load`: it died or timed out while
 * loading the weights. `ready`: the weights were loaded and it never said it was listening.
 * `runtime`: it had said so, and the load failed after that.
 */
export function loadFailureStage(input: {
  code: string
  printed: boolean
  weightsLoaded: boolean
  ready: boolean
}): NonNullable<LoadDiag['stage']> {
  if (input.ready) return 'runtime'
  if (input.code === 'IO_ERROR' || input.code === 'ENGINE_BINARY_BROKEN') return 'spawn'
  if (input.weightsLoaded) return 'ready'
  if (input.code === 'MODEL_LOAD_TIMED_OUT' || input.printed) return 'load'
  return 'spawn'
}

/** Errors that end a load without being a failure of it: the user's cancel, the owner stopping. */
const NOT_LOAD_FAILURES: ReadonlySet<string> = new Set(['MODEL_LOAD_CANCELLED', 'CORE_NOT_RUNNING'])

/**
 * `error` with the diag line appended to its details (replacing an earlier one) and `engineVersion`
 * added to its telemetry diagnostic. Anything that is not an `AtomicCoreError`, a cancel and a stop
 * are returned as they are.
 */
export function withLoadFailureDiag(error: unknown, diag: LoadDiag, engineVersion?: string): unknown {
  if (!(error instanceof AtomicCoreError) || NOT_LOAD_FAILURES.has(error.code)) return error
  const diagnostic = error.diagnostic
    ? { ...error.diagnostic, ...(engineVersion ? { engineVersion } : {}) }
    : engineVersion
      ? { component: 'runtime' as const, operation: 'load' as const, engineVersion }
      : undefined
  const wrapped = new AtomicCoreError(error.code, error.message, withLoadDiag(error.details, diag), {
    ...(diagnostic ? { diagnostic } : {}),
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  })
  if (error.stack) wrapped.stack = error.stack
  return wrapped
}

/** The diag line of one spawn attempt, from the error and what the runtime saw of the process. */
export function attemptLoadDiag(
  error: AtomicCoreError,
  facts: {
    platform: NodeJS.Platform
    backend: string
    version: string
    printed: boolean
    stderrPrinted: boolean
    weightsLoaded: boolean
    ready: boolean
  }
): LoadDiag {
  const exitCode = error.diagnostic?.exitCode
  const signal = error.diagnostic?.signal
  const exit = typeof exitCode === 'number' ? formatExitCode(exitCode, facts.platform) : undefined
  return {
    ...(exit !== undefined ? { exit_code: exit } : {}),
    ...(typeof signal === 'string' ? { signal } : {}),
    stage: loadFailureStage({ code: error.code, ...facts }),
    backend: facts.backend,
    // `cli` is the placeholder of an executable the CLI was pointed at, not a build tag.
    ...(facts.version && facts.version !== 'cli' ? { build: facts.version } : {}),
    ...(!facts.stderrPrinted ? { empty_stderr: true } : {}),
  }
}

/** What made a load try another build: the reason recorded against the build that failed. */
export type BackendFallbackTrigger =
  'GPU_BACKEND_INCOMPATIBLE' | 'ENGINE_BINARY_BROKEN' | 'EMPTY_STDERR_CRASH'

/** A build whose id names a GPU API; only these fall back on a broken binary or a silent crash. */
const GPU_BUILD = /cuda|vulkan|rocm|hip|sycl|opencl|musa|cann/i

/**
 * Whether a failed load may be retried once on the next installed build, and why: the build cannot
 * run on this card or driver; or, on a GPU build, Windows could not start it, or it died before
 * printing anything (an empty stderr: a missing DLL or an illegal instruction rather than the model).
 * Reads the diag line the attempt left in `details`.
 */
export function backendFallbackTrigger(error: unknown, backend: string): BackendFallbackTrigger | undefined {
  if (!(error instanceof AtomicCoreError)) return undefined
  if (error.code === 'GPU_BACKEND_INCOMPATIBLE') return 'GPU_BACKEND_INCOMPATIBLE'
  if (!GPU_BUILD.test(backend)) return undefined
  if (error.code === 'ENGINE_BINARY_BROKEN') return 'ENGINE_BINARY_BROKEN'
  if (error.code !== 'LLAMA_CPP_PROCESS_ERROR' && error.code !== 'CPU_INSTRUCTION_UNSUPPORTED')
    return undefined
  const diag = parseLoadDiag(error.details)
  const died =
    (diag?.exit_code !== undefined && diag.exit_code !== '0' && diag.exit_code !== '0x0') ||
    diag?.signal !== undefined
  return diag?.empty_stderr === true && died ? 'EMPTY_STDERR_CRASH' : undefined
}

/** The diag of the error a load ends with after a fallback, the fallback's own facts kept. */
export function withFallbackDiag(
  error: unknown,
  fallback: { from: string; to: string; ok: boolean }
): unknown {
  if (!(error instanceof AtomicCoreError) || NOT_LOAD_FAILURES.has(error.code)) return error
  const diag: LoadDiag = {
    ...(parseLoadDiag(error.details) ?? {}),
    fallback_from: fallback.from,
    fallback_to: fallback.to,
    fallback_ok: fallback.ok,
  }
  return withLoadFailureDiag(error, diag)
}
