/**
 * Serving a ChatGPT subscription: the `/chat/completions` branch for models registered under the
 * `chatgpt` provider, and the subscription's model list.
 *
 * Ported from: src-tauri/src/core/server/chatgpt_route.rs, proxy.rs (`try_serve_chatgpt`).
 * Contract: test/fixtures/app/chatgpt-route (upstream request, model normalisation); the response
 * side is `ChatChunkStreamConverter`, pinned by the chat-to-responses-shim set.
 *
 * The request is built from scratch rather than forwarded: this endpoint is particular about what
 * it receives, and the bearer must be the subscription's, never the client's.
 */

import { randomUUID } from 'node:crypto'
import { AtomicCoreError } from '../contracts/index.js'
import type { AccessToken } from '../credentials/index.js'
import {
  ChatChunkStreamConverter,
  chatRequestToResponses,
  isJsonObject,
  serdeToString,
} from '../server/shims/index.js'
import type { JsonValue } from '../server/shims/index.js'

export const CHATGPT_PROVIDER = 'chatgpt'
export const CHATGPT_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const CHATGPT_ORIGINATOR = 'atomic_chat'
export const CHATGPT_USER_AGENT = 'atomic-chat/1'
/** `/codex/models` hides slugs whose minimal client version exceeds this. */
export const CHATGPT_CLIENT_VERSION = '0.156.0'
export const CHATGPT_REQUEST_TIMEOUT_MS = 600_000

export interface SubscriptionModel {
  id: string
  display_name: string
  context_length: number | null
  vision: boolean
  reasoning_efforts: string[]
  /** `false` marks a slug no picker should offer, kept so a saved model still resolves. */
  listed: boolean
}

/** Where the subscription lives and how to authenticate to it. The base URL is injectable for tests. */
export interface ChatGptBackend {
  accessToken(forceRefresh: boolean): Promise<AccessToken>
  baseUrl?: string
  fetch?: typeof fetch
}

function asU64(value: JsonValue | undefined): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null
}

export function normalizeModel(item: JsonValue): SubscriptionModel | null {
  if (!isJsonObject(item)) return null
  const slug = item['slug']
  if (typeof slug !== 'string' || slug === '' || Buffer.byteLength(slug) > 128) return null
  const display = item['display_name']
  const modalities = item['input_modalities']
  const levels = item['supported_reasoning_levels']
  return {
    id: slug,
    display_name: typeof display === 'string' && display !== '' ? display : slug,
    context_length: asU64(item['context_window']),
    vision: Array.isArray(modalities) && modalities.some((m) => m === 'image'),
    reasoning_efforts: Array.isArray(levels)
      ? levels.flatMap((l) => (isJsonObject(l) && typeof l['effort'] === 'string' ? [l['effort']] : []))
      : [],
    listed: item['visibility'] === 'list',
  }
}

export interface UpstreamRequest {
  method: 'POST'
  url: string
  headers: Array<[string, string]>
  body: string
}

export function buildUpstreamRequest(options: {
  baseUrl?: string
  accessToken: string
  accountId: string | null
  sessionId: string
  requestId: string
  payload: JsonValue
}): UpstreamRequest {
  const headers: Array<[string, string]> = [
    ['authorization', `Bearer ${options.accessToken}`],
    ['accept', 'text/event-stream'],
    ['content-type', 'application/json'],
    ['openai-beta', 'responses=experimental'],
    ['originator', CHATGPT_ORIGINATOR],
    ['user-agent', CHATGPT_USER_AGENT],
    // Hyphen, not underscore: the backend reads `session-id` to keep one conversation on one shard.
    ['session-id', options.sessionId],
    ['x-client-request-id', options.requestId],
  ]
  if (options.accountId !== null) headers.push(['chatgpt-account-id', options.accountId])
  return {
    method: 'POST',
    url: `${options.baseUrl ?? CHATGPT_BASE_URL}/responses`,
    headers,
    body: serdeToString(options.payload),
  }
}

/** Send with one forced token refresh on a 401: the server's opinion of the token outranks ours. */
async function withRefreshOn401(
  backend: ChatGptBackend,
  send: (token: AccessToken) => Promise<Response>
): Promise<Response> {
  let forced = false
  for (;;) {
    const token = await backend.accessToken(forced)
    const response = await send(token)
    if (response.status === 401 && !forced) {
      await response.body?.cancel().catch(() => {})
      forced = true
      continue
    }
    return response
  }
}

