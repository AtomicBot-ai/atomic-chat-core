import { diagnosticFingerprint, diagnosticTags, errorChain, reportDiagnostic } from './diagnostics.js'
import type { TelemetryConfig } from './config.js'
import type { ParsedDsn } from './dsn.js'
import { errorCodeOf, sanitizeTags } from './policy.js'
import type { ScrubContext } from './scrub.js'
import { parseStack } from './stack.js'
import type { StackFrame } from './stack.js'
import type { ErrorReport, ReportLevel } from './types.js'

export interface Breadcrumb {
  timestamp: number
  level: 'warning' | 'error'
  message: string
}

/** What the core finds out about the machine by itself (`node:os`), host or no host. */
export interface SystemContext {
  /** The kernel release (`os.release()`). */
  osRelease?: string | undefined
  cpuModel?: string | undefined
  memoryMb?: number | undefined
}

/** Everything about the process an event is stamped with. */
export interface EventContext {
  config: TelemetryConfig
  eventId: string
  /** Seconds since the epoch. */
  timestamp: number
  platform: NodeJS.Platform
  arch: string
  coreVersion: string
  ownerScope?: string | undefined
  /** Who embeds the core (`atomic-chat`, `cli`, `library`, …) and its version when it said. */
  host?: string | undefined
  hostVersion?: string | undefined
  /** The host's anonymous user id, else this data folder's install id: the only user identifier. */
  userId?: string | undefined
  /** Already sanitised tags from the host. They win over the core's own on the same key. */
  appTags: Record<string, string>
  /**
   * Tag keys a host sets on its own reports (`ErrorReporterOptions.hostTagKeys`). Their values are
   * scrubbed and capped like any tag and win over the diagnostic's; `component` and `operation` also
   * name the event and its grouping.
   */
  hostTagKeys?: ReadonlySet<string> | undefined
  system?: SystemContext | undefined
  breadcrumbs: readonly Breadcrumb[]
  scrub: ScrubContext
}

export interface SentryException {
  type: string
  value: string
  mechanism: { type: string; handled: boolean }
  stacktrace?: { frames: StackFrame[] }
}

export interface SentryEvent {
  event_id: string
  timestamp: number
  platform: 'node'
  level: ReportLevel
  logger: 'atomic-chat-core'
  release: string
  dist?: string
  environment: string
  sdk: { name: string; version: string }
  user: { id?: string; ip_address: null }
  contexts: { os: { name: string; version?: string }; device: { arch: string; memory_size?: number } }
  tags: Record<string, string>
  fingerprint: string[]
  exception: { values: SentryException[] }
  breadcrumbs?: { values: Array<Breadcrumb & { category: 'log' }> }
  extra?: Record<string, string>
}

// Free-form model IDs, request routes and log fields are not diagnostic facts.
const REPORT_TAG_KEYS = new Set([
  'source',
  'provider',
  'error_code',
  'http_status',
  'crash_kind',
  'exit_code',
  'signal',
  'backend',
  'oom_subtype',
  'quant',
  'context_length',
  'gpu_layers',
  'cache_type_k',
  'is_embedding',
  'failure_kind',
  'family',
  'engine',
])

const EXCEPTION_TYPES = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'URIError',
  'EvalError',
  'AggregateError',
  'DOMException',
  'AbortError',
  'SystemError',
  'AtomicCoreError',
])

function describeThrown(error: unknown): { type: string } {
  if (error instanceof Error) {
    const code = errorCodeOf(error)
    // A coded core error reads best as its code: "OUT_OF_MEMORY: Out of memory".
    const type =
      error.name === 'AtomicCoreError' && code ? code : EXCEPTION_TYPES.has(error.name) ? error.name : 'Error'
    return { type }
  }
  // Even a string may be a prompt or a request body. Never serialize thrown values.
  return { type: 'NonError' }
}

