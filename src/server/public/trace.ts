/**
 * The record of one request as it goes through the Local API Server, and the `api:request` events
 * made from it: the analytics observation the app aggregates, and — only while the app's API screen
 * is open — the inspector's started / progress / finished view.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`EmitState`, `proxy_request`),
 * src-tauri/src/core/server/request_inspector.rs (`RequestInspector::begin`, `InspectorHandle`).
 *
 * The request is closed when its response closes, however that happens — the whole body sent, the
 * client gone, the upstream stalled — so there is no finish call to forget on an early return, which
 * is what the Rust `FinishGuard` exists to prevent.
 *
 * One deliberate difference: time to first token is measured from the moment the request arrived.
 * The Rust relay measured it from the start of the relay task in the finished event but from the
 * request's arrival in progress events, so the same request reported two different numbers.
 */

import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import type { ApiRequestFinishFields, ApiRequestObservation } from '../../contracts/index.js'
import type { JsonValue } from '../shims/index.js'
import { clientMaxTokens } from './errors.js'
import { promptPreview, StreamTelemetry } from './telemetry.js'
import type { TelemetryFields } from './telemetry.js'
import type { PublicServerDeps } from './types.js'

const PROGRESS_INTERVAL_MS = 1000
/** Above this many requests in flight progress events stop: the dashboard is saturated already. */
const PROGRESS_INFLIGHT_CEILING = 64

let nextSeq = 0
let inFlight = 0

export function endpointFromPath(path: string): string {
  switch (path) {
    case '/chat/completions':
      return 'chat/completions'
    case '/responses':
      return 'responses'
    case '/messages':
      return 'messages'
    case '/completions':
      return 'completions'
    case '/embeddings':
      return 'embeddings'
    case '/messages/count_tokens':
      return 'messages/count_tokens'
    case '/models':
      return 'models'
    case '/muse-code/models':
      return 'muse-code/models'
    case '/metrics':
      return 'metrics'
    default:
      return 'other'
  }
}

const now = () => performance.now()

export class RequestTrace {
  endpoint: string | undefined
  modelId: string | null = null
  backend = 'unknown'
  provider: string | null = null
  stream = false
  anthropicFallback = false
  errorKind: string | null = null
  /** Not product traffic (preflight, docs, model polling, scanners): no analytics, no inspector row. */
  skipEmit = false
  upstreamStatus: number | null = null
  oomDetected = false
  ctxOverflowDetected = false
  /** Streamed telemetry for the inspector, when a relay collected any. */
  telemetry: StreamTelemetry | undefined

  private readonly startedAt = now()
  private readonly startedAtMs = Date.now()
  private headersAt: number | undefined
  private readonly id = `apireq_${randomBytes(6).toString('hex')}`
  private readonly seq: number | undefined
  private announced = false
  private closed = false
  private lastProgress = 0
  private stashed: TelemetryFields | undefined

  constructor(
    private readonly method: string,
    private readonly deps: PublicServerDeps
  ) {
    // Watching is decided once, at arrival, as the app's inspector does: a request never switches
    // halfway between carrying previews and not.
    if (deps.emit && deps.inspecting?.()) {
      this.seq = nextSeq++
      inFlight++
    }
  }

  /** Whether the inspector is watching this request (previews and telemetry are collected). */
  get inspecting(): boolean {
    return this.seq !== undefined
  }

  /** Ties the trace to its response: headers time on `writeHead`, the finish on `close`. */
  attach(res: ServerResponse): void {
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse
    ;(res as unknown as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (
      ...args: unknown[]
    ) => {
      this.headersAt ??= now()
      return writeHead(...args)
    }
    res.once('close', () => this.close(res))
  }

  /**
   * The inspector's `request-started`, with the prompt preview when the body is known. Idempotent:
   * a body-parse site announces with detail, the close announces without for everything else.
   */
  announce(body?: JsonValue, raw?: Buffer): void {
    if (this.seq === undefined || this.announced) return
    this.announced = true
    const preview = body !== undefined ? promptPreview(body) : undefined
    this.deps.emit?.('api:request', {
      phase: 'started',
      id: this.id,
      seq: this.seq,
      started_at_ms: this.startedAtMs,
      endpoint: this.endpoint ?? 'other',
      method: this.method,
      model_id: this.modelId,
      stream: this.stream,
      message_count: preview?.message_count ?? null,
      prompt_preview: preview?.text ?? null,
      prompt_chars: preview?.chars ?? null,
      has_non_text_parts: preview?.has_non_text_parts ?? false,
      client_max_tokens: raw ? (clientMaxTokens(raw) ?? null) : null,
    })
  }

  /** A telemetry collector, when the inspector is watching. */
  startTelemetry(): StreamTelemetry | undefined {
    if (!this.inspecting) return undefined
    this.telemetry ??= new StreamTelemetry()
    return this.telemetry
  }

  /** Telemetry from a whole (non-streamed) response body: there is no time to first token. */
  stash(fields: TelemetryFields): void {
    this.stashed = { ...fields, ttft_ms: null }
  }

  /** A throttled progress tick for a long stream. */
  progress(): void {
    if (this.seq === undefined || this.closed || !this.telemetry) return
    if (inFlight > PROGRESS_INFLIGHT_CEILING) return
    const elapsed = Math.floor(now() - this.startedAt)
    if (elapsed - this.lastProgress < PROGRESS_INTERVAL_MS) return
    this.lastProgress = elapsed
    this.deps.emit?.('api:request', {
      phase: 'progress',
      id: this.id,
      seq: this.seq,
      ttft_ms: this.telemetry.ttftMs(this.startedAt),
      completion_tokens: this.telemetry.completionTokensOrEstimate(),
      reply_chars: this.telemetry.replyChars,
      elapsed_ms: elapsed,
    })
  }

  private close(res: ServerResponse): void {
    if (this.closed) return
    this.closed = true
    if (this.seq !== undefined) inFlight = Math.max(0, inFlight - 1)
    if (!this.deps.emit) return

    const end = now()
    const headers = this.headersAt ?? end
    const status = res.headersSent ? res.statusCode : 0
    if (!this.skipEmit) this.announce()

    const observation: ApiRequestObservation | null = this.skipEmit
      ? null
      : {
          endpoint: this.endpoint ?? 'other',
          method: this.method,
          model_id: this.modelId,
          backend: this.backend,
          provider: this.provider,
          stream: this.stream,
          status,
          latency_ms: Math.floor(headers - this.startedAt),
          is_anthropic_fallback: this.anthropicFallback,
          error_kind: this.errorKind,
          upstream_status: this.upstreamStatus,
          oom_detected: this.oomDetected,
          ctx_overflow_detected: this.ctxOverflowDetected,
        }

    let finish: ApiRequestFinishFields | null = null
    if (this.announced) {
      const telemetry = this.telemetry?.finishFields(this.startedAt) ?? this.stashed
      finish = {
        ttft_ms: null,
        prompt_tokens: null,
        completion_tokens: null,
        total_tokens: null,
        tokens_estimated: false,
        prompt_per_second: null,
        predicted_per_second: null,
        finish_reason: null,
        reply_preview: null,
        reply_chars: null,
        ...telemetry,
        status: status || null,
        error_kind: this.errorKind,
        aborted: !res.writableFinished,
        headers_ms: Math.floor(headers - this.startedAt),
        duration_ms: Math.floor(end - this.startedAt),
      }
    }
    if (!observation && !finish) return
    this.deps.emit('api:request', {
      phase: 'finished',
      id: this.id,
      seq: this.seq ?? -1,
      finished_at_ms: Date.now(),
      observation,
      finish,
    })
  }
}
