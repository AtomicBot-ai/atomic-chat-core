/**
 * The model-bearing POST routes: `/chat/completions`, `/completions`, `/embeddings`,
 * `/messages/count_tokens` and Anthropic `/messages`. Picks the backend from the body's `model`,
 * forwards the request, and handles what can go wrong on the way back.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`inner_proxy_request` from the model lookup to
 * the end, `retry_local_upstream`, `transform_and_forward_stream`, `forward_non_streaming`).
 *
 * The recovery paths, in the order they are tried:
 * - `/messages` that the engine rejects is retried as `/chat/completions` and the answer translated
 *   back, because most local engines do not speak the Anthropic API;
 * - a local context overflow asks the runtime for a larger context and replays the request once;
 * - a poisoned compute backend (a Metal OOM) gets a same-context reload and a clear, non-retryable
 *   400 — replaying the request would only poison the fresh backend again;
 * - a non-streamed 200 cut off by the context window (`finish_reason: length` with no client cap)
 *   is grown and replayed like an overflow;
 * - a local engine's unstructured error is wrapped in an OpenAI error envelope.
 *
 * One deliberate difference from the Rust: a remote provider's configured custom headers are sent.
 * The app stored them but the proxy never applied them (recorded as `known_divergence` in the
 * proxy-http fixtures).
 */

import {
  AnthropicStreamConverter,
  anthropicRequestToChat,
  chatResponseToAnthropic,
  isJsonObject,
  serdeToString,
} from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'
import { LOCAL_SEARCH_ORDER, resolveRemoteProvider } from '../../router/index.js'
import type { LocalProvider, RemoteProvider } from '../../router/index.js'
import { autoIncreaseCtx } from './ctx.js'
import { SseLineReader } from './sse.js'
import { StreamTelemetry, isUsageOnlyChunk, maybeInjectStreamUsage } from './telemetry.js'
import { endpointFromPath } from './trace.js'
import {
  bodyIndicatesOom,
  computeErrorEnvelope,
  isComputeBackendError,
  isContextLimitError,
  isContextOverflowFinishLength,
  structureBackendErrorBody,
  structuredErrorJson,
} from './errors.js'
import { answer, clientGone, connectTimeoutMs, invalidJsonMessage } from './exchange.js'
import type { Exchange } from './exchange.js'
import type { LocalTarget } from './types.js'
import {
  forwardableHeaders,
  pipeBody,
  readBody,
  readUpstreamText,
  relay,
  relayedHeaders,
  sendUpstream,
} from './wire.js'
import type { HeaderPairs, UpstreamResponse } from './wire.js'

export type Backend = { kind: 'remote'; provider: RemoteProvider } | { kind: 'local'; session: LocalTarget }

/** The first local session serving `modelId`, in the proxy's provider order. */
export function findLocalSession(ex: Exchange, modelId: string): LocalTarget | undefined {
  for (const provider of LOCAL_SEARCH_ORDER) {
    const session = ex.deps.findLocal(provider, modelId)
    if (session) return session
  }
  return undefined
}

/** The request body parsed, with the `model` it names; `undefined` once an error has been answered. */
export async function readModelRequest(
  ex: Exchange
): Promise<{ raw: Buffer; json: JsonValue; modelId: string; stream: boolean } | undefined> {
  const trace = ex.trace
  trace.endpoint = endpointFromPath(ex.path)
  let raw: Buffer
  try {
    raw = ex.body ?? (await readBody(ex.req))
  } catch {
    trace.errorKind = 'bad_request'
    answer(ex, 500, 'Failed to read request body')
    return undefined
  }
  let json: JsonValue
  try {
    json = JSON.parse(raw.toString('utf8')) as JsonValue
  } catch (e) {
    trace.errorKind = 'bad_request'
    answer(ex, 400, invalidJsonMessage(e))
    return undefined
  }
  const model = isJsonObject(json) ? json['model'] : undefined
  const stream = isJsonObject(json) && json['stream'] === true
  trace.stream = stream
  trace.modelId = typeof model === 'string' ? model : null
  trace.announce(json, raw)
  if (typeof model !== 'string') {
    trace.errorKind = 'bad_request'
    answer(ex, 400, "Request body must contain a 'model' field")
    return undefined
  }
  return { raw, json, modelId: model, stream }
}

/**
 * Headers for a request to a remote provider or a local engine: the client's own minus `exclude`,
 * then the provider's custom headers (replacing a client header of the same name), then the bearer.
 * `key === undefined` sends no `Authorization` at all; a local session always has a key, even an
 * empty one, and the proxy sends it as-is.
 */
