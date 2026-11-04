import { errorChain } from './diagnostics.js'
import { randomUUID } from 'node:crypto'
import type { TelemetryConfig } from './config.js'
import { resolveConsent } from './consent.js'
import { authHeader, buildEnvelope, buildEvent } from './envelope.js'
import type { Breadcrumb, SentryEvent, SystemContext } from './envelope.js'
import { APP_TAG_KEYS, sanitizeTags } from './policy.js'
import { scrubText } from './scrub.js'
import type { ScrubContext } from './scrub.js'
import type { TelemetryState } from '../contracts/index.js'
import type { ErrorReport, TelemetryControl, TelemetryUpdate } from './types.js'

/** An identical event inside this window is one event (the app's `EVENT_DEDUP_WINDOW`). */
export const DEDUP_WINDOW_MS = 60_000
const HOUR_MS = 3_600_000
/** Reports per fingerprint per hour, and in total: a runaway loop must not drain the quota. */
export const PER_ISSUE_HOURLY_CAP = 5
export const TOTAL_HOURLY_CAP = 50
const MAX_BREADCRUMBS = 30
const SEND_TIMEOUT_MS = 5_000
const DEFAULT_RETRY_AFTER_S = 60

export interface ErrorReporterOptions {
  /** Null when this build or environment reports nowhere; consent is still tracked for the host. */
  config: TelemetryConfig | null
  coreVersion: string
  platform: NodeJS.Platform
  arch: string
  ownerScope?: 'app' | 'cli' | undefined
  /** Who embeds the core: `atomic-chat` (the app's daemon), `cli`, `library`, or a host's own name. */
  host?: string | undefined
  hostVersion?: string | undefined
  /** The host's consent at start-up (`daemon --telemetry on|off`, `AtomicCore.create`); later `update`s replace it. */
  enabled?: boolean | undefined
  /** What the environment says (`DO_NOT_TRACK`, `ATOMIC_CORE_TELEMETRY`), see `envConsent`. */
  envConsent?: boolean | undefined
  /** The user's stored choice (`atomic-chat-core telemetry on|off`). */
  storedConsent?: boolean | undefined
  /** The anonymous install id of this data folder: the user when no host names one. */
  installId?: string | undefined
  /** What the core knows of the machine by itself, so a report is useful without a host's tags. */
  system?: SystemContext | undefined
  scrub?: ScrubContext | undefined
  fetch?: typeof fetch | undefined
  now?: (() => number) | undefined
  newEventId?: (() => string) | undefined
  /** Where a failed send is mentioned; never back into the reporter. */
  onSendError?: ((message: string) => void) | undefined
  /**
   * Tag keys a host sets on the reports it captures itself (Atomic Server: `component`, `operation`,
   * its finite diagnostic codes). Only the core's diagnostic keys survive otherwise, and its
   * vocabulary has no word for a host's own parts. The host vouches that these values are finite; they
   * are still scrubbed and capped, and win over the core's diagnostic tags on the same key. The
   * core's own reporter passes none.
   */
  hostTagKeys?: readonly string[] | undefined
}

/**
 * Sends error reports to the core's Sentry project, by hand-built envelopes over `fetch` — no SDK:
 * `@sentry/node` needs loader hooks a single-file binary cannot offer, and the core adds no runtime
 * dependencies. Fire-and-forget: a reporting outage never reaches the caller. Nothing leaves without
 * consent; repeats are collapsed and a crash loop is capped.
 */
export class ErrorReporter implements TelemetryControl {
  private readonly options: ErrorReporterOptions
  private readonly fetchImpl: typeof fetch
  private readonly now: () => number
  private readonly newEventId: () => string
  private hostConsent: boolean | undefined
  private userId: string | undefined
  private appTags: Record<string, string> = {}
  private readonly hostTagKeys: ReadonlySet<string>
  private scrub: ScrubContext
  private readonly breadcrumbs: Breadcrumb[] = []
  private readonly throttled = new Map<string, number>()
  private readonly lastSeen = new Map<string, number>()
  private readonly perIssue = new Map<string, number[]>()
  private total: number[] = []
  private blockedUntil = 0
  private readonly reportedErrors = new WeakSet<Error>()
  private readonly pending = new Set<Promise<void>>()

