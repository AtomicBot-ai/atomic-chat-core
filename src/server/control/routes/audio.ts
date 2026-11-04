/**
 * Audio generation on audio.cpp (`src/audio/`), in image generation's camelCase. File-system paths
 * travel in bodies, never in the URL. Lists and lookups that may be empty are wrapped (`{files}`,
 * `{job}`) so a `null` never stands alone as a body. The engine binary is installed, listed and
 * removed through `/engine-builds/audio-cpp/…`.
 */

import {
  parseAudioConfig,
  parseAudioGalleryListOptions,
  parseAudioJobSubmission,
  parseLoadAudioModelRequest,
  requireAudioString,
} from '../../../audio/index.js'
import type { IncomingMessage } from 'node:http'
import type { AudioGalleryListOptions } from '../../../contracts/index.js'
import { queryOf, readJsonBody, sendJson } from '../../http.js'
import type { Router } from '../../http.js'
import type { ControlRouteContext, ControlServerDeps } from '../types.js'

/** A speech job may carry a reference voice of up to 5 MiB inline as base64. */
export const MAX_AUDIO_JOB_BODY_BYTES = 8 * 1024 * 1024

/** `?offset&limit` as the gallery listing takes them; absent, the first 50. */
export function audioGalleryOptionsFromQuery(req: IncomingMessage): AudioGalleryListOptions {
  const query = queryOf(req)
  // An empty number is not zero.
  const number = (value: string | null, fallback: number) =>
    value === null ? fallback : value === '' ? Number.NaN : Number(value)
  return parseAudioGalleryListOptions({
    offset: number(query.get('offset'), 0),
    limit: number(query.get('limit'), 50),
  })
}

export function registerAudioRoutes(router: Router, deps: ControlServerDeps, ctx: ControlRouteContext): void {
  const { p } = ctx
  const { audio } = deps

  // --- configuration and status --------------------------------------------------------------
  router.get(p('/audio/status'), async (_req, res) => sendJson(res, 200, await audio.status()))
  router.put(p('/audio/config'), async (req, res) =>
    sendJson(res, 200, await audio.config(parseAudioConfig(await readJsonBody(req))))
  )
  router.put(p('/audio/output-dir'), async (req, res) =>
    sendJson(res, 200, await audio.setOutputDir(requireAudioString(await readJsonBody(req), 'path')))
  )

  // --- model files -----------------------------------------------------------------------------
  router.get(p('/audio/model-files'), async (_req, res) =>
    sendJson(res, 200, { files: await audio.listModelFiles() })
  )
  router.delete(p('/audio/model-files'), async (req, res) => {
    await audio.deleteModelFile(requireAudioString(await readJsonBody(req), 'relativePath'))
    sendJson(res, 200, {})
  })

  // --- session ---------------------------------------------------------------------------------
  router.post(p('/audio/model/load'), async (req, res) =>
    sendJson(res, 200, await audio.loadModel(parseLoadAudioModelRequest(await readJsonBody(req))))
  )
  router.post(p('/audio/model/unload'), async (_req, res) => {
    await audio.unloadModel()
    sendJson(res, 200, {})
  })
  router.post(p('/audio/idle/touch'), (_req, res) => {
    audio.touchIdle()
    sendJson(res, 200, {})
  })
  router.get(p('/audio/capabilities'), (_req, res) => sendJson(res, 200, audio.capabilities()))

  // --- jobs ------------------------------------------------------------------------------------
  router.post(p('/audio/jobs'), async (req, res) => {
    const { mode, request } = parseAudioJobSubmission(await readJsonBody(req, MAX_AUDIO_JOB_BODY_BYTES))
    sendJson(res, 200, await audio.generate(mode, request))
  })
  router.get(p('/audio/jobs/:jobId'), (_req, res, { params }) =>
    sendJson(res, 200, { job: audio.getJob(params['jobId'] as string) })
  )
  router.post(p('/audio/jobs/:jobId/cancel'), async (_req, res, { params }) =>
    sendJson(res, 200, await audio.cancelJob(params['jobId'] as string))
  )

  // --- gallery ---------------------------------------------------------------------------------
  router.get(p('/audio/gallery'), async (req, res) =>
    sendJson(res, 200, await audio.gallery(audioGalleryOptionsFromQuery(req)))
  )
  router.delete(p('/audio/gallery/:id'), async (_req, res, { params }) => {
    await audio.deleteGalleryItem(params['id'] as string)
    sendJson(res, 200, {})
  })
}
