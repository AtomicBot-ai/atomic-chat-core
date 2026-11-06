import { AtomicCoreError } from '../../../contracts/index.js'
import { readJsonBody, sendJson, type Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerFastFlowLmRoutes(
  router: Router,
  deps: ControlServerDeps,
  { p }: ControlRouteContext
) {
  const maintenance = deps.fastFlowLmMaintenance
  if (maintenance) {
    const path = p('/models/fastflowlm/maintenance')
    router.get(path, async (_req, res) => sendJson(res, 200, await maintenance.list()))
    router.post(path, async (req, res) =>
      sendJson(res, 200, await maintenance.begin(await readJsonBody(req)))
    )
    router.get(path + '/:id', async (_req, res, { params }) =>
      sendJson(res, 200, await maintenance.get(params.id!))
    )
    router.post(path + '/:id/complete', async (req, res, { params }) => {
      const body = await readJsonBody(req)
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
        throw new AtomicCoreError('INVALID_ARGUMENT', 'Complete takes an empty object.')
      sendJson(res, 200, await maintenance.complete(params.id!))
    })
  }
  const ops = deps.fastFlowLmOperations
  if (!ops) return
  const path = p('/runtimes/fastflowlm/operations')
  router.get(path, async (_req, res) => sendJson(res, 200, await ops.list()))
  router.post(path, async (req, res) => sendJson(res, 202, await ops.begin(await readJsonBody(req))))
  router.get(path + '/:id', async (_req, res, { params }) => sendJson(res, 200, await ops.get(params.id!)))
  router.post(path + '/:id/consent', async (req, res, { params }) =>
    sendJson(res, 200, await ops.consent(params.id!, await readJsonBody(req)))
  )
  router.post(path + '/:id/claim-host-step', async (req, res, { params }) =>
    sendJson(res, 200, await ops.claim(params.id!, await readJsonBody(req)))
  )
  router.post(path + '/:id/host-step-receipt', async (req, res, { params }) =>
    sendJson(res, 200, await ops.receipt(params.id!, await readJsonBody(req)))
  )
  router.post(path + '/:id/cancel', async (req, res, { params }) => {
    const body = await readJsonBody(req)
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Cancel takes an empty object.')
    sendJson(res, 200, await ops.cancel(params.id!))
  })
  router.post(path + '/:id/resume', async (req, res, { params }) => {
    const body = await readJsonBody<{ expected_revision: number }>(req)
    if (!body || typeof body.expected_revision !== 'number' || Object.keys(body).length !== 1)
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Resume requires expected_revision.')
    sendJson(res, 200, await ops.resume(params.id!, body.expected_revision))
  })
}
