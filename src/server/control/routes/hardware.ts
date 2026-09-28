/** The hardware facts: the core's probe, a refresh of it, and the override a host may inject over it. */

import type { HardwareOverrideInput } from '../../../contracts/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerHardwareRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  // What the core measured (or, while one stands, the override), with the probe's warnings. The
  // first call may wait for the start-up probe; it never fails because a tool was missing.
  router.get(p('/hardware/info'), async (_req, res) => sendJson(res, 200, await deps.hardware.info()))

  // A new probe, for a machine that changed (an eGPU, a driver install) since the core started.
  router.post(p('/hardware/refresh'), async (_req, res) => sendJson(res, 200, await deps.hardware.refresh()))

  // An injected description replaces the probe wholesale for as long as it stands: tests, and hosts
  // with better numbers than a shell probe can read.
  router.get(p('/hardware/override'), (_req, res) =>
    sendJson(res, 200, { override: deps.hardware.getOverride() ?? null })
  )

  router.put(p('/hardware/override'), async (req, res) => {
    const body = await readJsonBody<HardwareOverrideInput>(req)
    sendJson(res, 200, { override: deps.hardware.setOverride(body) })
  })

  router.delete(p('/hardware/override'), (_req, res) =>
    sendJson(res, 200, { cleared: deps.hardware.clearOverride() })
  )
}
