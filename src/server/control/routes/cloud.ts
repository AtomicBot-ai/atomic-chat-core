/** Cloud providers and the ChatGPT subscription sign-in. */

import type { CloudProviderInput } from '../../../cloud/index.js'
import { AtomicCoreError } from '../../../contracts/index.js'
import { readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerCloudRoutes(router: Router, deps: ControlServerDeps, ctx: ControlRouteContext): void {
  const { p } = ctx

  router.get(p('/cloud/providers'), (_req, res) => sendJson(res, 200, { providers: deps.cloud.list() }))

  router.put(p('/cloud/providers/:provider'), async (req, res, { params }) => {
    const body = await readJsonBody<Omit<CloudProviderInput, 'provider'>>(req)
    sendJson(res, 200, await deps.cloud.upsert({ ...body, provider: params['provider'] as string }))
  })

  router.delete(p('/cloud/providers/:provider'), async (_req, res, { params }) => {
    await deps.cloud.remove(params['provider'] as string)
    sendJson(res, 200, { removed: true })
  })

  router.get(p('/auth/chatgpt'), async (_req, res) => sendJson(res, 200, await deps.chatgpt.status()))

  router.post(p('/auth/chatgpt/reload'), async (_req, res) => {
    if (!deps.chatgpt.reload)
      return sendError(res, new AtomicCoreError('INVALID_ARGUMENT', 'reload is unavailable'))
    sendJson(res, 200, await deps.chatgpt.reload())
  })

  // Sign-in is two calls because the core cannot open a browser: this one binds the callback
  // listener on :1455 and says where to send the user, `/login/wait` resolves when they are back.
  router.post(p('/auth/chatgpt/login'), async (_req, res) =>
    sendJson(res, 200, await deps.chatgpt.startLogin())
  )

  router.post(p('/auth/chatgpt/login/wait'), async (_req, res) =>
    sendJson(res, 200, await deps.chatgpt.waitLogin())
  )

  router.post(p('/auth/chatgpt/login/cancel'), (_req, res) => {
    deps.chatgpt.cancelLogin()
    sendJson(res, 200, { cancelled: true })
  })

  router.post(p('/auth/chatgpt/logout'), async (_req, res) => sendJson(res, 200, await deps.chatgpt.logout()))

  router.get(p('/auth/chatgpt/models'), async (_req, res) =>
    sendJson(res, 200, { models: await deps.chatgpt.models() })
  )
}
