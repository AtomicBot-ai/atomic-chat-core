/** Free disk space inside the data folder, asked before a download that might not fit. */

import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerDiskRoutes(router: Router, deps: ControlServerDeps, ctx: ControlRouteContext): void {
  const { p } = ctx

  // POST with the path in the body, not a query string: an absolute path carries a user name.
  router.post(p('/disk/available'), async (req, res) => {
    const body = await readJsonBody<{ path?: unknown }>(req)
    sendJson(res, 200, { bytes: await deps.disk.available(body.path) })
  })
}
