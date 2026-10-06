/**
 * Model compatibility and the model setup: `POST /models/compatibility` (what a file needs and
 * whether this core runs it), `GET /models/atomic-prism/families` (the Bonsai models the conf rules
 * name, for the Hub), `POST /models/setup-plan` (what a setup would install and download,
 * with a digest), `POST /model-setups` (start one from that digest), `GET /model-setups[/:id]`, and
 * `POST /model-setups/:id/{cancel,resume}`. Progress is the `model-setup:changed` event plus the
 * `download:*` events of the setup's task ids.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import type { ProxyConfig } from '../../../contracts/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps, ModelSetupControl } from '../types.js'

function control(deps: ControlServerDeps): ModelSetupControl {
  if (!deps.modelSetups)
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Model setup is not available in this core.')
  return deps.modelSetups
}

async function objectBody<T>(req: Parameters<typeof readJsonBody>[0]): Promise<T> {
  const body = await readJsonBody<T>(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'The request body must be a JSON object.')
  }
  return body
}

export function registerModelSetupRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  router.post(p('/models/compatibility'), async (req, res) => {
    const setups = control(deps)
    sendJson(res, 200, await setups.compatibility(await objectBody(req)))
  })
  router.get(p('/models/atomic-prism/families'), async (_req, res) => {
    sendJson(res, 200, await control(deps).families())
  })
  router.post(p('/models/setup-plan'), async (req, res) => {
    const setups = control(deps)
    sendJson(res, 200, await setups.plan(await objectBody(req)))
  })
  router.post(p('/model-setups'), async (req, res) => {
    const setups = control(deps)
    sendJson(res, 202, await setups.start(await objectBody(req)))
  })
  router.get(p('/model-setups'), async (_req, res) => {
    sendJson(res, 200, { setups: await control(deps).list() })
  })
  router.get(p('/model-setups/:id'), async (_req, res, { params }) => {
    sendJson(res, 200, await control(deps).get(params['id'] ?? ''))
  })
  router.post(p('/model-setups/:id/cancel'), async (_req, res, { params }) => {
    sendJson(res, 200, await control(deps).cancel(params['id'] ?? ''))
  })
  router.post(p('/model-setups/:id/resume'), async (req, res, { params }) => {
    const setups = control(deps)
    const body = await objectBody<{ proxy?: ProxyConfig | null }>(req)
    sendJson(res, 200, await setups.resume(params['id'] ?? '', { proxy: body.proxy ?? null }))
  })
}
