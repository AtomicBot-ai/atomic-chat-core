/**
 * The pure decisions of the managed-text load lifecycle (`lifecycle.ts`), kept apart from its I/O so
 * each one is a table: which readiness timeout applies, which stage a log tail puts a load in, which
 * error code an engine's exit becomes, whether a docker failure is the host-port bind race, and
 * whether `docker inspect` says the container has exited.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { ErrorCode } from '../../contracts/index.js'
import type { InspectResult } from '../container/index.js'
import type { EngineLoadStage, ManagedExitKind, ManagedStageMarker } from './adapter.js'

function assertPositiveMs(value: number, what: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `${what} must be a positive number of milliseconds.`,
      String(value)
    )
  }
  return value
}

/**
 * The readiness timeout for one load: the provider setting when there is one (spec
 * `tensorrt-llm-runtime`, "Этапы и таймаут загрузки" — the setting MUST override), otherwise what the
 * adapter computed from the weight size.
 */
export function resolveReadinessTimeoutMs(adapterMs: number, overrideMs?: number): number {
  if (overrideMs !== undefined) return assertPositiveMs(overrideMs, 'The load timeout override')
  return assertPositiveMs(adapterMs, 'The adapter readiness timeout')
}

const STAGE_ORDER: readonly EngineLoadStage[] = ['starting-container', 'initializing-engine']

/**
 * The stage a started container is in, given its log tail. An adapter with no markers has nothing to
 * refine `initializing-engine` with, so a started container is already there; with markers, the load
 * stays in `starting-container` until one shows up. A stage never moves backwards.
 */
export function advanceStage(
  current: EngineLoadStage,
  markers: readonly ManagedStageMarker[],
  logTail: string
): EngineLoadStage {
  if (markers.length === 0) return 'initializing-engine'
  let best = STAGE_ORDER.indexOf(current)
  for (const marker of markers) {
    const rank = STAGE_ORDER.indexOf(marker.stage)
    if (rank > best && marker.pattern.test(logTail)) best = rank
  }
  return STAGE_ORDER[best] as EngineLoadStage
}

const EXIT_CODES: Record<ManagedExitKind, ErrorCode> = {
  'out-of-memory': 'OUT_OF_MEMORY',
  'unsupported-model': 'MODEL_INCOMPATIBLE',
  'other': 'MODEL_LOAD_FAILED',
}

/** The error code a load fails with when its engine exits before readiness. */
export function exitErrorCode(kind: ManagedExitKind): ErrorCode {
  return EXIT_CODES[kind]
}

const PORT_CONFLICT = /port is already allocated|address already in use/i

/**
 * Whether a docker create/start failure is the host-port race: core picked a free port, and
 * something else bound it before Docker did. Only then is retrying with a new port the right answer.
 */
export function isPortBindConflict(error: unknown): boolean {
  if (!(error instanceof AtomicCoreError) || error.code !== 'IO_ERROR') return false
  return PORT_CONFLICT.test(`${error.message}\n${error.details ?? ''}`)
}

/** `docker inspect` `State.Status` values that mean the engine is gone for good (`--restart=no`). */
const EXITED_STATUSES = new Set(['exited', 'dead', 'removing'])

export interface ContainerState {
  exited: boolean
  exitCode: number | null
}

/**
 * Whether the container has exited. A container Docker no longer knows counts as exited. A shape
 * this does not recognise is not read as an exit: failing a healthy load on a misread would be worse
 * than waiting, and the readiness timeout still bounds the wait.
 */
export function readContainerState(inspected: InspectResult): ContainerState {
  if (!inspected.found) return { exited: true, exitCode: null }
  const state = (inspected.value as { State?: { Status?: unknown; ExitCode?: unknown } } | null)?.State
  const status = typeof state?.Status === 'string' ? state.Status : undefined
  if (status === undefined || !EXITED_STATUSES.has(status)) return { exited: false, exitCode: null }
  return { exited: true, exitCode: typeof state?.ExitCode === 'number' ? state.ExitCode : null }
}

const DOCKER_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}) /gm

/**
 * `containerLogs` asks Docker for `--timestamps` so it can merge stdout and stderr in order; the
 * tail a user reads, and the one an adapter classifies, is the engine's own text without them.
 */
export function stripDockerTimestamps(log: string): string {
  return log.replace(DOCKER_TIMESTAMP, '')
}
