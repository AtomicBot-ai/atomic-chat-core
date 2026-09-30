/**
 * `POST /v1/systemone` and `POST /v1/router/score`: the decision model's own API, passed through to
 * the decision process byte for byte.
 *
 * Not through `serveForward`: that route needs a string `model` to pick a chat session, and the
 * decision API makes `model` optional. Not parsed and re-serialized either: JSON through JavaScript
 * loses `1.0` vs `1` (the engine renders them differently in the prompt), integers past 2^53, and the
 * order of number-like keys, and the engine's answer is only as calibrated as its input is exact. So
 * the request body goes out as the client sent it, with the process's own key instead of the client's,
 * and the engine's answer (its error envelope included) comes back unchanged.
 *
 * When the module cannot answer, the route says why in the engine's own envelope, with 503, so a
 * client handles one shape: `{"error": {"code", "type", "reason": "UNAVAILABLE", "message"}}`.
 */

import { answer, clientGone, connectTimeoutMs, header } from './exchange.js'
import type { Exchange } from './exchange.js'
import { relay, sendUpstream, UpstreamUnreachable } from './wire.js'

/** Public path (after the prefix) → the decision process's path. */
export const DECISION_ROUTES: Readonly<Record<string, string>> = {
  '/systemone': '/v1/systemone',
  '/router/score': '/v1/router/score',
}

/**
 * The public cap on a decision body. The engine refuses more than 1 MiB itself, with its own
 * `BODY_TOO_LARGE` envelope; up to this size the body is passed on so the client gets that answer.
 */
export const MAX_DECISION_BODY_BYTES = 8 * 1024 * 1024
/** How long a request waits for a module that is enabled but not running to start. */
export const DECISION_START_WAIT_MS = 30_000
export const DECISION_BACKEND_LABEL = 'atomic-decision'

const JSON_HEADERS: Array<[string, string]> = [['Content-Type', 'application/json']]

/** The engine's error envelope, for the answers the core writes itself. */
export function decisionErrorBody(status: number, reason: string, message: string, type: string): string {
  return JSON.stringify({ error: { code: status, type, reason, message } })
}

/** Read the body up to `limit`; past it, drain (so Bun delivers the refusal) and answer `undefined`. */
async function readCapped(ex: Exchange, limit: number): Promise<Buffer | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of ex.req) {
    const buf = chunk as Buffer
    size += buf.length
    if (size > limit) {
      chunks.length = 0
      if (size > limit * 8) {
        ex.req.destroy()
        break
      }
      continue
    }
    chunks.push(buf)
  }
  return size > limit ? undefined : Buffer.concat(chunks)
}

function unavailableAnswer(ex: Exchange, message: string): void {
  ex.trace.errorKind = 'local_model_unreachable'
  answer(ex, 503, decisionErrorBody(503, 'UNAVAILABLE', message, 'unavailable_error'), JSON_HEADERS)
}

export async function serveDecision(ex: Exchange, waitMs = DECISION_START_WAIT_MS): Promise<void> {
  const upstreamPath = DECISION_ROUTES[ex.path] as string
  ex.trace.backend = DECISION_BACKEND_LABEL
  const body = ex.body ?? (await readCapped(ex, MAX_DECISION_BODY_BYTES))
  if (body === undefined) {
    ex.trace.errorKind = 'bad_request'
    return answer(
      ex,
      413,
      decisionErrorBody(
        413,
        'BODY_TOO_LARGE',
        `The request body is over ${MAX_DECISION_BODY_BYTES} bytes.`,
        'invalid_request_error'
      ),
      JSON_HEADERS
    )
  }
  const backend = ex.deps.decision
  if (!backend) return unavailableAnswer(ex, 'The decision model is not available in this core.')
  // One signal for the whole exchange: a client that leaves while the module starts frees the handler.
  const gone = clientGone(ex)
  const target = await backend.acquire(waitMs, gone)
  if (!target.ok)
    return unavailableAnswer(ex, `The decision model is not available (${target.reason}). ${target.message}`)
  try {
    let upstream
    try {
      upstream = await sendUpstream(`http://127.0.0.1:${target.port}${upstreamPath}`, {
        method: 'POST',
        headers: [
          ['Content-Type', header(ex.req, 'content-type') ?? 'application/json'],
          ['Accept', 'application/json'],
          ['Authorization', `Bearer ${target.apiKey}`],
        ],
        body,
        connectTimeoutMs: connectTimeoutMs(ex),
        signal: gone,
      })
    } catch (error) {
      if (!(error instanceof UpstreamUnreachable)) throw error
      return unavailableAnswer(ex, `The decision model did not answer: ${error.message}`)
    }
    ex.trace.upstreamStatus = upstream.status
    if (upstream.status >= 400) ex.trace.errorKind = 'local_model_error'
    await relay(ex.res, upstream, ex.cors)
  } finally {
    target.release()
  }
}
