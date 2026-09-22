/**
 * Sessions and models: load, unload, recreate, context increase, capabilities, embeddings, GGUF
 * validation, Foundation Models availability, and the devices a backend reports.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import { queryOf, readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerModelRoutes(router: Router, deps: ControlServerDeps, ctx: ControlRouteContext): void {
  const { p } = ctx

  router.get(p('/sessions'), (_req, res) => sendJson(res, 200, { sessions: deps.sessions() }))

  // Registered ahead of `load`: a cancel is never queued behind the load it stops.
  router.post(p('/models/:provider/*modelId/load/cancel'), (_req, res, { params }) => {
    const cancelled = deps.cancelModelLoad(params['provider'] as string, params['modelId'] as string)
    sendJson(res, 200, { cancelled })
  })

  router.post(p('/models/:provider/*modelId/load'), async (req, res, { params }) => {
    const body = await readJsonBody<Record<string, unknown>>(req)
    const result = await deps.loadModel(params['provider'] as string, params['modelId'] as string, body)
    sendJson(res, 200, 'session' in result ? result : { session: result, created: true })
  })

  router.post(p('/models/:provider/*modelId/unload'), async (_req, res, { params }) => {
    const result = await deps.unloadModel(params['provider'] as string, params['modelId'] as string)
    sendJson(res, 200, result)
  })

  router.post(p('/models/:provider/*modelId/recreate'), async (_req, res, { params }) => {
    sendJson(res, 200, await deps.recreateSession(params['provider'] as string, params['modelId'] as string))
  })

  router.post(p('/models/:provider/*modelId/ctx/increase'), async (req, res, { params }) => {
    const body = await readJsonBody<{ reason?: string }>(req)
    const result = await deps.increaseCtx(
      params['provider'] as string,
      params['modelId'] as string,
      body.reason
    )
    sendJson(res, 200, result)
  })

  router.get(p('/models/:provider/*modelId/capabilities'), async (_req, res, { params }) => {
    sendJson(
      res,
      200,
      await deps.models.capabilities(params['provider'] as string, params['modelId'] as string)
    )
  })

  router.post(p('/models/:provider/*modelId/embed'), async (req, res, { params }) => {
    const body = await readJsonBody<{ input?: string[]; ubatch_size?: number }>(req)
    sendJson(
      res,
      200,
      await deps.models.embed(
        params['provider'] as string,
        params['modelId'] as string,
        body.input as string[],
        body.ubatch_size ?? 512
      )
    )
  })

  // Answers `{isValid:false, error}` for a file that is not a model: the user pointed at it, and
  // "that is not a model" is the answer to their question, not a failure of the core.
  router.post(p('/gguf/validate'), async (req, res) => {
    const body = await readJsonBody<{ path?: string }>(req)
    if (!body.path) return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', 'validate needs a path'))
    sendJson(res, 200, await deps.models.validateGguf(body.path))
  })

  router.get(p('/runtimes/foundation-models/availability'), async (req, res) => {
    const force = queryOf(req).get('force') === '1'
    const status = deps.foundationModelsAvailability
      ? await deps.foundationModelsAvailability(force)
      : 'unavailable'
    sendJson(res, 200, { status })
  })

  router.get(p('/hardware/devices'), async (req, res) => {
    const provider = queryOf(req).get('provider') ?? 'llamacpp-upstream'
    sendJson(res, 200, { devices: await deps.models.devices(provider) })
  })
}
