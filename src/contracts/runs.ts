/**
 * Resumable chat completions on the public listener (ADR 2026-11-23-resumable-chat-completion-runs):
 * the header a client sends to opt in, the header the run id comes back in, and the error codes of
 * the resume and cancel routes. A client that reads these strings (the phone app) matches them
 * verbatim, so they are a wire contract.
 *
 *   POST {prefix}/chat/completions        `stream: true` + `X-Atomic-Resumable: 1`
 *     → the usual SSE stream, `X-Atomic-Run-Id: <id>`, and `id: <seq>` on every event
 *   POST {prefix}/atomic/runs/{id}/events?after=<seq>   (or `Last-Event-ID: <seq>`)
 *     → the events after `seq`, then the live ones until the run ends
 *   POST {prefix}/atomic/runs/{id}/cancel → 204
 */

/** Request header that opts a streamed `/chat/completions` request into a resumable run; value `1`. */
export const RESUMABLE_REQUEST_HEADER = 'X-Atomic-Resumable'

/** Response header carrying the run id; absent when the request did not become a resumable run. */
export const RUN_ID_HEADER = 'X-Atomic-Run-Id'

/** The path, after the listener's prefix, under which a run is resumed and cancelled. */
export const RUNS_PATH = '/atomic/runs'

/**
 * `error.code` of the resume and cancel routes' failures, in the OpenAI error envelope:
 * - `run_not_found` (404): no such run, it expired, or another credential started it — one answer
 *   for all three, so the route says nothing about runs a client may not read;
 * - `run_events_gone` (410): the run exists but the events after the client's cursor are no longer
 *   buffered; the client sends its original request again;
 * - `invalid_value` (400): `after` (or `Last-Event-ID`) is not a non-negative integer.
 */
export const RUN_ERROR_CODES = ['run_not_found', 'run_events_gone', 'invalid_value'] as const
export type RunErrorCode = (typeof RUN_ERROR_CODES)[number]
