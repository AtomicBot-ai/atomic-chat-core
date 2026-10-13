/**
 * Remote media (ADR 2026-10-13-remote-media-shares-the-diffusion-job-table): the catalog of image
 * and video models cloud providers and self-hosted servers offer, and one provider's models with its
 * live listing merged in. snake_case like the cloud provider routes and conf's catalog. Generation
 * itself goes through `/diffusion/jobs` and `/diffusion/video/jobs` with a `target`.
 */

import { AtomicCoreError } from '../../../contracts/index.js'
import { queryOf, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps, MediaControl } from '../types.js'

function control(deps: ControlServerDeps): MediaControl {
  if (!deps.media)
    throw new AtomicCoreError('REMOTE_NOT_CONFIGURED', 'Remote media is not available in this core.')
  return deps.media
}

export function registerMediaRoutes(router: Router, deps: ControlServerDeps, ctx: ControlRouteContext): void {
  const { p } = ctx

  router.get(p('/media/catalog'), async (_req, res) => sendJson(res, 200, await control(deps).catalog()))

  router.get(p('/media/providers/:provider/models'), async (req, res, { params }) => {
    const kind = queryOf(req).get('kind')
    if (kind !== 'image' && kind !== 'video')
      throw new AtomicCoreError('INVALID_ARGUMENT', "kind must be 'image' or 'video'")
    sendJson(res, 200, await control(deps).providerModels(params['provider'] as string, kind))
  })
}
