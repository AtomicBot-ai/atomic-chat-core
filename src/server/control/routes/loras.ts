import { AtomicCoreError } from '../../../contracts/index.js'
import { fileId, repoId } from '../../../drafters/catalog.js'
import { isLoraMode } from '../../../drafters/lora-catalog.js'
import { queryOf, readJsonBody, sendJson, type Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'
export function registerLoraRoutes(router: Router, deps: ControlServerDeps, { p }: ControlRouteContext) {
  const service = deps.loras
  if (!service) return
  router.get(p('/loras'), async (_req, res) => sendJson(res, 200, await service.list()))
  router.get(p('/loras/search'), async (req, res) => {
    const params = queryOf(req)
    const target = params.get('target') ?? undefined
    if (target && !repoId(target)) throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid target checkpoint.')
    sendJson(res, 200, await service.search(params.get('q') ?? '', target, params.get('live') === '1'))
  })
  router.post(p('/loras/:id/install'), async (_req, res, { params }) => {
    await service.install(params.id!)
    sendJson(res, 200, { ok: true })
  })
  router.post(p('/loras/:id/cancel'), (_req, res, { params }) =>
    sendJson(res, 200, { cancelled: service.cancel(params.id!) })
  )
  router.delete(p('/loras/:id'), async (_req, res, { params }) => {
    await service.remove(params.id!)
    sendJson(res, 200, { ok: true })
  })
  const path = p('/loras/choices/:mode/*model')
  router.get(path, async (_req, res, { params }) => {
    if (!isLoraMode(params.mode)) throw new AtomicCoreError('INVALID_ARGUMENT', 'Invalid LoRA mode.')
    sendJson(res, 200, await service.choices(params.mode, params.model!))
  })
  router.put(path, async (req, res, { params }) => {
    const body = await readJsonBody<{ adapterId: unknown }>(req)
    if (!isLoraMode(params.mode) || (body?.adapterId !== null && !fileId(body?.adapterId)))
      throw new AtomicCoreError('INVALID_ARGUMENT', 'Provide a mode and adapter ID or null.')
    await service.select(params.mode, params.model!, body.adapterId)
    sendJson(res, 200, { ok: true })
  })
}
