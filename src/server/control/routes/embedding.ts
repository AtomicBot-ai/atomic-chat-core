/**
 * The embedding model: status, configuration, load and unload, and one request to the running model
 * (ADR 2026-10-07-embedding-models-are-their-own-core-module). Bodies are snake_case like
 * `settings.json`. `embed` takes a `/v1/embeddings` body (its `model` is replaced by the running
 * model's) and answers `{status, body}`: the engine's own answer, an error envelope included.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps, EmbeddingControl } from '../types.js'

function control(deps: ControlServerDeps): EmbeddingControl {
  if (!deps.embedding)
    throw new AtomicCoreError('EMBEDDING_UNAVAILABLE', 'The embedding model is not available in this core.')
  return deps.embedding
}

async function objectBody(
  req: Parameters<typeof readJsonBody>[0],
  what: string
): Promise<Record<string, unknown>> {
  const body = await readJsonBody<Record<string, unknown>>(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    throw new AtomicCoreError('INVALID_ARGUMENT', `The ${what} must be a JSON object.`)
  return body
}

export function registerEmbeddingRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const configAnswer = (embedding: EmbeddingControl) => ({
    config: embedding.config(),
    status: embedding.status(),
  })

  router.get(p('/embedding/status'), async (_req, res) => sendJson(res, 200, control(deps).status()))
  router.get(p('/embedding/config'), async (_req, res) => sendJson(res, 200, configAnswer(control(deps))))
  router.put(p('/embedding/config'), async (req, res) => {
    const embedding = control(deps)
    await embedding.configure(await objectBody(req, 'embedding settings'))
    sendJson(res, 200, configAnswer(embedding))
  })
  router.post(p('/embedding/load'), async (_req, res) => sendJson(res, 200, await control(deps).load()))
  router.post(p('/embedding/unload'), async (_req, res) => sendJson(res, 200, await control(deps).unload()))
  router.post(p('/embedding/embed'), async (req, res) => {
    const embedding = control(deps)
    const body = await objectBody(req, 'embedding request')
    if (body['input'] === undefined)
      throw new AtomicCoreError('INVALID_ARGUMENT', "The embedding request needs an 'input'.")
    sendJson(res, 200, await embedding.embed(body))
  })
}
