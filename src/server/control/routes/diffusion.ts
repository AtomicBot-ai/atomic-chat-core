/**
 * Image generation: one route per operation of the app's `DiffusionService`, in its camelCase
 * (ADR 2026-09-17-diffusion-speaks-the-apps-camelcase-and-error-codes-verbatim). File-system paths
 * travel in bodies, never in the URL. Lists and lookups that may be empty are wrapped
 * (`{backends}`, `{files}`, `{job}`, `{item}`) so a `null` never stands alone as a body.
 */

import {
  parseDiffusionConfig,
  parseFinalizeArgs,
  parseGalleryFlags,
  parseGalleryListOptions,
  parseImageGenerateRequest,
  parseLoadModelRequest,
  requireString,
  requireStringList,
} from '../../../diffusion/index.js'
import { queryOf, readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

/** A generation request may carry a source image, a mask and references inline as base64. */
export const MAX_GENERATE_BODY_BYTES = 64 * 1024 * 1024

export function registerDiffusionRoutes(
  router: Router,
  deps: ControlServerDeps,
  ctx: ControlRouteContext
): void {
  const { p } = ctx
  const { diffusion } = deps

  // --- configuration and status --------------------------------------------------------------
  router.put(p('/diffusion/config'), async (req, res) =>
    sendJson(res, 200, await diffusion.configure(parseDiffusionConfig(await readJsonBody(req))))
  )
  router.get(p('/diffusion/status'), async (_req, res) => sendJson(res, 200, await diffusion.getStatus()))
  router.put(p('/diffusion/output-dir'), async (req, res) =>
    sendJson(res, 200, await diffusion.setOutputDir(requireString(await readJsonBody(req), 'path')))
  )

  // --- engine binary ---------------------------------------------------------------------------
  router.post(p('/diffusion/backends/finalize'), async (req, res) =>
    sendJson(res, 200, await diffusion.finalizeBackendInstall(parseFinalizeArgs(await readJsonBody(req))))
  )
  router.get(p('/diffusion/backends'), async (_req, res) =>
    sendJson(res, 200, { backends: await diffusion.listInstalledBackends() })
  )
  router.post(p('/diffusion/backends/remove'), async (req, res) => {
    await diffusion.removeBackend(requireString(await readJsonBody(req), 'dir'))
    sendJson(res, 200, {})
  })

  // --- model files -----------------------------------------------------------------------------
  router.get(p('/diffusion/model-files'), async (_req, res) =>
    sendJson(res, 200, { files: await diffusion.listModelFiles() })
  )
  router.post(p('/diffusion/model-files/delete'), async (req, res) => {
    await diffusion.deleteModelFile(requireString(await readJsonBody(req), 'path'))
    sendJson(res, 200, {})
  })

  // --- session ---------------------------------------------------------------------------------
  router.post(p('/diffusion/model/load'), async (req, res) =>
    sendJson(res, 200, await diffusion.loadModel(parseLoadModelRequest(await readJsonBody(req))))
  )
  router.post(p('/diffusion/model/unload'), async (_req, res) => {
    await diffusion.unloadModel()
    sendJson(res, 200, {})
  })
  router.get(p('/diffusion/capabilities'), (_req, res) => sendJson(res, 200, diffusion.getCapabilities()))
  router.post(p('/diffusion/idle/touch'), (_req, res) => {
    diffusion.touchIdle()
    sendJson(res, 200, {})
  })

  // --- jobs ------------------------------------------------------------------------------------
  router.post(p('/diffusion/jobs'), async (req, res) =>
    sendJson(
      res,
      200,
      await diffusion.generate(parseImageGenerateRequest(await readJsonBody(req, MAX_GENERATE_BODY_BYTES)))
    )
  )
  router.get(p('/diffusion/jobs/:jobId'), (_req, res, { params }) =>
    sendJson(res, 200, { job: diffusion.getJob(params['jobId'] as string) })
  )
  router.post(p('/diffusion/jobs/:jobId/cancel'), async (_req, res, { params }) =>
    sendJson(res, 200, await diffusion.cancelJob(params['jobId'] as string))
  )

  // --- gallery ---------------------------------------------------------------------------------
  router.get(p('/diffusion/gallery'), async (req, res) => {
    const query = queryOf(req)
    const includeArchived = query.get('includeArchived')
    // An absent or empty number is not zero.
    const number = (value: string | null) => (value === null || value === '' ? Number.NaN : Number(value))
    const options = parseGalleryListOptions({
      offset: number(query.get('offset')),
      limit: number(query.get('limit')),
      ...(includeArchived === null ? {} : { includeArchived: includeArchived === 'true' }),
    })
    sendJson(res, 200, await diffusion.listGallery(options))
  })
  router.get(p('/diffusion/gallery/:id'), async (_req, res, { params }) =>
    sendJson(res, 200, { item: await diffusion.getGalleryItem(params['id'] as string) })
  )
  router.post(p('/diffusion/gallery/delete'), async (req, res) => {
    await diffusion.deleteGalleryItems(requireStringList(await readJsonBody(req), 'ids'))
    sendJson(res, 200, {})
  })
  router.patch(p('/diffusion/gallery/:id/flags'), async (req, res, { params }) =>
    sendJson(
      res,
      200,
      await diffusion.setGalleryFlags(params['id'] as string, parseGalleryFlags(await readJsonBody(req)))
    )
  )
  router.post(p('/diffusion/gallery/:id/export'), async (req, res, { params }) => {
    await diffusion.exportGalleryItem(
      params['id'] as string,
      requireString(await readJsonBody(req), 'targetPath')
    )
    sendJson(res, 200, {})
  })
}
