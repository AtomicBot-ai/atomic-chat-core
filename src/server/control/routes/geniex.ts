/**
 * GenieX's devices (openspec change `add-geniex-runtime`, task 6.4, design D3): what the active
 * build's library found, in LiteRT-LM's shape, and a `prepare` that has nothing to do and says so.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import { readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'
import { parsePrepareBody } from './foundry-local.js'

export function registerGeniexRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const absent = () =>
    new AtomicCoreError('PROVIDER_NOT_FOUND', 'GenieX does not run on this computer.', 'geniex')

  router.get(p('/runtimes/geniex/accelerators'), async (_req, res) => {
    if (!deps.geniex) return sendError(res, absent())
    sendJson(res, 200, await deps.geniex.accelerators())
  })

  router.post(p('/runtimes/geniex/accelerators/prepare'), async (req, res) => {
    if (!deps.geniex) return sendError(res, absent())
    sendJson(res, 200, await deps.geniex.prepare(parsePrepareBody(await readJsonBody(req))))
  })
}
