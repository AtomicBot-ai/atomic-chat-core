/** llama.cpp backend packs and the download tasks that install them. */

import { AtomicCoreError } from '../../../contracts/index.js'
import type { OptimalBackendCacheRecord } from '../../../backend/index.js'
import type { ProxyConfig } from '../../../downloads/index.js'
import { queryOf, readJsonBody, sendError, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerBackendRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx

  router.get(p('/backends/:provider'), async (req, res, { params }) => {
    const current = queryOf(req).get('current') ?? ''
    sendJson(res, 200, {
      backends: await deps.backends.list(params['provider'] as string, current),
    })
  })

  // The task id comes from the caller, because the app's progress bar listens on an event named
  // after it. A core-invented id would leave that bar stranded.
  router.post(p('/backends/:provider/install'), async (req, res, { params }) => {
    const body = await readJsonBody<{
      version?: string
      backend?: string
      task_id?: string
      force?: boolean
      proxy?: ProxyConfig | null
      /** TurboQuant: the asset name the release index gives this pair. */
      asset_name?: string
    }>(req)
    if (!body.version || !body.backend || !body.task_id)
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'install needs version, backend and task_id')
      )
    sendJson(
      res,
      200,
      await deps.backends.install(params['provider'] as string, body.version, body.backend, {
        taskId: body.task_id,
        ...(body.force !== undefined ? { force: body.force } : {}),
        ...(body.proxy !== undefined ? { proxy: body.proxy } : {}),
        ...(typeof body.asset_name === 'string' && body.asset_name ? { assetName: body.asset_name } : {}),
      })
    )
  })

  // Where the detection result lives now. The CLI could not see the webview's `localStorage`;
  // this route gives both clients one revisioned answer. Hardware-change invalidation is separate.
  router.get(p('/backends/:provider/optimal'), async (_req, res, { params }) => {
    sendJson(res, 200, await deps.backends.getOptimal(params['provider'] as string))
  })

  router.put(p('/backends/:provider/optimal'), async (req, res, { params }) => {
    const body = await readJsonBody<{
      optimal?: OptimalBackendCacheRecord | null
      expected_revision?: number
    }>(req)
    if (!Object.hasOwn(body, 'optimal') || body.expected_revision === undefined) {
      return sendError(
        res,
        new AtomicCoreError('INVALID_ARGUMENT', 'optimal and expected_revision are required')
      )
    }
    const result = await deps.backends.setOptimal(
      params['provider'] as string,
      body.optimal ?? null,
      body.expected_revision
    )
    sendJson(res, result.status === 'conflict' ? 409 : 200, result)
  })

  router.post(p('/downloads/*taskId/cancel'), (_req, res, { params }) => {
    sendJson(res, 200, { cancelled: deps.backends.cancel(params['taskId'] as string) })
  })

  router.delete(p('/backends/:provider/:version/:backend'), async (_req, res, { params }) => {
    sendJson(res, 200, {
      removed: await deps.backends.remove(
        params['provider'] as string,
        params['version'] as string,
        params['backend'] as string
      ),
    })
  })
}
