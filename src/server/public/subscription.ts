/**
 * The `/chat/completions` branch for the ChatGPT subscription, as the public server sees it: read
 * the body, decide whether the model belongs to the subscription, and answer with the proxy's CORS
 * headers. The protocol work is `cloud/chatgpt.ts`.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`try_serve_chatgpt`).
 */

import { CHATGPT_PROVIDER, serveSubscriptionChat } from '../../cloud/index.js'
import type { ChatGptBackend } from '../../cloud/index.js'
import { resolveRemoteProvider } from '../../router/index.js'
import { isJsonObject } from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'
import { answer, clientGone } from './exchange.js'
import type { Exchange } from './exchange.js'
import { pipeBody, readBody } from './wire.js'

/**
 * `true` when the request was the subscription's and has been answered. Otherwise the body stays on
 * the exchange for the generic path, which also owns every error about a malformed body.
 */
export async function serveSubscriptionIfOwned(ex: Exchange, backend: ChatGptBackend): Promise<boolean> {
  try {
    ex.body = await readBody(ex.req)
  } catch {
    answer(ex, 500, 'Failed to read request body')
    return true
  }
  let json: JsonValue
  try {
    json = JSON.parse(ex.body.toString('utf8')) as JsonValue
  } catch {
    return false
  }
  const model = isJsonObject(json) ? json['model'] : undefined
  if (typeof model !== 'string') return false
  if (resolveRemoteProvider(model, ex.deps.providers())?.provider !== CHATGPT_PROVIDER) return false

  const stream = isJsonObject(json) && json['stream'] === true
  // `chat_completions`, not `chat/completions`: the label the app's analytics has always used here.
  ex.trace.endpoint = 'chat_completions'
  ex.trace.backend = 'remote'
  ex.trace.provider = CHATGPT_PROVIDER
  ex.trace.modelId = model
  ex.trace.stream = stream
  ex.trace.announce(json, ex.body)
  const signal = clientGone(ex)
  await serveSubscriptionChat(
    backend,
    json,
    stream,
    {
      error: (status, message) => answer(ex, status, message),
      json: (body) => answer(ex, 200, body, [['Content-Type', 'application/json']]),
      stream: async (chunks, onClose) => {
        ex.res.writeHead(
          200,
          [['Content-Type', 'text/event-stream'], ['Cache-Control', 'no-cache'], ...ex.cors].flat()
        )
        await pipeBody(ex.res, chunks, onClose)
      },
    },
    signal
  )
  return true
}
