/**
 * The fail-open outcome of a decision call, from the module's state or the engine's answer. Pure.
 *
 * A call never throws into its caller: the chat path asks the router before it picks a model, and a
 * router that cannot answer must cost at most its budget, never the turn. Every way of not answering
 * becomes `{unavailable: true, reason}`, and the caller applies its default policy.
 */

import type {
  DecisionEngineError,
  DecisionOutcome,
  DecisionState,
  DecisionUnavailableReason,
  RouterScoreResponse,
  SystemoneResponse,
} from '../contracts/index.js'

export function unavailable<T>(
  reason: DecisionUnavailableReason,
  message: string,
  elapsedMs: number,
  extra: { status?: number; error?: DecisionEngineError } = {}
): DecisionOutcome<T> {
  return { unavailable: true, reason, message, elapsed_ms: elapsedMs, ...extra }
}

/** Why a call cannot even be sent in `state`; `undefined` when the process is ready. */
export function refusalForState(
  state: DecisionState,
  configured: boolean
): { reason: DecisionUnavailableReason; message: string } | undefined {
  switch (state) {
    case 'ready':
      return undefined
    case 'disabled':
      return { reason: 'disabled', message: 'The decision model is turned off.' }
    case 'unsupported':
      return { reason: 'unsupported', message: 'No installed engine build can run the decision model.' }
    case 'failed':
      return { reason: 'failed', message: 'The decision model failed to start; see its status.' }
    case 'starting':
    case 'restarting':
      return { reason: 'starting', message: 'The decision model is starting.' }
    case 'idle':
      return configured
        ? { reason: 'starting', message: 'The decision model was not running; it is being started.' }
        : { reason: 'not_configured', message: 'No decision model file is configured.' }
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** The engine's `{"error": {...}}`, or a synthetic one around a body that is not an envelope. */
export function engineErrorOf(status: number, text: string): DecisionEngineError {
  try {
    const body: unknown = JSON.parse(text)
    const error = isRecord(body) ? body['error'] : undefined
    if (isRecord(error) && typeof error['message'] === 'string') return error as DecisionEngineError
  } catch {
    // not JSON: fall through
  }
  return { code: status, message: text.slice(0, 500) || `HTTP ${status}` }
}

/**
 * An engine answer as an outcome. `check` says whether a parsed 200 body is the expected shape: a
 * 200 that is not JSON or not that shape is `invalid_response`, never a result the caller trusts.
 */
export function outcomeFromAnswer<T>(
  status: number,
  text: string,
  elapsedMs: number,
  check: (body: unknown) => body is T
): DecisionOutcome<T> {
  if (status === 200) {
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return unavailable(
        'invalid_response',
        'The decision model answered with something that is not JSON.',
        elapsedMs,
        {
          status,
        }
      )
    }
    if (!check(body))
      return unavailable(
        'invalid_response',
        'The decision model answered in an unexpected shape.',
        elapsedMs,
        {
          status,
        }
      )
    return { unavailable: false, result: body, elapsed_ms: elapsedMs }
  }
  const error = engineErrorOf(status, text)
  if (status === 429)
    return unavailable('overloaded', 'The decision model is busy; its queue is full.', elapsedMs, {
      status,
      error,
    })
  if (status === 503)
    return unavailable('not_running', 'The decision model is loading or stopping.', elapsedMs, {
      status,
      error,
    })
  // 501 is only ever `ROUTER_NOT_CALIBRATED` in DECISION.md; the reason is checked too, for a proxy
  // that rewrote the status.
  if (status === 501 || error.reason === 'ROUTER_NOT_CALIBRATED')
    return unavailable('not_calibrated', NOT_CALIBRATED_MESSAGE, elapsedMs, { status, error })
  return unavailable('rejected', `The decision model refused the request: ${error.message}`, elapsedMs, {
    status,
    error,
  })
}

export const NOT_CALIBRATED_MESSAGE =
  'The decision model has no router calibration, and allow_uncalibrated is off; the router cannot score.'

/** A `/v1/router/score` answer: `scores` is a list of objects with an `id` and a numeric `p_success`. */
export function isRouterScoreBody(body: unknown): body is RouterScoreResponse {
  if (!isRecord(body) || !Array.isArray(body['scores'])) return false
  return body['scores'].every(
    (s) => isRecord(s) && typeof s['id'] === 'string' && typeof s['p_success'] === 'number'
  )
}

/**
 * Whether a router answer scores exactly the candidates that were asked about, in their order. The
 * engine promises request order; a caller that zips scores with its candidates by index would credit
 * the wrong executor if an answer broke that, so such an answer is not trusted.
 */
export function scoresMatchCandidates(body: RouterScoreResponse, ids: readonly string[]): boolean {
  return body.scores.length === ids.length && body.scores.every((s, i) => s.id === ids[i])
}

/** A `/v1/systemone` answer: `answers` is an object of objects. */
export function isSystemoneBody(body: unknown): body is SystemoneResponse {
  return isRecord(body) && isRecord(body['answers']) && Object.values(body['answers']).every(isRecord)
}
