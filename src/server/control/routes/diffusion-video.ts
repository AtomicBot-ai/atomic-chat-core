/**
 * Video generation: the video half of the diffusion control surface, one route per operation, in
 * the same camelCase as the image routes and with the same envelopes (`{job}`, `{item}`) so a
 * `null` never stands alone. File-system paths travel in bodies, never in the URL.
 */

import {
  parseGalleryFlags,
  parseVideoGenerateRequest,
  parseVideoPoster,
  requireString,
  requireStringList,
} from '../../../diffusion/index.js'
import { readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'
import { galleryListOptionsFromQuery, MAX_GENERATE_BODY_BYTES } from './diffusion.js'

/** A poster is a small PNG as base64; the JSON around it is nothing. */
export const MAX_POSTER_BODY_BYTES = 24 * 1024 * 1024

export function registerDiffusionVideoRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const { diffusion } = deps

  router.get(p('/diffusion/video/capabilities'), (_req, res) =>
    sendJson(res, 200, diffusion.getVideoCapabilities())
  )

  // --- jobs ------------------------------------------------------------------------------------
  router.post(p('/diffusion/video/jobs'), async (req, res) =>
    sendJson(
      res,
      200,
      await diffusion.generateVideo(
        parseVideoGenerateRequest(await readJsonBody(req, MAX_GENERATE_BODY_BYTES))
      )
    )
  )
  router.get(p('/diffusion/video/jobs/:jobId'), (_req, res, { params }) =>
    sendJson(res, 200, { job: diffusion.getVideoJob(params['jobId'] as string) })
  )
  router.post(p('/diffusion/video/jobs/:jobId/cancel'), async (_req, res, { params }) =>
    sendJson(res, 200, await diffusion.cancelVideoJob(params['jobId'] as string))
  )

  // --- gallery ---------------------------------------------------------------------------------
  router.get(p('/diffusion/video/gallery'), async (req, res) =>
    sendJson(res, 200, await diffusion.listVideoGallery(galleryListOptionsFromQuery(req)))
  )
  router.get(p('/diffusion/video/gallery/:id'), async (_req, res, { params }) =>
    sendJson(res, 200, { item: await diffusion.getVideoGalleryItem(params['id'] as string) })
  )
  router.post(p('/diffusion/video/gallery/delete'), async (req, res) => {
    await diffusion.deleteVideoGalleryItems(requireStringList(await readJsonBody(req), 'ids'))
    sendJson(res, 200, {})
  })
  router.patch(p('/diffusion/video/gallery/:id/flags'), async (req, res, { params }) =>
    sendJson(
      res,
      200,
      await diffusion.setVideoGalleryFlags(params['id'] as string, parseGalleryFlags(await readJsonBody(req)))
    )
  )
  router.post(p('/diffusion/video/gallery/:id/export'), async (req, res, { params }) => {
    await diffusion.exportVideoGalleryItem(
      params['id'] as string,
      requireString(await readJsonBody(req), 'targetPath')
    )
    sendJson(res, 200, {})
  })
  router.put(p('/diffusion/video/gallery/:id/poster'), async (req, res, { params }) =>
    sendJson(
      res,
      200,
      await diffusion.setVideoPoster(
        params['id'] as string,
        parseVideoPoster(await readJsonBody(req, MAX_POSTER_BODY_BYTES))
      )
    )
  )
}