export function outboundHeaders(
  ex: Exchange,
  exclude: readonly string[],
  backend: Backend,
  key: string | undefined,
  leading: HeaderPairs = []
): HeaderPairs {
  let headers: HeaderPairs = [...leading, ...forwardableHeaders(ex.req, exclude)]
  if (backend.kind === 'remote') {
    for (const { header, value } of backend.provider.customHeaders) {
      const lower = header.toLowerCase()
      headers = headers.filter(([name]) => name.toLowerCase() !== lower)
      headers.push([header, value])
    }
  }
  if (key !== undefined) {
    headers = headers.filter(([name]) => name.toLowerCase() !== 'authorization')
    headers.push(['Authorization', `Bearer ${key}`])
  }
  return headers
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300
}

/** One SSE frame named after the event's `type`, as the proxy writes Anthropic events. */
export function sseEvent(event: JsonValue): string {
  const type = isJsonObject(event) && typeof event['type'] === 'string' ? event['type'] : 'message'
  return `event: ${type}\ndata: ${serdeToString(event)}\n\n`
}

export async function serveForward(ex: Exchange): Promise<void> {
  const isMessages = ex.path === '/messages'
  const parsed = await readModelRequest(ex)
  if (!parsed) return
  const { raw, json, modelId, stream } = parsed

  let backend: Backend
  let url: string | undefined
  let key: string | undefined
  const remote = resolveRemoteProvider(modelId, ex.deps.providers())
  const trace = ex.trace
  if (remote) {
    backend = { kind: 'remote', provider: remote }
    trace.backend = 'remote'
    trace.provider = remote.provider
    key = remote.apiKey ?? undefined
    if (remote.baseUrl) {
      url = isMessages ? `${remote.baseUrl.replace(/\/+$/, '')}/messages` : `${remote.baseUrl}${ex.path}`
    }
  } else {
    // "Nothing is loaded" (503) and "that model is not loaded" (404) are told apart so a client can
    // tell a cold server from a typo. `/messages` has always answered 404 for both.
    if (!isMessages && ex.deps.listLocal().length === 0) {
      trace.errorKind = 'not_found'
      answer(ex, 503, 'No models are available')
      return
    }
    const session = findLocalSession(ex, modelId)
    if (!session) {
      trace.errorKind = 'not_found'
      answer(ex, 404, `No running session found for model '${modelId}'`)
      return
    }
    backend = { kind: 'local', session }
    trace.backend = session.provider
    key = session.apiKey
    url = `http://127.0.0.1:${session.port}/v1${ex.path}`
  }
  if (url === undefined) {
    trace.errorKind = 'proxy_internal'
    answer(ex, 500, 'Internal routing error')
    return
  }

  // While the inspector watches, a local streaming chat is asked for real token counts. Only local
  // backends: a remote provider that rejects unknown fields would turn diagnostics into an outage.
  const injected =
    trace.inspecting && stream && ex.path === '/chat/completions' && backend.kind === 'local'
      ? maybeInjectStreamUsage(raw)
      : undefined

  const signal = clientGone(ex)
  let response: UpstreamResponse
  try {
    response = await sendUpstream(url, {
      method: ex.method,
      headers: outboundHeaders(ex, ['host', 'authorization'], backend, key),
      body: injected ?? raw,
      connectTimeoutMs: connectTimeoutMs(ex),
      signal,
    })
  } catch (e) {
    if (signal.aborted) return
    answerUnreachable(ex, backend, e as Error)
    return
  }

  if (!isSuccess(response.status)) {
    if (isMessages) await messagesFallback(ex, backend, url, key, json, response)
    else await upstreamError(ex, backend, modelId, raw, response)
    return
  }

  if (!stream && backend.kind === 'local') {
    await inspectFinish(ex, backend.session, modelId, raw, response)
    return
  }
  await relayObserved(ex, response, injected !== undefined)
}

/** The largest non-SSE body kept for telemetry: a chat completion envelope, not an arbitrary file. */
const NON_SSE_CAPTURE_LIMIT = 256 * 1024

/**
 * Relay the upstream answer; while the inspector watches, fold what streams past into telemetry and
 * drop the usage-only trailer this proxy asked for itself — the client never opted into an extra chunk
 * with empty `choices`, and some clients throw on one. The bytes otherwise pass unchanged.
 */
