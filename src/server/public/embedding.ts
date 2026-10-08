/**
 * `POST /v1/embeddings` for the embedding module's model
 * (ADR 2026-10-07-embedding-models-are-their-own-core-module).
 *
 * The route is shared: a request whose `model` names the module's model is served here, by the
 * module's own process; any other goes on to `serveForward` (cloud providers, then the loaded
 * sessions) exactly as before, with the body already read handed over in `ex.body`.
 *
 * A request served here is started for (an enabled module that is idle starts and is waited on), then
 * checked (`checkEmbeddingRequest`: no media links, no inline media the engine would fail to parse, no
 * media the model cannot read, no `dimensions` it does not produce) and passed through byte for byte
 * with the process's own key. The engine's answer, its error envelope included, comes back unchanged,
 * except its 500 for media it could not decode: that is the client's input, so it becomes a 400 naming
 * the field (`undecodableMediaVerdict`). The answers the core writes itself use the OpenAI error shape,
 * with `param` when a field is at fault, like the rest of `/v1`.
 */

import { checkEmbeddingRequest, undecodableMediaVerdict } from '../../embedding/index.js'
import type { EmbeddingBackend } from './types.js'
import { readCapped } from './decision.js'
import { structuredErrorJson } from './errors.js'
import { answer, clientGone, connectTimeoutMs, header } from './exchange.js'
import type { Exchange } from './exchange.js'
import { endpointFromPath } from './trace.js'
import {
  readUpstreamText,
  relay,
  relayedHeaders,
  sendUpstream,
  sendWhole,
  UpstreamUnreachable,
} from './wire.js'

/** Inline images and audio are base64: a few of them make a body far larger than a text one. */
export const MAX_EMBEDDING_BODY_BYTES = 64 * 1024 * 1024
/** How long a request waits for a module that is enabled but not running to start. */
export const EMBEDDING_START_WAIT_MS = 60_000
export const EMBEDDING_BACKEND_LABEL = 'atomic-embedding'
/** `owned_by` of the module's model in `/v1/models`. */
export const EMBEDDING_OWNED_BY = 'atomic-embedding'

const JSON_HEADERS: Array<[string, string]> = [['Content-Type', 'application/json']]

/** The `model` a body names, without failing on anything: a body this cannot read is not the module's. */
function modelOf(body: Buffer): { json: unknown; model: string | undefined } | undefined {
  try {
    const json: unknown = JSON.parse(body.toString('utf8'))
    const model =
      typeof json === 'object' && json !== null && !Array.isArray(json)
        ? (json as Record<string, unknown>)['model']
        : undefined
    return { json, model: typeof model === 'string' ? model : undefined }
  } catch {
    return undefined
  }
}

/**
 * Serve `ex` when its `model` is the embedding module's and answer `true`; otherwise answer `false`
 * with the body kept in `ex.body` for the next route. A body over the cap is refused here, whoever it
 * was for.
 */
export async function serveEmbeddingIfOwned(
  ex: Exchange,
  backend: EmbeddingBackend,
  waitMs = EMBEDDING_START_WAIT_MS
): Promise<boolean> {
  const modelId = backend.modelId()
  if (modelId === null) return false
  const body = ex.body ?? (await readCapped(ex, MAX_EMBEDDING_BODY_BYTES))
  if (body === undefined) {
    ex.trace.endpoint = endpointFromPath(ex.path)
    ex.trace.errorKind = 'bad_request'
    answer(
      ex,
      413,
      structuredErrorJson(
        `The request body is over ${MAX_EMBEDDING_BODY_BYTES} bytes.`,
        'invalid_request_error',
        'request_too_large'
      ),
      JSON_HEADERS
    )
    return true
  }
  ex.body = body
  const parsed = modelOf(body)
  if (parsed?.model !== modelId) return false

  const trace = ex.trace
  trace.endpoint = endpointFromPath(ex.path)
  trace.backend = EMBEDDING_BACKEND_LABEL
  trace.modelId = modelId
  const gone = clientGone(ex)
  const target = await backend.acquire(waitMs, gone)
  if (!target.ok) {
    trace.errorKind = 'local_model_unreachable'
    answer(ex, 503, structuredErrorJson(target.message, 'server_error', 'model_not_available'), JSON_HEADERS)
    return true
  }
  try {
    const verdict = checkEmbeddingRequest(parsed.json, target.modalities, target.dims)
    if (!verdict.ok) {
      trace.errorKind = 'bad_request'
      answer(
        ex,
        400,
        structuredErrorJson(verdict.message, 'invalid_request_error', 'invalid_value', verdict.param),
        JSON_HEADERS
      )
      return true
    }
    let upstream
    try {
      upstream = await sendUpstream(`http://127.0.0.1:${target.port}/v1/embeddings`, {
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
      trace.errorKind = 'local_model_unreachable'
      answer(
        ex,
        503,
        structuredErrorJson(
          `The embedding model did not answer: ${error.message}`,
          'server_error',
          'model_not_available'
        ),
        JSON_HEADERS
      )
      return true
    }
    trace.upstreamStatus = upstream.status
    if (upstream.status === 500) {
      // A 500 is read whole: the engine's word for media it could not decode makes it the client's error.
      const text = await readUpstreamText(upstream)
      const undecodable = undecodableMediaVerdict(upstream.status, text, parsed.json, target.modalities)
      if (undecodable !== undefined) {
        trace.errorKind = 'bad_request'
        answer(
          ex,
          400,
          structuredErrorJson(
            undecodable.message,
            'invalid_request_error',
            'invalid_value',
            undecodable.param
          ),
          JSON_HEADERS
        )
        return true
      }
      trace.errorKind = 'local_model_error'
      sendWhole(ex.res, upstream.status, relayedHeaders(upstream, ex.cors), text)
      return true
    }
    if (upstream.status >= 400) trace.errorKind = 'local_model_error'
    await relay(ex.res, upstream, ex.cors)
    return true
  } finally {
    target.release()
  }
}
