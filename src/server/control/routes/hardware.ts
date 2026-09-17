/** The hardware facts the app injects. */

import type { HardwareOverrideInput } from '../../../hardware/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerHardwareRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  // The app measures the machine with NVML and Vulkan; the core cannot. Injection has to land
  // before a backend is chosen, which is why the app sends it as soon as it attaches.
  router.get(p('/hardware/override'), (_req, res) =>
    sendJson(res, 200, { override: deps.hardware.get() ?? null })
  )

  router.put(p('/hardware/override'), async (req, res) => {
    const body = await readJsonBody<HardwareOverrideInput>(req)
    sendJson(res, 200, { override: deps.hardware.set(body) })
  })

  router.delete(p('/hardware/override'), (_req, res) =>
    sendJson(res, 200, { cleared: deps.hardware.clear() })
  )
}
