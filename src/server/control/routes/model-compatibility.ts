/**
 * Model compatibility: `POST /models/compatibility` (what a file needs and whether this core runs
 * it, before download by repo and file or after it by `model_id`) and `GET /models/atomic-prism/families`
 * (the Bonsai models the conf rules name, for a client to plan its own download). The core does not
 * download model files; clients do (ADR 2026-10-15-core-does-not-download-models).
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps, ModelCompatibilityControl } from '../types.js'

function control(deps: ControlServerDeps): ModelCompatibilityControl {
  if (!deps.modelCompatibility)
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Model compatibility is not available in this core.')
  return deps.modelCompatibility
}

async function objectBody<T>(req: Parameters<typeof readJsonBody>[0]): Promise<T> {
  const body = await readJsonBody<T>(req)
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'The request body must be a JSON object.')
  }
  return body
}

export function registerModelCompatibilityRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  router.post(p('/models/compatibility'), async (req, res) => {
    const compatibility = control(deps)
    sendJson(res, 200, await compatibility.compatibility(await objectBody(req)))
  })
  router.get(p('/models/atomic-prism/families'), async (_req, res) => {
    sendJson(res, 200, await control(deps).families())
  })
}
