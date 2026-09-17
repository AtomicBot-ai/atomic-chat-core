/** Reaching the Local API Server from outside this machine: what a LAN device can dial. */

import { sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerRemoteAccessRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  // Display only: the listener trusts the address each socket arrived on, not this list.
  router.get(p('/lan-addresses'), async (_req, res) =>
    sendJson(res, 200, { addresses: await deps.remoteAccess.lanAddresses() })
  )
}
