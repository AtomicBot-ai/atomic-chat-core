/**
 * Reaching the Local API Server from outside this machine: the Cloudflare quick tunnel, and what a
 * LAN device can dial. The status is the app's camelCase payload, as the settings page renders it.
 */

import { sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerRemoteAccessRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  router.get(p('/remote-access'), (_req, res) => sendJson(res, 200, deps.remoteAccess.status()))

  // Answers `starting` at once; the URL arrives later as a `remote-access:status` event.
  router.post(p('/remote-access/start'), (_req, res) => sendJson(res, 200, deps.remoteAccess.start()))

  // Answers once the process is gone, which can take both grace periods when it ignores signals.
  router.post(p('/remote-access/stop'), async (_req, res) =>
    sendJson(res, 200, await deps.remoteAccess.stop())
  )

  // Display only: the listener trusts the address each socket arrived on, not this list.
  router.get(p('/lan-addresses'), async (_req, res) =>
    sendJson(res, 200, { addresses: await deps.remoteAccess.lanAddresses() })
  )
}
