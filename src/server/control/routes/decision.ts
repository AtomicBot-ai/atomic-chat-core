/**
 * The decision model: status, configuration, load and unload, and the two fail-open calls
 * (ADR 2026-09-30-the-decision-model-is-its-own-core-module). Bodies are snake_case like the engine
 * and `settings.json`. `score` and `decide` answer 200 with an outcome once the body parses:
 * `{unavailable: false, result}` or `{unavailable: true, reason, message}`, the same value an in-core
 * caller gets. A body that is not JSON or not a valid request is 400 `INVALID_ARGUMENT`.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import { parseDecideRequest, parseScoreRequest } from '../../../decision/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps, DecisionControl } from '../types.js'

function control(deps: ControlServerDeps): DecisionControl {
  if (!deps.decision)
    throw new AtomicCoreError('DECISION_UNAVAILABLE', 'The decision model is not available in this core.')
  return deps.decision
}

export function registerDecisionRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const configAnswer = (decision: DecisionControl) => ({
    config: decision.config(),
    status: decision.status(),
  })

  router.get(p('/decision/status'), async (_req, res) => sendJson(res, 200, control(deps).status()))
  router.get(p('/decision/config'), async (_req, res) => sendJson(res, 200, configAnswer(control(deps))))
  router.put(p('/decision/config'), async (req, res) => {
    const decision = control(deps)
    const patch = await readJsonBody<Record<string, unknown>>(req)
    if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
      throw new AtomicCoreError('INVALID_ARGUMENT', 'The decision settings must be a JSON object.')
    await decision.configure(patch)
    sendJson(res, 200, configAnswer(decision))
  })
  router.post(p('/decision/load'), async (_req, res) => sendJson(res, 200, await control(deps).load()))
  router.post(p('/decision/unload'), async (_req, res) => sendJson(res, 200, await control(deps).unload()))
  router.post(p('/decision/score'), async (req, res) => {
    const decision = control(deps)
    sendJson(res, 200, await decision.score(parseScoreRequest(await readJsonBody(req))))
  })
  router.post(p('/decision/decide'), async (req, res) => {
    const decision = control(deps)
    sendJson(res, 200, await decision.decide(parseDecideRequest(await readJsonBody(req))))
  })
}
