import { AtomicCoreError } from '../../../contracts/index.js'
import type { StrataMaintenanceRequest, StrataPreparationRequest } from '../../../contracts/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'
import type { IncomingMessage } from 'node:http'

async function empty(req: IncomingMessage): Promise<void> {
  const body = await readJsonBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Send an empty JSON object.')
}

export function registerStrataRoutes(
  router: Router,
  deps: ControlServerDeps,
  { p }: ControlRouteContext
): void {
  const service = deps.strata
  if (!service) return
  const { preparations, maintenance } = service
  router.get(p('/models/strata/:id/context-limit'), async (_req, res, { params }) =>
    sendJson(res, 200, { max_context_length: await service.contextLimit(params.id!) })
  )
  const prep = '/strata/preparations'
  const guard = '/models/strata/maintenance'
  router.get(p(prep), (_req, res) => sendJson(res, 200, preparations.list()))
  router.post(p(prep), async (req, res) =>
    sendJson(res, 202, await preparations.begin(await readJsonBody<StrataPreparationRequest>(req)))
  )
  router.get(p(prep + '/:id'), (_req, res, { params }) => sendJson(res, 200, preparations.get(params.id!)))
  router.post(p(prep + '/:id/cancel'), async (req, res, { params }) => {
    await empty(req)
    sendJson(res, 200, await preparations.cancel(params.id!))
  })
  router.post(p(prep + '/:id/resume'), async (req, res, { params }) => {
    await empty(req)
    sendJson(res, 200, await preparations.resume(params.id!))
  })
  router.get(p(guard), (_req, res) => sendJson(res, 200, maintenance.list()))
  router.post(p(guard), async (req, res) =>
    sendJson(res, 200, await maintenance.begin(await readJsonBody<StrataMaintenanceRequest>(req)))
  )
  router.get(p(guard + '/:id'), (_req, res, { params }) => sendJson(res, 200, maintenance.get(params.id!)))
  router.post(p(guard + '/:id/complete'), async (req, res, { params }) => {
    await empty(req)
    sendJson(res, 200, await maintenance.complete(params.id!))
  })
}
