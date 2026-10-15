/**
 * Foundry Local's accelerators (openspec change `add-foundry-local`, task 6.4, design D3): the last
 * probe of the active build, and the explicit `prepare` a client orders. Progress goes out as
 * `foundry-local:accelerators`; the answer to `prepare` is its summary.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import type { FoundryLocalPrepareRequest } from '../../../contracts/index.js'
import { queryOf, readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

const invalid = (why: string, details?: string): never => {
  throw new AtomicCoreError('INVALID_ARGUMENT', why, details)
}

/** A library EP name: letters, digits, a few separators. */
const ACCELERATOR_NAME = /^[A-Za-z0-9._-]{1,100}$/

export function parsePrepareBody(raw: unknown): FoundryLocalPrepareRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return invalid('The request body must be a JSON object.')
  const body = raw as Record<string, unknown>
  const extra = Object.keys(body).filter((key) => key !== 'accelerators')
  if (extra.length > 0) invalid('The request has fields this core does not know.', extra.sort().join(', '))
  const names = body['accelerators']
  if (names === undefined) return {}
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string' || !ACCELERATOR_NAME.test(name)))
    return invalid('accelerators must be a list of accelerator names.')
  return { accelerators: names as string[] }
}

export function registerFoundryLocalRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const absent = () =>
    new AtomicCoreError('PROVIDER_NOT_FOUND', 'Foundry Local does not run on this computer.', 'foundry-local')

  router.get(p('/runtimes/foundry-local/accelerators'), async (req, res) => {
    if (!deps.foundryLocal) return sendError(res, absent())
    sendJson(res, 200, await deps.foundryLocal.accelerators(queryOf(req).get('force') === '1'))
  })

  // Synchronous like an engine install: the answer is the summary, the steps go out as events.
  router.post(p('/runtimes/foundry-local/accelerators/prepare'), async (req, res) => {
    if (!deps.foundryLocal) return sendError(res, absent())
    sendJson(res, 200, await deps.foundryLocal.prepare(parsePrepareBody(await readJsonBody(req))))
  })
}
