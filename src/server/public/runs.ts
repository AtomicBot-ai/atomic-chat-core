/**
 * Resumable streamed chat completions on the public listener (ADR
 * 2026-11-23-resumable-chat-completion-runs): a phone whose network changes mid-answer, or whose app
 * goes to the background, comes back and reads the rest instead of losing it.
 *
 * A streamed `/chat/completions` that sends `X-Atomic-Resumable: 1` becomes a run once the engine
 * starts answering: the engine is read into the run's buffer by a pump of its own, which no longer
 * stops when the client goes away, and the client is the run's first follower. Every event carries
 * `id: <seq>`, and the run id comes back in `X-Atomic-Run-Id`. `POST /atomic/runs/{id}/events` replays
 * what a client missed and follows the run to its end; `POST /atomic/runs/{id}/cancel` stops it.
 * Both are POST because the Cloudflare quick tunnel holds a streamed GET answer back until it ends.
 *
 * Before the engine answers, nothing is resumable yet: the client has no run id, so a client that
 * leaves then still stops the request, exactly as without the header.
 */

import type { ServerResponse } from 'node:http'
import { RESUMABLE_REQUEST_HEADER, RUN_ID_HEADER, RUNS_PATH } from '../../contracts/index.js'
import { structuredErrorJson } from './errors.js'
import { answer, clientGone, header } from './exchange.js'
import type { Exchange } from './exchange.js'
import { presentedKey } from './gates.js'
import type { ChatRun } from './run-registry.js'
import { SseEventFramer, SseLineReader } from './sse.js'
import type { FramedSse } from './sse.js'
import { isUsageOnlyChunk } from './telemetry.js'
import { STREAM_IDLE_TIMEOUT_MS, readBody, relayedHeaders, withIdleTimeout } from './wire.js'
import type { UpstreamResponse } from './wire.js'

const JSON_HEADERS: Array<[string, string]> = [['Content-Type', 'application/json']]
const RUN_ID_LOWER = RUN_ID_HEADER.toLowerCase()

/** The upstream of a request that may become a run: the client leaving aborts it until the run takes over. */
export interface PendingRun {
  /** For `sendUpstream`. */
  signal: AbortSignal
  /** From now on the client leaving no longer stops the upstream; only `abort` does. */
  detach: () => void
  abort: () => void
}

/**
 * A `PendingRun` when this request asked to be resumable and can be: a streamed `/chat/completions`
 * with `X-Atomic-Resumable: 1` on a listener that keeps runs. `undefined` otherwise, and the request
 * goes exactly as before.
 */
export function pendingRun(ex: Exchange, stream: boolean): PendingRun | undefined {
  if (!stream || ex.path !== '/chat/completions' || !ex.deps.runs) return undefined
  if (header(ex.req, RESUMABLE_REQUEST_HEADER)?.trim() !== '1') return undefined
  const controller = new AbortController()
  const gone = clientGone(ex)
  let detached = false
  gone.addEventListener('abort', () => {
    if (!detached) controller.abort()
  })
  return {
    signal: controller.signal,
    detach: () => {
      detached = true
    },
    abort: () => controller.abort(),
  }
}

/**
 * Answer the engine's successful response as a run: the run id and SSE headers, a pump that reads
 * the engine to its end whoever is listening, and the client as the run's first follower. `false`
 * when it cannot be one — the answer is not an event stream, or every run slot is still generating —
 * and nothing has been written: the caller relays it as a plain stream, and the client leaving still
 * stops it.
 */
export async function relayAsRun(
  ex: Exchange,
  upstream: UpstreamResponse,
  pending: PendingRun,
  stripUsageTrailer: boolean
): Promise<boolean> {
  if (!(upstream.contentType ?? '').startsWith('text/event-stream')) return false
  const run = ex.deps.runs?.create(presentedKey(ex.req, ex.config), () => {
    pending.abort()
    upstream.body.destroy()
  })
  if (!run) return false
  pending.detach()
  const relayed = relayedHeaders(upstream, ex.cors).filter(([name]) => name.toLowerCase() !== RUN_ID_LOWER)
  ex.res.writeHead(upstream.status, [...relayed, [RUN_ID_HEADER, run.id]].flat())
  // The run id is what makes the stream resumable: the client gets it now, not with the first token.
  ex.res.flushHeaders()
  void pump(ex, upstream, run, stripUsageTrailer)
  await follow(ex.res, run, 0, 0)
  return true
}

/**
 * Read the engine into the run until it ends, stalls past the idle timeout or is cancelled. Telemetry
 * is folded in as on a plain stream; the usage-only trailer the proxy asked for itself is dropped
 * before numbering, so no seq is spent on an event no client sees. Never rejects.
 */
async function pump(
  ex: Exchange,
  upstream: UpstreamResponse,
  run: ChatRun,
  stripUsageTrailer: boolean
): Promise<void> {
  const telemetry = ex.trace.startTelemetry()
  const reader = new SseLineReader()
  const framer = new SseEventFramer()
  const keep = (items: FramedSse[]) => {
    for (const item of items) {
      if (item.kind === 'event') run.appendEvent(item.bytes)
      else run.appendComment(item.bytes)
    }
  }
  try {
    for await (const chunk of withIdleTimeout(
      upstream.body as AsyncIterable<Buffer>,
      STREAM_IDLE_TIMEOUT_MS
    )) {
      reader.push(chunk)
      for (let line = reader.nextLine(); line; line = reader.nextLine()) {
        if (line.kind === 'data' && line.payload.kind === 'json') {
          telemetry?.onJson(line.payload.json, performance.now())
          if (stripUsageTrailer && isUsageOnlyChunk(line.payload.json)) continue
        }
        keep(framer.push(line.raw))
      }
      ex.trace.progress()
    }
    keep(framer.end(reader.takeTail()))
  } catch {
    // The engine failed or was cancelled mid-stream: the run ends with what arrived, as a stream would.
  } finally {
    upstream.body.destroy()
    run.finish()
  }
}

