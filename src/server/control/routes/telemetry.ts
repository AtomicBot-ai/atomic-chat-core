/** The app's error-reporting consent, anonymous user and hardware tags (`set_telemetry_*` in the app). */

import { AtomicCoreError } from '../../../contracts/index.js'
import type { TelemetryState, TelemetryUpdateRequest } from '../../../contracts/index.js'
import { readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

/** What a core without a reporter (a CLI owner) says: nothing is reported, whatever the app asks. */
const NOT_REPORTING: TelemetryState = { enabled: false, reporting: false, has_user: false, tags: {} }

/** The body of `PUT /telemetry`, or a message saying what is wrong with it. */
export function parseTelemetryUpdate(body: unknown): TelemetryUpdateRequest | string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'telemetry needs a JSON object'
  const { enabled, user_id: userId, tags } = body as Record<string, unknown>
  if (enabled !== undefined && typeof enabled !== 'boolean') return '"enabled" must be true or false'
  if (userId !== undefined && userId !== null && typeof userId !== 'string')
    return '"user_id" must be a string or null'
  if (
    tags !== undefined &&
    (!tags ||
      typeof tags !== 'object' ||
      Array.isArray(tags) ||
      Object.values(tags).some((value) => typeof value !== 'string'))
  )
    return '"tags" must map names to strings'
  return {
    ...(enabled !== undefined ? { enabled } : {}),
    ...(userId !== undefined ? { user_id: userId } : {}),
    ...(tags !== undefined ? { tags: tags as Record<string, string> } : {}),
  }
}

export function registerTelemetryRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const state = () => deps.telemetry?.state() ?? NOT_REPORTING

  router.get(p('/telemetry'), (_req, res) => sendJson(res, 200, state()))

  router.put(p('/telemetry'), async (req, res) => {
    const update = parseTelemetryUpdate(await readJsonBody(req))
    if (typeof update === 'string') return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', update))
    deps.telemetry?.update(update)
    sendJson(res, 200, state())
  })
}