/**
 * The Sentry event for one report. Zero-PII by construction: no server name, no IP, no local
 * variables, no URL or body; every string passes the scrubber; tags are allow-listed and short.
 */
export function buildEvent(report: ErrorReport, ctx: EventContext): SentryEvent {
  const thrown =
    report.error !== undefined
      ? describeThrown(report.error)
      : {
          type:
            report.type && /^[A-Za-z][A-Za-z0-9_.]{0,63}$/.test(report.type) ? report.type : report.source,
        }
  const diagnostic = reportDiagnostic(report)
  const hostTags = ctx.hostTagKeys?.size
    ? sanitizeTags(report.tags, { allow: ctx.hostTagKeys, scrub: ctx.scrub })
    : {}
  // A host's own part of the program names the event; the core's vocabulary does not know it.
  const part = {
    ...diagnostic,
    component: hostTags['component'] ?? diagnostic.component,
    operation: hostTags['operation'] ?? diagnostic.operation,
  }
  const frames = report.error instanceof Error ? parseStack(report.error.stack, report.error.message) : []
  const tags = {
    ...sanitizeTags({
      core_version: ctx.coreVersion,
      arch: ctx.arch,
      owner_scope: ctx.ownerScope,
      host: ctx.host,
      host_version: ctx.hostVersion,
      cpu_model: ctx.system?.cpuModel,
      system_ram_mb: ctx.system?.memoryMb,
    }),
    ...ctx.appTags,
    ...sanitizeTags({ source: report.source, ...report.tags }, { allow: REPORT_TAG_KEYS, scrub: ctx.scrub }),
    ...sanitizeTags(diagnosticTags(report.error, diagnostic)),
    ...hostTags,
  }
  return {
    event_id: ctx.eventId,
    timestamp: ctx.timestamp,
    platform: 'node',
    level: report.level,
    logger: 'atomic-chat-core',
    release: ctx.config.release,
    ...(ctx.config.dist ? { dist: ctx.config.dist } : {}),
    environment: ctx.config.environment,
    sdk: { name: 'atomic-chat-core.telemetry', version: ctx.coreVersion },
    user: { ...(ctx.userId ? { id: ctx.userId } : {}), ip_address: null },
    contexts: {
      os: { name: ctx.platform, ...(ctx.system?.osRelease ? { version: ctx.system.osRelease } : {}) },
      device: {
        arch: ctx.arch,
        ...(ctx.system?.memoryMb ? { memory_size: ctx.system.memoryMb * 1024 * 1024 } : {}),
      },
    },
    tags,
    fingerprint: diagnosticFingerprint(report.error, part, String(report.tags?.['provider'] ?? '')),
    exception: {
      values: [
        ...errorChain(report.error)
          .slice(1)
          .reverse()
          .map((cause): SentryException => ({
            type: errorCodeOf(cause) ?? (EXCEPTION_TYPES.has(cause.name) ? cause.name : 'Error'),
            value: 'Underlying failure',
            mechanism: { type: 'cause', handled: report.level !== 'fatal' },
            stacktrace: { frames: parseStack(cause.stack, cause.message) },
          })),
        {
          type: thrown.type,
          value: `${part.component} ${part.operation}: ${diagnostic.reason}`,
          mechanism: { type: report.source, handled: report.level !== 'fatal' },
          ...(frames.length ? { stacktrace: { frames } } : {}),
        },
      ],
    },
  }
}

/** A single-event envelope: envelope header, item header, payload, newline-separated. */
export function buildEnvelope(event: SentryEvent, dsn: ParsedDsn, sentAt: Date): string {
  const header = JSON.stringify({ event_id: event.event_id, sent_at: sentAt.toISOString(), dsn: dsn.dsn })
  return `${header}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
}

/** The `X-Sentry-Auth` header of an envelope POST. */
export function authHeader(dsn: ParsedDsn, version: string): string {
  return `Sentry sentry_version=7, sentry_client=atomic-chat-core/${version}, sentry_key=${dsn.publicKey}`
}
