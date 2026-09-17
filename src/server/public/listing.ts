/**
 * What the server can route to: the OpenAI model list, Muse Code's catalogue, and llama-server's
 * Prometheus metrics for one loaded model.
 *
 * Ported from: src-tauri/src/core/server/proxy.rs (`collect_served_models`, `muse_catalog_entry`,
 * the `/models`, `/muse-code/models` and `/metrics` arms).
 */

import { serdeToString } from '../shims/index.js'
import type { JsonValue } from '../shims/index.js'
import { answer, connectTimeoutMs, header } from './exchange.js'
import type { Exchange } from './exchange.js'
import { readBody, sendUpstream } from './wire.js'
import type { LocalProvider } from '../../router/index.js'

/**
 * Advertised to Muse Code, which compacts a conversation as it nears the advertised context. The
 * server does not know a session's real window, so these under-estimate on purpose: guessing low
 * costs an earlier compaction, guessing high costs hard overflow errors mid-run.
 */
const MUSE_LOCAL_CONTEXT_LIMIT = 32_768
const MUSE_REMOTE_CONTEXT_LIMIT = 200_000
const MUSE_OUTPUT_LIMIT = 32_768

/** `owned_by` is the label this endpoint has always used, not the provider id. */
const OWNED_BY: Record<LocalProvider, string> = {
  'llamacpp': 'llama.cpp',
  'llamacpp-upstream': 'llama.cpp-upstream',
  'mlx': 'mlx',
}

export function servedModels(ex: Exchange): Array<{ id: string; ownedBy: string }> {
  const models = ex.deps.listLocal().map((s) => ({ id: s.modelId, ownedBy: OWNED_BY[s.provider] }))
  for (const provider of ex.deps.providers().values()) {
    for (const id of provider.models) models.push({ id, ownedBy: 'remote' })
  }
  return models
}

export function serveModels(ex: Exchange): void {
  const data = servedModels(ex).map((m) => ({ id: m.id, object: 'model', created: 1, owned_by: m.ownedBy }))
  answer(ex, 200, serdeToString({ object: 'list', data }), [['Content-Type', 'application/json']])
}

export function serveMuseCatalog(ex: Exchange): void {
  const data = servedModels(ex).map((m) => museCatalogEntry(m.id, m.ownedBy))
  answer(ex, 200, serdeToString({ object: 'list', data }), [['Content-Type', 'application/json']])
}

/**
 * One row of Muse Code's catalogue. `modalities.input` claims text only and `reasoning` is false,
 * because the server cannot know either per model and the safe answer never sends a text-only model
 * an image or a reasoning parameter. `tool_call` must stay true: without it Muse has no agent loop.
 */
export function museCatalogEntry(modelId: string, ownedBy: string): JsonValue {
  const context = ownedBy === 'remote' ? MUSE_REMOTE_CONTEXT_LIMIT : MUSE_LOCAL_CONTEXT_LIMIT
  return {
    id: modelId,
    object: 'model',
    created: 1,
    owned_by: ownedBy,
    metadata: {
      'muse-code': {
        name: modelId,
        family: ownedBy,
        release_date: '2026-01-01',
        is_hidden: false,
        attachment: false,
        reasoning: false,
        temperature: false,
        tool_call: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context, output: MUSE_OUTPUT_LIMIT },
        options: { include: [], temperature: 0.9, top_p: 0.9 },
        variants: {},
        description: `${modelId} via Atomic Chat`,
        cost: { input: '0', output: '0', cached: '0', currency: 'USD' },
      },
    },
  }
}

/**
 * `GET /metrics?model=<id>` (or `X-Model`). llama.cpp is the only engine with a Prometheus exporter,
 * so MLX sessions are deliberately not considered. llama-server serves it at its root, not under
 * `/v1`, and behind the session key.
 */
export async function serveMetrics(ex: Exchange): Promise<void> {
  // The query value is taken as sent, not percent-decoded, as the proxy did. An empty `model=` is
  // still "given" and does not fall back to the header.
  const fromQuery = ex.query
    ?.split('&')
    .map((pair) => {
      const eq = pair.indexOf('=')
      return eq < 0 ? undefined : pair.slice(0, eq) === 'model' ? pair.slice(eq + 1) : undefined
    })
    .find((v) => v !== undefined)
  const modelId = fromQuery ?? header(ex.req, 'x-model')
  if (!modelId) {
    answer(ex, 400, "Missing 'model' query parameter (use ?model=<model_id>)")
    return
  }

  const session = ex.deps.findLocal('llamacpp', modelId) ?? ex.deps.findLocal('llamacpp-upstream', modelId)
  if (!session) {
    answer(ex, 404, `No running llama.cpp session for model '${modelId}'`)
    return
  }

  const headers: Array<[string, string]> = session.apiKey
    ? [['Authorization', `Bearer ${session.apiKey}`]]
    : []
  try {
    const upstream = await sendUpstream(`http://127.0.0.1:${session.port}/metrics`, {
      method: 'GET',
      headers,
      connectTimeoutMs: connectTimeoutMs(ex),
    })
    const bytes = await readBody(upstream.body).catch(() => Buffer.alloc(0))
    answer(ex, upstream.status, bytes, [
      ['Content-Type', upstream.contentType ?? 'text/plain; version=0.0.4'],
    ])
  } catch (e) {
    answer(ex, 502, `Failed to fetch metrics from llama-server: ${(e as Error).message}`)
  }
}