/** Resolves once `res` can take more, or has closed. */
function drained(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const resume = () => {
      res.off('drain', resume)
      res.off('close', resume)
      resolve()
    }
    res.once('drain', resume)
    res.once('close', resume)
  })
}

/**
 * Write the run to `res` from absolute index `cursor`, skipping events up to `after`, then follow it
 * live until it ends or the client goes. A follower that falls behind what the buffer keeps is ended
 * without `[DONE]`; its resume then learns the events are gone.
 */
async function follow(res: ServerResponse, run: ChatRun, cursor: number, after: number): Promise<void> {
  run.attach()
  let closed = res.destroyed
  const gone = new Promise<void>((resolve) =>
    res.once('close', () => {
      closed = true
      resolve()
    })
  )
  try {
    while (!closed) {
      const read = run.read(cursor, after)
      if (read.kind === 'gone') break
      cursor = read.next
      if (read.bytes.length > 0 && !res.write(Buffer.concat(read.bytes)) && !res.destroyed) await drained(res)
      if (closed || (run.finished && cursor >= run.end)) break
      if (cursor >= run.end) await Promise.race([run.changed(), gone])
    }
  } finally {
    run.detach()
    if (!closed) res.end()
  }
}

export type RunAction = 'events' | 'cancel'

const RUN_PATH = new RegExp(`^${RUNS_PATH}/([^/]+)/(events|cancel)$`)

/**
 * The run route a path names, if any: `/atomic/runs/{id}/events` or `/atomic/runs/{id}/cancel`. The
 * id is taken as written: a run id is base64url and never needs escaping, so an escaped one names no run.
 */
export function matchRunPath(path: string): { id: string; action: RunAction } | undefined {
  const m = RUN_PATH.exec(path)
  return m ? { id: m[1] as string, action: m[2] as RunAction } : undefined
}

/**
 * The client's cursor: `?after=<seq>`, else `Last-Event-ID`, else 0 (from the start). `undefined`
 * when the one given is not a non-negative integer.
 */
export function runCursor(query: string | undefined, lastEventId: string | undefined): number | undefined {
  const raw = new URLSearchParams(query ?? '').get('after') ?? lastEventId
  if (raw === undefined) return 0
  const text = raw.trim()
  return /^\d{1,15}$/.test(text) ? Number(text) : undefined
}

const notFound = (ex: Exchange) =>
  answer(
    ex,
    404,
    structuredErrorJson('No resumable run with this id.', 'invalid_request_error', 'run_not_found'),
    JSON_HEADERS
  )

/**
 * `POST /atomic/runs/{id}/events` and `POST /atomic/runs/{id}/cancel`. A run another credential
 * started answers the same 404 as one that never existed or has expired. Not reported: the request
 * that started the run already is.
 */
export async function serveRun(ex: Exchange, route: { id: string; action: RunAction }): Promise<void> {
  ex.trace.skipEmit = true
  if (ex.method !== 'POST') {
    answer(ex, 405, 'Method Not Allowed', [['Allow', 'POST']])
    return
  }
  // Read before answering: Bun loses an answer written while the body is still unread (ADR
  // 2026-09-22-detect-a-client-that-hangs-up-before-the-answer-under-bun). Whatever it holds is unused.
  try {
    await readBody(ex.req)
  } catch {
    answer(ex, 500, 'Failed to read request body')
    return
  }

  if (route.action === 'cancel') {
    const run = ex.deps.runs?.find(route.id, presentedKey(ex.req, ex.config))
    if (!run) return notFound(ex)
    run.cancel()
    ex.res.writeHead(204, ex.cors.flat())
    ex.res.end()
    return
  }

  const after = runCursor(ex.query, header(ex.req, 'last-event-id'))
  if (after === undefined) {
    answer(
      ex,
      400,
      structuredErrorJson(
        "'after' must be a non-negative integer: the seq of the last event received.",
        'invalid_request_error',
        'invalid_value',
        'after'
      ),
      JSON_HEADERS
    )
    return
  }
  const run = ex.deps.runs?.find(route.id, presentedKey(ex.req, ex.config))
  if (!run) return notFound(ex)
  const start = run.startIndex(after)
  if (start === 'gone') {
    answer(
      ex,
      410,
      structuredErrorJson(
        `The events after ${after} are no longer buffered. Send the request again.`,
        'invalid_request_error',
        'run_events_gone'
      ),
      JSON_HEADERS
    )
    return
  }
  ex.res.writeHead(
    200,
    [
      ['Content-Type', 'text/event-stream'],
      ['Cache-Control', 'no-cache'],
      [RUN_ID_HEADER, run.id],
      ...ex.cors,
    ].flat()
  )
  // A follower that has seen everything so far must not wait for the next event to hear it resumed.
  ex.res.flushHeaders()
  await follow(ex.res, run, start, after)
}
