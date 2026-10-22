/**
 * LiteRT-LM's accelerator (openspec change `add-litert-lm-runtime`, task 6.4, design D3): what this
 * machine is offered, and the explicit `prepare` a client orders. The same shape as Foundry Local's
 * routes; progress goes out as `litert-lm:accelerators`, the answer to `prepare` is its summary.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import type { LiteRtLmPrepareRequest, ProxyConfig } from '../../../contracts/index.js'
import { readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'
import { parsePrepareBody } from './foundry-local.js'

/** Foundry Local's prepare body plus the `proxy` an engine install takes. */
export function parseLiteRtLmPrepareBody(raw: unknown): LiteRtLmPrepareRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new AtomicCoreError('INVALID_ARGUMENT', 'The request body must be a JSON object.')
  const { proxy, ...rest } = raw as Record<string, unknown>
  if (proxy !== undefined && proxy !== null && (typeof proxy !== 'object' || Array.isArray(proxy)))
    throw new AtomicCoreError('INVALID_ARGUMENT', 'proxy must be an object or null.')
  return { ...parsePrepareBody(rest), ...(proxy !== undefined ? { proxy: proxy as ProxyConfig | null } : {}) }
}

export function registerLiteRtLmRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const absent = () =>
    new AtomicCoreError('PROVIDER_NOT_FOUND', 'LiteRT-LM does not run on this computer.', 'litert-lm')

  router.get(p('/runtimes/litert-lm/accelerators'), async (_req, res) => {
    if (!deps.liteRtLm) return sendError(res, absent())
    sendJson(res, 200, await deps.liteRtLm.accelerators())
  })

  // Synchronous like an engine install: the answer is the summary, the steps go out as events.
  router.post(p('/runtimes/litert-lm/accelerators/prepare'), async (req, res) => {
    if (!deps.liteRtLm) return sendError(res, absent())
    sendJson(res, 200, await deps.liteRtLm.prepare(parseLiteRtLmPrepareBody(await readJsonBody(req))))
  })
}