  constructor(options: ErrorReporterOptions) {
    this.options = options
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init))
    this.now = options.now ?? Date.now
    this.newEventId = options.newEventId ?? (() => randomUUID().replace(/-/g, ''))
    this.hostConsent = options.enabled
    this.hostTagKeys = new Set(options.hostTagKeys ?? [])
    this.scrub = options.scrub ?? {}
  }

  private consent() {
    return resolveConsent({
      env: this.options.envConsent,
      host: this.hostConsent,
      stored: this.options.storedConsent,
    })
  }

  /** Apply what the host says: consent, its anonymous user id, its hardware tags. */
  update(update: TelemetryUpdate): void {
    if (update.enabled !== undefined) this.hostConsent = update.enabled
    if (update.user_id !== undefined) this.userId = update.user_id?.trim() || undefined
    if (update.tags !== undefined)
      this.appTags = sanitizeTags(update.tags, { allow: APP_TAG_KEYS, scrub: this.scrub })
  }

  setScrubContext(scrub: ScrubContext): void {
    this.scrub = scrub
  }

  state(): TelemetryState {
    const consent = this.consent()
    return {
      enabled: consent.enabled,
      reporting: consent.enabled && this.options.config !== null,
      has_user: this.userId !== undefined,
      tags: { ...this.appTags },
      source: consent.source,
      host: this.options.host ?? 'library',
    }
  }

  /** A warn/error log line: the trail an event carries. */
  breadcrumb(level: 'warning' | 'error', message: string): void {
    if (!this.options.config) return
    const text = scrubText(message.length > 300 ? `${message.slice(0, 299)}…` : message, this.scrub)
    this.breadcrumbs.push({ timestamp: this.now() / 1000, level, message: text })
    if (this.breadcrumbs.length > MAX_BREADCRUMBS) this.breadcrumbs.shift()
  }

  capture(report: ErrorReport): void {
    const config = this.options.config
    if (!config || !this.consent().enabled) return
    try {
      const chain = errorChain(report.error)
      if (chain.some((error) => this.reportedErrors.has(error))) return
      const now = this.now()
      const event = buildEvent(report, {
        config,
        eventId: this.newEventId(),
        timestamp: now / 1000,
        platform: this.options.platform,
        arch: this.options.arch,
        coreVersion: this.options.coreVersion,
        ownerScope: this.options.ownerScope,
        host: this.options.host ?? 'library',
        hostVersion: this.options.hostVersion,
        userId: this.userId ?? this.options.installId,
        system: this.options.system,
        appTags: this.appTags,
        hostTagKeys: this.hostTagKeys,
        breadcrumbs: [...this.breadcrumbs],
        scrub: this.scrub,
      })
      // The owning boundary consumes this failure even when rate limits suppress the send.
      // Otherwise its HTTP wrapper can bypass the cooldown under a different grouping key.
      for (const error of chain) this.reportedErrors.add(error)
      if (report.throttle && !this.admitThrottle(issueKey(event), report.throttle.windowMs, now)) return
      if (!this.admit(issueKey(event), now)) return
      this.send(event, config, now)
    } catch (error) {
      this.options.onSendError?.(
        `error report dropped: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** Wait for in-flight sends, at most `timeoutMs`. Never rejects. */
  async flush(timeoutMs = 2_000): Promise<void> {
    if (this.pending.size === 0) return
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })
    try {
      await Promise.race([Promise.allSettled([...this.pending]), timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  private admitThrottle(key: string, windowMs: number, now: number): boolean {
    for (const [k, at] of this.throttled) if (now - at >= windowMs) this.throttled.delete(k)
    if (this.throttled.has(key)) return false
    this.throttled.set(key, now)
    return true
  }

  /** Dedup, per-issue and total hourly caps, and the server's own rate limit. */
  private admit(key: string, now: number): boolean {
    if (now < this.blockedUntil) return false
    for (const [k, at] of this.lastSeen) if (now - at >= DEDUP_WINDOW_MS) this.lastSeen.delete(k)
    if (this.lastSeen.has(key)) return false
    this.total = this.total.filter((at) => now - at < HOUR_MS)
    if (this.total.length >= TOTAL_HOURLY_CAP) return false
    const recent = (this.perIssue.get(key) ?? []).filter((at) => now - at < HOUR_MS)
    if (recent.length >= PER_ISSUE_HOURLY_CAP) return false
    for (const [k, times] of this.perIssue)
      if (times.every((at) => now - at >= HOUR_MS)) this.perIssue.delete(k)
    this.lastSeen.set(key, now)
    this.perIssue.set(key, [...recent, now])
    this.total.push(now)
    return true
  }

  private send(event: SentryEvent, config: TelemetryConfig, now: number): void {
    const body = buildEnvelope(event, config.dsn, new Date(now))
    const request = this.fetchImpl(config.dsn.envelopeUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-sentry-envelope',
        'X-Sentry-Auth': authHeader(config.dsn, this.options.coreVersion),
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
      .then((response) => {
        if (response.status === 429) this.blockedUntil = this.now() + retryAfterMs(response.headers)
        else if (!response.ok) this.options.onSendError?.(`error report rejected: HTTP ${response.status}`)
      })
      .catch((error: unknown) => {
        this.options.onSendError?.(
          `error report not sent: ${error instanceof Error ? error.message : String(error)}`
        )
      })
      .finally(() => this.pending.delete(request))
    this.pending.add(request)
  }
}

/** What makes two events the same issue for dedup and caps. */
function issueKey(event: SentryEvent): string {
  return event.fingerprint.join('\u0000')
}

/**
 * How long Sentry asked us to stay quiet: the error category of `X-Sentry-Rate-Limits`
 * (`<seconds>:<categories>:<scope>, …`, an empty category list meaning all), else `Retry-After`.
 */
export function retryAfterMs(headers: Headers): number {
  const limits = headers.get('x-sentry-rate-limits')
  if (limits) {
    let seconds = 0
    for (const limit of limits.split(',')) {
      const [retry, categories = ''] = limit.trim().split(':')
      const applies = categories === '' || categories.split(';').includes('error')
      const value = Number(retry)
      if (applies && Number.isFinite(value)) seconds = Math.max(seconds, value)
    }
    if (seconds > 0) return seconds * 1000
  }
  const retryAfter = Number(headers.get('retry-after'))
  return (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : DEFAULT_RETRY_AFTER_S) * 1000
}