/** What the subscription can serve, straight from the account; no curated fallback. */
export async function listSubscriptionModels(backend: ChatGptBackend): Promise<SubscriptionModel[]> {
  const fetchImpl = backend.fetch ?? fetch
  const base = backend.baseUrl ?? CHATGPT_BASE_URL
  let response: Response
  try {
    response = await withRefreshOn401(backend, (token) =>
      fetchImpl(`${base}/models?client_version=${CHATGPT_CLIENT_VERSION}`, {
        headers: {
          'authorization': `Bearer ${token.token}`,
          'accept': 'application/json',
          'originator': CHATGPT_ORIGINATOR,
          'user-agent': CHATGPT_USER_AGENT,
          ...(token.accountId !== null ? { 'chatgpt-account-id': token.accountId } : {}),
        },
      })
    )
  } catch (e) {
    if (e instanceof AtomicCoreError) throw e
    throw new AtomicCoreError('UPSTREAM_ERROR', `Could not reach ChatGPT: ${(e as Error).message}`)
  }
  const body = await response.text()
  if (!response.ok)
    throw new AtomicCoreError('UPSTREAM_ERROR', `Could not list ChatGPT models (${response.status}): ${body}`)
  let parsed: JsonValue
  try {
    parsed = JSON.parse(body) as JsonValue
  } catch (e) {
    throw new AtomicCoreError(
      'UPSTREAM_ERROR',
      `ChatGPT returned an unreadable model list: ${(e as Error).message}`
    )
  }
  const items = isJsonObject(parsed) && Array.isArray(parsed['models']) ? parsed['models'] : []
  const seen = new Set<string>()
  return items.flatMap((item) => {
    const model = normalizeModel(item)
    if (!model || seen.has(model.id)) return []
    seen.add(model.id)
    return [model]
  })
}

/** How the server answers; the CORS headers are the caller's. */
export interface ChatGptReply {
  error(status: number, message: string): void
  json(body: string): void
  stream(chunks: AsyncIterable<string>, onClose: () => void): Promise<void>
}

/**
 * Answer one `/chat/completions` request from the subscription. The upstream only streams, so a
 * non-streaming client gets the aggregate of that stream.
 */
export async function serveSubscriptionChat(
  backend: ChatGptBackend,
  requestBody: JsonValue,
  stream: boolean,
  reply: ChatGptReply,
  signal?: AbortSignal
): Promise<void> {
  const sessionId = randomUUID()
  // Stable across the retry, and doubling as the prompt cache key.
  const payload = chatRequestToResponses(requestBody, sessionId)
  const model =
    isJsonObject(requestBody) && typeof requestBody['model'] === 'string' ? requestBody['model'] : ''
  const requestId = randomUUID().replaceAll('-', '')
  const created = Math.floor(Date.now() / 1000)
  const fetchImpl = backend.fetch ?? fetch

  let response: Response
  try {
    response = await withRefreshOn401(backend, (token) => {
      const request = buildUpstreamRequest({
        ...(backend.baseUrl !== undefined ? { baseUrl: backend.baseUrl } : {}),
        accessToken: token.token,
        accountId: token.accountId,
        sessionId,
        requestId,
        payload,
      })
      return fetchImpl(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(CHATGPT_REQUEST_TIMEOUT_MS)])
          : AbortSignal.timeout(CHATGPT_REQUEST_TIMEOUT_MS),
      })
    })
  } catch (e) {
    if (signal?.aborted) return
    if (e instanceof AtomicCoreError) return reply.error(401, e.message)
    return reply.error(502, `ChatGPT subscription request failed: ${(e as Error).message}`)
  }

  if (!response.ok) {
    // Verbatim: subscription quotas are per-account, and a generic error leaves nothing to act on.
    const body = await response.text().catch((e: Error) => `Failed to read error body: ${e.message}`)
    return reply.error(response.status, body)
  }

  const conv = new ChatChunkStreamConverter(model, created)
  if (!stream) {
    for await (const event of upstreamEvents(response)) {
      if (event === 'done') break
      conv.onEvent(event)
    }
    const error = conv.error()
    if (error !== null) return reply.error(502, error)
    return reply.json(serdeToString(conv.intoChatCompletion()))
  }

  async function* frames(): AsyncGenerator<string> {
    try {
      for await (const event of upstreamEvents(response)) {
        if (event === 'done') break
        for (const chunk of conv.onEvent(event)) yield `data: ${serdeToString(chunk)}\n\n`
      }
    } catch {
      // the upstream broke off; the client is still owed the closing frames below
    }
    // Whatever ended the stream, the client is waiting for a finish chunk and `[DONE]`.
    for (const chunk of conv.finish()) yield `data: ${serdeToString(chunk)}\n\n`
    yield 'data: [DONE]\n\n'
  }
  await reply.stream(frames(), () => void response.body?.cancel().catch(() => {}))
}

/** The `data:` payloads of an SSE body: parsed JSON, or `'done'` for `[DONE]`. */
async function* upstreamEvents(response: Response): AsyncGenerator<JsonValue | 'done'> {
  if (!response.body) return
  const decoder = new TextDecoder()
  let pending = ''
  const parse = function* (line: string): Generator<JsonValue | 'done'> {
    const text = line.trim()
    if (!text.startsWith('data:')) return
    const data = text.slice('data:'.length).trim()
    if (data === '[DONE]') {
      yield 'done'
      return
    }
    try {
      yield JSON.parse(data) as JsonValue
    } catch {
      // neither JSON nor [DONE]: nothing to translate
    }
  }
  for await (const chunk of response.body) {
    pending += decoder.decode(chunk, { stream: true })
    let newline = pending.indexOf('\n')
    while (newline >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      yield* parse(line)
      newline = pending.indexOf('\n')
    }
  }
  pending += decoder.decode()
  if (pending !== '') yield* parse(pending)
}
