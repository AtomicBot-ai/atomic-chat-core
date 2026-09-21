/**
 * Error reporting for the app-owned daemon (`atomic-chat-app-core`): its reporter, and the
 * process-level handlers that report what nothing else caught. The CLI binary installs none of this.
 */

import { inspect } from 'node:util'
import { BAKED_TELEMETRY, resolveTelemetryConfig } from './config.js'
import type { BakedTelemetry } from './config.js'
import { ErrorReporter } from './reporter.js'
import { processFailureReport } from './reports.js'
import type { ProcessFailureSource } from './reports.js'
import type { ErrorSink } from './types.js'

/** `daemon --telemetry on|off`; absent means off, so an app that says nothing sends nothing. */
export function parseTelemetryFlag(value: string | undefined): boolean {
  if (value === undefined || value === 'off') return false
  if (value === 'on') return true
  throw new Error(`--telemetry takes "on" or "off", not "${value}".`)
}

export function createDaemonReporter(input: {
  enabled: boolean
  dataFolder: string
  homeDir: string
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch: string
  version: string
  warn: (message: string) => void
  baked?: BakedTelemetry
  fetch?: typeof fetch
}): ErrorReporter {
  return new ErrorReporter({
    config: resolveTelemetryConfig({
      baked: input.baked ?? BAKED_TELEMETRY,
      env: input.env,
      version: input.version,
    }),
    coreVersion: input.version,
    platform: input.platform,
    arch: input.arch,
    ownerScope: 'app',
    enabled: input.enabled,
    scrub: { dataFolder: input.dataFolder, homeDir: input.homeDir },
    fetch: input.fetch,
    onSendError: input.warn,
  })
}

export interface FatalDeps {
  reporter: ErrorSink & { flush(timeoutMs?: number): Promise<void> }
  writeStderr: (text: string) => void
  exit: (code: number) => void
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
