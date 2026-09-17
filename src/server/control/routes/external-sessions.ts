/** Engines another process owns: publish, heartbeat, unregister, list, and context-increase answers. */

import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerExternalSessionRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  router.get(p('/external-sessions'), (_req, res) =>
    sendJson(res, 200, { sessions: deps.externalSessions.list() })
  )

  router.put(p('/external-sessions/:owner'), async (req, res, { params }) => {
    const body = await readJsonBody<{ generation?: number; sessions?: unknown }>(req)
    sendJson(
      res,
      200,
      deps.externalSessions.publish(params['owner'] as string, body.generation as number, body.sessions)
    )
  })

  router.post(p('/external-sessions/:owner/heartbeat'), async (req, res, { params }) => {
    const body = await readJsonBody<{ generation?: number }>(req)
    sendJson(res, 200, deps.externalSessions.heartbeat(params['owner'] as string, Number(body.generation)))
  })

  router.delete(p('/external-sessions/:owner'), async (req, res, { params }) => {
    const body = await readJsonBody<{ generation?: number }>(req)
    sendJson(res, 200, {
      unregistered: deps.externalSessions.unregister(params['owner'] as string, body.generation),
    })
  })

  router.post(p('/external-sessions/:owner/ctx/:requestId'), async (req, res, { params }) => {
    const body = await readJsonBody<unknown>(req)
    sendJson(res, 200, {
      accepted: deps.externalSessions.answerCtx(
        params['owner'] as string,
        params['requestId'] as string,
        body
      ),
    })
  })
}
