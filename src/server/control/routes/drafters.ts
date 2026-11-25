import { AtomicCoreError } from '../../../contracts/index.js'
import { repoId } from '../../../drafters/index.js'
import { queryOf, readJsonBody, sendJson, type Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

export function registerDrafterRoutes(router: Router, deps: ControlServerDeps, { p }: ControlRouteContext) {
  const service = deps.drafters
  if (!service) return
  router.get(p('/drafters'), async (_req, res) => sendJson(res, 200, await service.list()))
  router.get(p('/drafters/search'), async (req, res) => {
    const q = queryOf(req)
    const source = q.get('source') ?? undefined
    const target = q.get('target') ?? undefined
    if ((source && !repoId(source)) || (target && !repoId(target)))
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid checkpoint.')
    const variants = q.get('variants')
    if (variants) {
      if (!repoId(variants) || !target)
        throw new AtomicCoreError('INVALID_ARGUMENT', 'Provide a repository and target for GGUF variants.')
      return sendJson(res, 200, await service.variants(variants, target))
    }
    sendJson(
      res,
      200,
      await service.search(
        source,
        q.get('q') ?? '',
        q.get('live') === '1',
        target,
        Math.max(0, Number.parseInt(q.get('page') ?? '0') || 0)
      )
    )
  })
  router.post(p('/drafters/:id/install'), async (_req, res, { params }) => {
    await service.install(params.id!)
    sendJson(res, 200, { ok: true })
  })
  router.post(p('/drafters/:id/cancel'), (_req, res, { params }) =>
    sendJson(res, 200, { cancelled: service.cancel(params.id!) })
  )
  router.delete(p('/drafters/:id'), async (_req, res, { params }) => {
    await service.remove(params.id!)
    sendJson(res, 200, { ok: true })
  })
  const path = p('/models/llamacpp-upstream/*modelId/drafter')
  router.get(p('/models/llamacpp-upstream/*modelId/drafter/selection'), async (_req, res, { params }) =>
    sendJson(res, 200, await service.selection(params.modelId!))
  )
  router.get(path, async (_req, res, { params }) =>
    sendJson(res, 200, await service.choices(params.modelId!))
  )
  router.put(path, async (req, res, { params }) => {
    const body = await readJsonBody<{ id: unknown }>(req)
    if (body?.id !== null && typeof body?.id !== 'string')
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Provide a drafter ID or null.')
    await service.select(params.modelId!, body.id)
    sendJson(res, 200, { ok: true })
  })
}
