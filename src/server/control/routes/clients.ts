/** Client registration: attach with a snapshot, heartbeat, detach. */

import { AtomicCoreError } from '../../../contracts/index.js'
import { CLIENT_HEARTBEAT_INTERVAL_MS } from '../../clients.js'
import { readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerClientRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p, snapshot } = ctx

  router.post(p('/clients'), async (req, res) => {
    const body = await readJsonBody<{ name?: string; pid?: number }>(req)
    const client = deps.clients.register({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.pid !== undefined ? { pid: body.pid } : {}),
    })
    sendJson(res, 201, {
      client,
      heartbeat_interval_ms: CLIENT_HEARTBEAT_INTERVAL_MS,
      snapshot: snapshot(),
    })
  })

  router.post(p('/clients/:id/heartbeat'), (_req, res, { params }) => {
    const ok = deps.clients.heartbeat(params['id'] as string)
    if (!ok)
      return sendError(
        res,
        new AtomicCoreError('CORE_NOT_RUNNING', 'This client registration has expired; register again.'),
        410
      )
    sendJson(res, 200, { ok: true })
  })

  router.delete(p('/clients/:id'), (_req, res, { params }) => {
    deps.clients.unregister(params['id'] as string)
    sendJson(res, 200, { ok: true })
  })
}
