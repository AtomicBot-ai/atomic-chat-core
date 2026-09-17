/** The public `/v1` listener: status, start, stop, and the inspector toggle. */

import { AtomicCoreError } from '../../../contracts/index.js'
import { readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerPublicServerRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  router.get(p('/server'), (_req, res) => sendJson(res, 200, deps.publicServer.status()))

  router.post(p('/server/start'), async (req, res) => {
    const body = await readJsonBody<{
      host?: string
      port?: number
      prefix?: string
      api_key?: string
      trusted_hosts?: string[]
      proxy_timeout_secs?: number
      state_file?: boolean
      fallback_port?: boolean
    }>(req)
    const state = await deps.publicServer.start({
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.port !== undefined ? { port: body.port } : {}),
      ...(body.prefix !== undefined ? { prefix: body.prefix } : {}),
      ...(body.api_key !== undefined ? { apiKey: body.api_key } : {}),
      ...(body.trusted_hosts !== undefined ? { trustedHosts: body.trusted_hosts } : {}),
      ...(body.proxy_timeout_secs !== undefined ? { proxyTimeoutSecs: body.proxy_timeout_secs } : {}),
      ...(body.state_file !== undefined ? { writeStateFile: body.state_file === true } : {}),
      ...(body.fallback_port !== undefined ? { fallbackPort: body.fallback_port === true } : {}),
    })
    sendJson(res, 200, state)
  })

  router.post(p('/server/stop'), async (_req, res) => sendJson(res, 200, await deps.publicServer.stop()))

  router.put(p('/server/inspector'), async (req, res) => {
    const body = await readJsonBody<{ enabled?: unknown }>(req)
    if (typeof body.enabled !== 'boolean')
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'inspector needs {"enabled": true|false}')
      )
    deps.publicServer.setInspecting(body.enabled)
    sendJson(res, 200, { enabled: body.enabled })
  })
}