async function relayObserved(
  ex: Exchange,
  upstream: UpstreamResponse,
  stripUsageTrailer: boolean
): Promise<void> {
  const telemetry = ex.trace.startTelemetry()
  if (!telemetry) return relay(ex.res, upstream, ex.cors)
  const trace = ex.trace
  const sse = (upstream.contentType ?? '').startsWith('text/event-stream')
  ex.res.writeHead(upstream.status, relayedHeaders(upstream, ex.cors).flat())

  async function* observed(): AsyncGenerator<Buffer> {
    const reader = new SseLineReader()
    let captured = 0
    let droppingTrailer = false
    for await (const chunk of upstream.body as AsyncIterable<Buffer>) {
      if (!sse) {
        if (captured < NON_SSE_CAPTURE_LIMIT) {
          const take = chunk.subarray(0, NON_SSE_CAPTURE_LIMIT - captured)
          reader.push(take)
          captured += take.length
        }
        yield chunk
        continue
      }
      reader.push(chunk)
      const forward: Buffer[] = []
      for (let line = reader.nextLine(); line; line = reader.nextLine()) {
        if (line.kind === 'data' && line.payload.kind === 'json') {
          telemetry?.onJson(line.payload.json, performance.now())
          if (stripUsageTrailer && isUsageOnlyChunk(line.payload.json)) {
            droppingTrailer = true
            continue
          }
        }
        if (droppingTrailer) {
          droppingTrailer = false
          // Also swallow the blank line that ended the dropped event.
          if (line.kind === 'other' && line.raw.toString('utf8').trim() === '') continue
        }
        forward.push(line.raw)
      }
      if (forward.length > 0) yield Buffer.concat(forward)
      trace.progress()
    }
    const tail = reader.takeTail()
    if (tail.length === 0) return
    if (sse) {
      yield tail
    } else {
      try {
        // Non-SSE: the buffer holds the whole document, which has no time to first token.
        telemetry?.onJson(JSON.parse(tail.toString('utf8')) as JsonValue, performance.now())
        if (telemetry) telemetry.firstContentAt = undefined
      } catch {
        // not a JSON document
      }
    }
  }
  await pipeBody(ex.res, observed(), () => upstream.body.destroy())
}

/**
 * A local engine that cannot be reached is down, crashed or still starting: 503 with `Retry-After`,
 * which clients treat as transient. A remote one that cannot be reached is a real gateway failure.
 */
function answerUnreachable(ex: Exchange, backend: Backend, e: Error): void {
  const local = backend.kind === 'local'
  ex.trace.errorKind = local ? 'local_model_unreachable' : 'remote_provider_error'
  const body = structuredErrorJson(
    `The model backend is not reachable: ${e.message}`,
    'server_error',
    local ? 'backend_unavailable' : 'upstream_unreachable'
  )
  const extra: HeaderPairs = [['Content-Type', 'application/json']]
  if (local) extra.push(['Retry-After', '1'])
  answer(ex, local ? 503 : 502, body, extra)
}

/** Replay a request against a reloaded local session; the bearer is omitted when the key is empty. */
async function retryLocal(
  ex: Exchange,
  port: number,
  apiKey: string,
  raw: Buffer
): Promise<UpstreamResponse | undefined> {
  const headers = forwardableHeaders(ex.req, ['host', 'authorization'])
  if (apiKey) headers.push(['Authorization', `Bearer ${apiKey}`])
  try {
    const retry = await sendUpstream(`http://127.0.0.1:${port}/v1${ex.path}`, {
      method: ex.method,
      headers,
      body: raw,
      connectTimeoutMs: connectTimeoutMs(ex),
      signal: clientGone(ex),
    })
    if (isSuccess(retry.status)) return retry
    retry.body.resume()
  } catch {
    // The original error is what the client gets.
  }
  return undefined
}

async function growAndRetry(
  ex: Exchange,
  provider: LocalProvider,
  modelId: string,
  raw: Buffer,
  trigger: 'error' | 'finish_length'
): Promise<boolean> {
  const reloaded = await autoIncreaseCtx(ex.deps, provider, modelId, trigger)
  if (!reloaded) return false
  const retry = await retryLocal(ex, reloaded.port, reloaded.apiKey, raw)
  if (!retry) return false
  await relay(ex.res, retry, ex.cors)
  return true
}

async function upstreamError(
  ex: Exchange,
  backend: Backend,
  modelId: string,
  raw: Buffer,
  response: UpstreamResponse
): Promise<void> {
  const errorBody = await readUpstreamText(response)
  const status = response.status
  const trace = ex.trace
  const recordFailure = () => {
    trace.errorKind = backend.kind === 'local' ? 'local_model_error' : 'remote_provider_error'
    trace.upstreamStatus = status
    trace.oomDetected = bodyIndicatesOom(errorBody)
    trace.ctxOverflowDetected = isContextLimitError(status, errorBody)
  }

  if (backend.kind === 'local') {
    const provider = backend.session.provider
    if (isContextLimitError(status, errorBody) && (await growAndRetry(ex, provider, modelId, raw, 'error')))
      return

    if (isComputeBackendError(status, errorBody)) {
      // Only the llama.cpp upstream runtime understands a same-context reload; the others would
      // read the request as "grow the context". The outcome does not change this answer.
      if (provider === 'llamacpp-upstream') {
        await autoIncreaseCtx(ex.deps, provider, modelId, 'compute_error_recovery')
      }
      recordFailure()
      trace.oomDetected = true
      trace.ctxOverflowDetected = false
      answer(ex, 400, computeErrorEnvelope(bodyIndicatesOom(errorBody)))
      return
    }

    recordFailure()
    answer(ex, status, structureBackendErrorBody(errorBody, trace.oomDetected, trace.ctxOverflowDetected))
    return
  }
  // Remote providers already answer with their own structured errors.
  recordFailure()
  answer(ex, status, errorBody)
}

