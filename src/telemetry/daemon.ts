/**
 * The process-level side of error reporting for a core that owns its process — the app's daemon
 * and the CLI's: the `--telemetry` flag, and the handlers that report what nothing else caught.
 * A program that imports the library keeps its own process and gets none of this.
 */

import { inspect } from 'node:util'
import { processFailureReport } from './reports.js'
import type { ProcessFailureSource } from './reports.js'
import type { ErrorSink } from './types.js'

/**
 * `daemon --telemetry on|off`: the host's consent. Absent means the host said nothing, and the core
 * decides for itself (on, unless the environment or the user's stored choice says off).
 */
export function parseTelemetryFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined
  if (value === 'on') return true
  if (value === 'off') return false
  throw new Error(`--telemetry takes "on" or "off", not "${value}".`)
}

export interface FatalDeps {
  reporter: ErrorSink & { flush(timeoutMs?: number): Promise<void> }
  writeStderr: (text: string) => unknown
  exit: (code: number) => unknown
  flushTimeoutMs?: number
}

/**
 * The end of the daemon: say why on stderr (the app keeps it as `core-start.log`), report it, give the
 * report up to two seconds to leave, exit 1 — the exit code an uncaught throw has without handlers.
 */
export async function failFatally(
  source: ProcessFailureSource,
  error: unknown,
  deps: FatalDeps
): Promise<void> {
  try {
    deps.writeStderr(`${inspect(error)}\n`)
  } catch {
    // stderr is gone; the report is all that is left
  }
  const report = processFailureReport(source, error)
  if (report) {
    deps.reporter.capture(report)
    await deps.reporter.flush(deps.flushTimeoutMs ?? 2_000)
  }
  deps.exit(1)
}

export interface ProcessEvents {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (error: unknown) => void): unknown
}

/**
 * Report an uncaught exception or an unhandled rejection, then exit 1 either way. Without this a
 * capture-only rejection handler would leave Bun running (and exiting 0 later) where it died before.
 * A second failure while the first is being reported does not start another exit.
 */
export function installProcessHandlers(target: ProcessEvents, deps: FatalDeps): void {
  let failing = false
  const handle = (source: ProcessFailureSource) => (error: unknown) => {
    if (failing) return
    failing = true
    void failFatally(source, error, deps)
  }
  target.on('uncaughtException', handle('uncaught_exception'))
  target.on('unhandledRejection', handle('unhandled_rejection'))
}

/** `installProcessHandlers` for one process, given where its stderr goes and how it exits. */
export function processHandlersFor(
  target: ProcessEvents,
  writeStderr: (text: string) => unknown,
  exit: (code: number) => unknown
): (deps: Omit<FatalDeps, 'writeStderr' | 'exit'>) => void {
  return (deps) => installProcessHandlers(target, { ...deps, writeStderr, exit })
}

/** A core logger that also leaves its warn and error lines as the breadcrumbs of the next report. */
export function breadcrumbLogger(
  reporter: { breadcrumb(level: 'warning' | 'error', message: string): void },
  write: (level: 'info' | 'warn' | 'error', message: string) => void
): (level: 'info' | 'warn' | 'error', message: string) => void {
  return (level, message) => {
    write(level, message)
    if (level !== 'info') reporter.breadcrumb(level === 'warn' ? 'warning' : 'error', message)
  }
}
