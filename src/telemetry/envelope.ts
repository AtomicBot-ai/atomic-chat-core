import type { TelemetryConfig } from './config.js'
import type { ParsedDsn } from './dsn.js'
import { errorCodeOf, sanitizeTags } from './policy.js'
import { headline, scrubText } from './scrub.js'
import type { ScrubContext } from './scrub.js'
import { parseStack } from './stack.js'
import type { StackFrame } from './stack.js'
import type { ErrorReport, ReportLevel } from './types.js'

export interface Breadcrumb {
  timestamp: number
  level: 'warning' | 'error'
  message: string
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
  /** The app's anonymous device id (the PostHog distinct id), the only user identifier. */
  userId?: string | undefined
  /** Already sanitised tags from the app. */
  appTags: Record<string, string>
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
  contexts: { os: { name: string } }
  tags: Record<string, string>
  fingerprint?: string[]
  exception: { values: SentryException[] }
  breadcrumbs?: { values: Array<Breadcrumb & { category: 'log' }> }
  extra?: Record<string, string>
}

const MAX_EXTRA = 4096

function describeThrown(
  error: unknown,
  scrub: ScrubContext
): { type: string; value: string; stack?: string } {
  if (error instanceof Error) {
    const code = errorCodeOf(error)
    // A coded core error reads best as its code: "OUT_OF_MEMORY: Out of memory".
    const type = error.name === 'AtomicCoreError' && code ? code : error.name || 'Error'
    return {
      type,
      value: headline(scrubText(error.message, scrub)) || type,
      ...(error.stack ? { stack: error.stack } : {}),
    }
  }
  if (typeof error === 'string')
    return { type: 'NonError', value: headline(scrubText(error, scrub)) || 'NonError' }
  // Never stringify an arbitrary object: it may hold a request body.
  return { type: 'NonError', value: `A non-Error ${error === null ? 'null' : typeof error} was thrown` }
}

/**
 * The Sentry event for one report. Zero-PII by construction: no server name, no IP, no local
 * variables, no URL or body; every string passes the scrubber; tags are allow-listed and short.
 */
export function buildEvent(report: ErrorReport, ctx: EventContext): SentryEvent {
  const thrown =
    report.error !== undefined
      ? describeThrown(report.error, ctx.scrub)
      : {
          type: report.type ?? report.source,
          value: headline(scrubText(report.message ?? '', ctx.scrub)) || report.source,
        }
  const frames = 'stack' in thrown ? parseStack(thrown.stack) : []
  const tags = {
    ...sanitizeTags({ core_version: ctx.coreVersion, arch: ctx.arch, owner_scope: ctx.ownerScope }),
    ...ctx.appTags,
    ...sanitizeTags({ source: report.source, ...report.tags }, { scrub: ctx.scrub }),
  }
  const extra: Record<string, string> = {}
  for (const [key, value] of Object.entries(report.extra ?? {})) {
    extra[key] = scrubText(value, ctx.scrub).slice(0, MAX_EXTRA)
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
    contexts: { os: { name: ctx.platform } },
    tags,
    ...(report.fingerprint ? { fingerprint: report.fingerprint } : {}),
    exception: {
      values: [
        {
          type: thrown.type,
          value: thrown.value,
          mechanism: { type: report.source, handled: report.level !== 'fatal' },
          ...(frames.length ? { stacktrace: { frames } } : {}),
        },
      ],
    },
    ...(ctx.breadcrumbs.length
      ? { breadcrumbs: { values: ctx.breadcrumbs.map((b) => ({ ...b, category: 'log' as const })) } }
      : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
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
