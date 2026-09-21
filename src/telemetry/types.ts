import type { TelemetryState } from '../contracts/index.js'

export type ReportLevel = 'fatal' | 'error' | 'warning'

/** Where a report comes from; it becomes the `source` tag and the exception mechanism. */
export type ReportSource =
  | 'uncaught_exception'
  | 'unhandled_rejection'
  | 'startup'
  | 'control_route'
  | 'public_server'
  | 'event_listener'
  | 'backend_crash'
  | 'model_load'
  | 'diffusion_load'
  | 'diffusion_job'
  | 'inference'

/** One failure worth an issue, before scrubbing: what the rest of the core hands the reporter. */
export interface ErrorReport {
  source: ReportSource
  level: ReportLevel
  /** The thrown value: its type, headline and stack. */
  error?: unknown
  /** Exception type when nothing was thrown (an engine that exited). */
  type?: string
  /** Headline when nothing was thrown. */
  message?: string
  /** Explicit grouping; without it Sentry groups by stack. */
  fingerprint?: string[]
  tags?: Record<string, string | number | boolean | null | undefined>
  /** Free text attached after scrubbing, e.g. the engine's error lines. */
  extra?: Record<string, string>
  /** Repeats with the same key inside the window are dropped (a load crash-loop is one report). */
  throttle?: { key: string; windowMs: number }
}

/** What the core's services see of error reporting. No-ops when reporting is off. */
export interface ErrorSink {
  capture(report: ErrorReport): void
}

/** What the app changes over `PUT /atomic/v1/telemetry`; an omitted field keeps its value. */
export interface TelemetryUpdate {
  enabled?: boolean | undefined
  user_id?: string | null | undefined
  tags?: Record<string, unknown> | undefined
}

/** The reporter as the control API drives it: the sink, plus the app's consent, user and tags. */
export interface TelemetryControl extends ErrorSink {
  state(): TelemetryState
  update(update: TelemetryUpdate): void
}