/**
 * A non-streamed local answer is read whole so a context-window cut-off can be caught and replayed.
 * The upstream's headers are consumed with it; the client gets the minimal set for a JSON reply.
 */
async function inspectFinish(
  ex: Exchange,
  session: LocalTarget,
  modelId: string,
  raw: Buffer,
  response: UpstreamResponse
): Promise<void> {
  const bytes = await readBody(response.body).catch(() => Buffer.alloc(0))
  let parsed: JsonValue | undefined
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as JsonValue
  } catch {
    parsed = undefined
  }
  if (parsed !== undefined && ex.trace.inspecting) {
    const telemetry = new StreamTelemetry()
    telemetry.onJson(parsed, performance.now())
    ex.trace.stash(telemetry.finishFields(0))
  }
  if (
    parsed !== undefined &&
    isContextOverflowFinishLength(parsed, raw) &&
    (await growAndRetry(ex, session.provider, modelId, raw, 'finish_length'))
  ) {
    return
  }
  answer(ex, response.status, bytes, [['Content-Type', 'application/json']])
}

/**
 * `/messages` was rejected: retry it as Chat Completions at the same base and translate the answer
 * back into Anthropic's shape. If the fallback cannot be attempted or cannot be reached, the client
 * gets the original error; if it answers with an error, the client gets that one.
 */
async function messagesFallback(
  ex: Exchange,
  backend: Backend,
  url: string,
  key: string | undefined,
  json: JsonValue,
  response: UpstreamResponse
): Promise<void> {
  const errorBody = await readUpstreamText(response)
  const trace = ex.trace
  trace.anthropicFallback = true
  const errorKind = backend.kind === 'local' ? 'local_model_error' : 'remote_provider_error'
  const chat = anthropicRequestToChat(json)
  if (chat !== null) {
    let base = url
    while (base.endsWith('/messages')) base = base.slice(0, -'/messages'.length)
    base = base.replace(/\/+$/, '')
    const signal = clientGone(ex)
    try {
      const fallback = await sendUpstream(`${base}/chat/completions`, {
        method: 'POST',
        headers: outboundHeaders(
          ex,
          ['host', 'authorization', 'content-type', 'content-length', 'accept-encoding'],
          backend,
          key,
          [
            ['Content-Type', 'application/json'],
            ['Accept-Encoding', 'identity'],
          ]
        ),
        body: serdeToString(chat),
        connectTimeoutMs: connectTimeoutMs(ex),
        signal,
      })
      if (!isSuccess(fallback.status)) {
        const fallbackError = await readUpstreamText(fallback)
        trace.errorKind = errorKind
        trace.upstreamStatus = fallback.status
        trace.oomDetected = bodyIndicatesOom(fallbackError)
        trace.ctxOverflowDetected = isContextLimitError(fallback.status, fallbackError)
        answer(ex, fallback.status, fallbackError)
        return
      }
      ex.res.writeHead(fallback.status, relayedHeaders(fallback, ex.cors).flat())
      const streaming = isJsonObject(chat) && chat['stream'] === true
      await pipeBody(ex.res, streaming ? anthropicStream(fallback) : anthropicWhole(fallback), () =>
        fallback.body.destroy()
      )
      return
    } catch {
      if (signal.aborted) return
    }
  }
  trace.errorKind = errorKind
  trace.upstreamStatus = response.status
  trace.oomDetected = bodyIndicatesOom(errorBody)
  trace.ctxOverflowDetected = isContextLimitError(response.status, errorBody)
  answer(ex, response.status, errorBody)
}

async function* anthropicStream(upstream: UpstreamResponse): AsyncGenerator<string> {
  const conv = new AnthropicStreamConverter()
  const decoder = new TextDecoder()
  for await (const chunk of upstream.body) {
    for (const event of conv.onNetworkChunk(decoder.decode(chunk as Buffer, { stream: true })))
      yield sseEvent(event)
    if (conv.done) {
      upstream.body.destroy()
      return
    }
  }
  const tail = decoder.decode()
  for (const event of [...conv.onNetworkChunk(tail), ...conv.finish()]) yield sseEvent(event)
}

async function* anthropicWhole(upstream: UpstreamResponse): AsyncGenerator<Buffer | string> {
  const bytes = await readBody(upstream.body)
  let parsed: JsonValue
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as JsonValue
  } catch {
    yield bytes
    return
  }
  yield serdeToString(chatResponseToAnthropic(parsed))
}
