/**
 * `POST /responses` for Responses-only clients such as Codex CLI.
 *
 * Backends that serve the Responses API natively — MLX and remote providers — get a passthrough.
 * llama.cpp only speaks Chat Completions, so its requests are translated on the way in and its
 * answers (whole or streamed) on the way out.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`handle_responses_request`).
 */

import {
  ResponsesStreamConverter,
  chatResponseToResponses,
  newResponseId,
  responsesRequestToChat,
  serdeToString,
} from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'
import { resolveRemoteProvider } from '../../router/index.js'
import { answer, clientGone, connectTimeoutMs } from './exchange.js'
import type { Exchange } from './exchange.js'
import { outboundHeaders, readModelRequest, sseEvent } from './forward.js'
import type { Backend } from './forward.js'
import { SseLineReader } from './sse.js'
import { bodyIndicatesOom, isContextLimitError } from './errors.js'
import type { RequestTrace } from './trace.js'
import { pipeBody, readBody, readUpstreamText, relay, sendUpstream } from './wire.js'
import type { UpstreamResponse } from './wire.js'

export async function serveResponses(ex: Exchange): Promise<void> {
  const parsed = await readModelRequest(ex)
  if (!parsed) return
  const { raw, json, modelId, stream } = parsed

  const trace = ex.trace
  const remote = resolveRemoteProvider(modelId, ex.deps.providers())
  if (remote) {
    trace.backend = 'remote'
    trace.provider = remote.provider
    if (!remote.baseUrl) {
      trace.errorKind = 'proxy_internal'
      answer(ex, 500, 'Provider has no base_url')
      return
    }
    const url = `${remote.baseUrl.replace(/\/+$/, '')}/responses`
    await passthrough(ex, { kind: 'remote', provider: remote }, url, remote.apiKey ?? undefined, raw)
    return
  }

  // Unlike the chat routes, MLX is the passthrough here and llama.cpp is translated.
  const session =
    ex.deps.findLocal('llamacpp', modelId) ??
    ex.deps.findLocal('llamacpp-upstream', modelId) ??
    ex.deps.findLocal('mlx', modelId)
  if (!session) {
    trace.errorKind = 'not_found'
    answer(ex, 404, `No running session found for model '${modelId}'`)
    return
  }
  trace.backend = session.provider
  const backend: Backend = { kind: 'local', session }
  if (session.provider === 'mlx') {
    await passthrough(ex, backend, `http://127.0.0.1:${session.port}/v1/responses`, session.apiKey, raw)
    return
  }
  await translate(
    ex,
    `http://127.0.0.1:${session.port}/v1/chat/completions`,
    session.apiKey,
    json,
    modelId,
    stream
  )
}

async function passthrough(
  ex: Exchange,
  backend: Backend,
  url: string,
  key: string | undefined,
  raw: Buffer
): Promise<void> {
  const signal = clientGone(ex)
  let response: UpstreamResponse
  try {
    response = await sendUpstream(url, {
      method: 'POST',
      headers: outboundHeaders(
        ex,
        ['host', 'authorization', 'content-length', 'content-type'],
        backend,
        key,
        [['Content-Type', 'application/json']]
      ),
      body: raw,
      connectTimeoutMs: connectTimeoutMs(ex),
      signal,
    })
  } catch (e) {
    ex.trace.errorKind = ex.trace.backend === 'remote' ? 'remote_provider_error' : 'local_model_unreachable'
    if (!signal.aborted) answer(ex, 502, `Proxy request to model failed: ${(e as Error).message}`)
    return
  }
  await relay(ex.res, response, ex.cors)
}

/** Only the translated body and the session key go to llama.cpp; the client's headers do not. */
async function translate(
  ex: Exchange,
  url: string,
  key: string,
  json: JsonValue,
  modelId: string,
  stream: boolean
): Promise<void> {
  const signal = clientGone(ex)
  let response: UpstreamResponse
  try {
    response = await sendUpstream(url, {
      method: 'POST',
      headers: [
        ['Content-Type', 'application/json'],
        ['Accept-Encoding', 'identity'],
        ['Authorization', `Bearer ${key}`],
      ],
      body: serdeToString(responsesRequestToChat(json)),
      connectTimeoutMs: connectTimeoutMs(ex),
      signal,
    })
  } catch (e) {
    ex.trace.errorKind = ex.trace.backend === 'remote' ? 'remote_provider_error' : 'local_model_unreachable'
    if (!signal.aborted) answer(ex, 502, `Proxy request to model failed: ${(e as Error).message}`)
    return
  }

  if (response.status < 200 || response.status >= 300) {
    const errorBody = await readUpstreamText(response)
    ex.trace.errorKind = 'local_model_error'
    ex.trace.upstreamStatus = response.status
    ex.trace.oomDetected = bodyIndicatesOom(errorBody)
    ex.trace.ctxOverflowDetected = isContextLimitError(response.status, errorBody)
    answer(ex, response.status, errorBody)
    return
  }

  const responseId = newResponseId()
  if (!stream) {
    const bytes = await readBody(response.body).catch(() => Buffer.alloc(0))
    let chat: JsonValue = null
    try {
      chat = JSON.parse(bytes.toString('utf8')) as JsonValue
    } catch {
      chat = null
    }
    answer(ex, 200, serdeToString(chatResponseToResponses(chat, responseId, modelId)), [
      ['Content-Type', 'application/json'],
    ])
    return
  }

  ex.res.writeHead(
    200,
    [['Content-Type', 'text/event-stream'], ['Cache-Control', 'no-cache'], ...ex.cors].flat()
  )
  await pipeBody(ex.res, responsesEvents(response, responseId, modelId, ex.trace), () =>
    response.body.destroy()
  )
}

async function* responsesEvents(
  upstream: UpstreamResponse,
  responseId: string,
  modelId: string,
  trace: RequestTrace
): AsyncGenerator<string> {
  const telemetry = trace.startTelemetry()
  const conv = new ResponsesStreamConverter(responseId, modelId)
  yield sseEvent(conv.createdEvent())
  const reader = new SseLineReader()
  let usage: JsonValue | undefined
  for await (const chunk of upstream.body) {
    reader.push(chunk as Buffer)
    for (let line = reader.nextLine(); line; line = reader.nextLine()) {
      if (line.kind !== 'data') continue
      const payload = line.payload
      if (payload.kind === 'done') {
        for (const event of conv.finish(usage)) yield sseEvent(event)
        upstream.body.destroy()
        return
      }
      if (payload.kind === 'json') {
        const u =
          payload.json !== null && typeof payload.json === 'object' && !Array.isArray(payload.json)
            ? payload.json['usage']
            : undefined
        if (u !== undefined && u !== null) usage = u
        telemetry?.onJson(payload.json, performance.now())
        for (const event of conv.onChunk(payload.json)) yield sseEvent(event)
        trace.progress()
      }
    }
  }
  // The upstream closed without `[DONE]`: close the response anyway.
  for (const event of conv.finish(usage)) yield sseEvent(event)
}
