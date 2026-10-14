/**
 * `POST /v1/images/generations`: an OpenAI-shaped facade over the diffusion job runner, so a client
 * gets the same validation, events, gallery write and idle timer as the Images page. Only `b64_json`
 * is served (there is no URL to hand out), and the loaded model is the only local model: image models
 * are deliberately absent from `/v1/models`. Port of the app's `images_route.rs` (commit `767ff6350`).
 *
 * A `model` that names an enabled image model of a cloud or self-hosted provider is served by that
 * provider through the same runner (ADR 2026-10-13-remote-media-shares-the-diffusion-job-table), and
 * so is `POST /v1/images/edits`, which only remote models answer, in its JSON form.
 */

import type { ImageGenerateRequest, MediaTarget } from '../../contracts/index.js'
import { answer, clientGone, header, invalidJsonMessage } from './exchange.js'
import type { Exchange } from './exchange.js'
import {
  buildRequest,
  errorBody,
  errorKindFor,
  mapError,
  modelMatches,
  ParamError,
  parseParams,
} from './images-params.js'
import { buildRemoteImageRequest, parseRemoteImageParams } from './remote-media.js'
import type { ImagesBackend } from './types.js'
import { readBody } from './wire.js'

/** The facade's own ceiling; the runner's six-hour ceiling is for the Images page, which shows progress. */
export const IMAGES_TIMEOUT_MS = 30 * 60 * 1000
export const NO_MODEL_MESSAGE = 'No image model loaded. Load an image model in Atomic Chat first.'
export const IMAGES_BACKEND_LABEL = 'atomic-diffusion'
/** The trace's backend for a provider's model. */
export const REMOTE_MEDIA_BACKEND_LABEL = 'remote-media'
export const NO_REMOTE_MODEL_MESSAGE =
  'No enabled image model of a connected provider has that name. Enable one on the Cloud page.'

const JSON_HEADERS: Array<[string, string]> = [['Content-Type', 'application/json']]

function fail(ex: Exchange, status: number, body: string, errorKind: string): void {
  ex.trace.errorKind = errorKind
  answer(ex, status, body, JSON_HEADERS)
}

/** The `model` a body names, when it names one. */
function modelOf(body: unknown): string | undefined {
  const model =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>)['model']
      : undefined
  return typeof model === 'string' && model.trim() !== '' ? model.trim() : undefined
}

/** The provider and model a body's `model` names among the enabled remote image models. */
function remoteTarget(images: ImagesBackend | undefined, body: unknown): MediaTarget | undefined {
  const model = modelOf(body)
  return model === undefined ? undefined : images?.find?.(model)
}

async function readJson(ex: Exchange): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: JSON.parse((ex.body ?? (await readBody(ex.req))).toString('utf8')) }
  } catch (e) {
    fail(ex, 400, errorBody(invalidJsonMessage(e), 'invalid_request_error', null, null), 'bad_request')
    return { ok: false }
  }
}

/** Run a remote image request through the shared runner and answer like the local path does. */
async function serveRemote(
  ex: Exchange,
  body: unknown,
  target: MediaTarget,
  mode: 'generations' | 'edits',
  timeoutMs: number
): Promise<void> {
  const images = ex.deps.images as ImagesBackend
  ex.trace.modelId = target.model
  ex.trace.backend = REMOTE_MEDIA_BACKEND_LABEL
  let request: ImageGenerateRequest
  try {
    request = await buildRemoteImageRequest(parseRemoteImageParams(body, mode), target)
  } catch (e) {
    if (!(e instanceof ParamError)) {
      const error = e as { code?: string; message: string }
      return fail(ex, 400, errorBody(error.message, 'invalid_request_error', null, 'mask'), 'bad_request')
    }
    return fail(ex, 400, errorBody(e.message, 'invalid_request_error', null, e.param), 'bad_request')
  }
  return runToAnswer(ex, images, request, timeoutMs, { provider: target.provider })
}

/** `POST /v1/images/edits`: JSON only, and only a remote model edits here. */
export async function serveImagesEdits(ex: Exchange, timeoutMs = IMAGES_TIMEOUT_MS): Promise<void> {
  const type = header(ex.req, 'content-type') ?? ''
  if (/multipart\/form-data/i.test(type))
    return fail(
      ex,
      415,
      errorBody(
        'Send the edit as JSON: {model, prompt, images: [{image_url: "data:image/png;base64,..."}], mask?}.',
        'invalid_request_error',
        'unsupported_media_type',
        null
      ),
      'bad_request'
    )
  const read = await readJson(ex)
  if (!read.ok) return
  const target = remoteTarget(ex.deps.images, read.body)
  if (!target)
    return fail(
      ex,
      404,
      errorBody(NO_REMOTE_MODEL_MESSAGE, 'invalid_request_error', 'model_not_found', 'model'),
      'not_found'
    )
  return serveRemote(ex, read.body, target, 'edits', timeoutMs)
}

export async function serveImagesGenerations(ex: Exchange, timeoutMs = IMAGES_TIMEOUT_MS): Promise<void> {
  const { trace, deps } = ex
  const read = await readJson(ex)
  if (!read.ok) return
  const parsed = read.body
  const target = remoteTarget(deps.images, parsed)
  if (target) return serveRemote(ex, parsed, target, 'generations', timeoutMs)
  let request: ImageGenerateRequest
  let loaded: ReturnType<NonNullable<typeof deps.images>['loaded']>
  try {
    const params = parseParams(parsed)
    // The format check runs before the model check: a `url` request is a 400 even with nothing loaded.
    trace.modelId = params.model ?? null
    loaded = deps.images?.loaded()
    if (!loaded || !modelMatches(params.model, loaded))
      return fail(ex, 503, errorBody(NO_MODEL_MESSAGE, 'server_error', 'model_not_loaded', null), 'not_found')
    request = buildRequest(params, loaded.defaults)
  } catch (e) {
    if (!(e instanceof ParamError)) throw e
    return fail(ex, 400, errorBody(e.message, 'invalid_request_error', null, e.param), 'bad_request')
  }
  trace.modelId = loaded.modelId
  trace.backend = IMAGES_BACKEND_LABEL
  return runToAnswer(ex, deps.images as ImagesBackend, request, timeoutMs)
}

/** Start the job, wait for it (the client leaving or the ceiling cancels it), and answer its images. */
async function runToAnswer(
  ex: Exchange,
  images: ImagesBackend,
  request: ImageGenerateRequest,
  timeoutMs: number,
  extra: Record<string, unknown> = {}
): Promise<void> {
  let started: Awaited<ReturnType<typeof images.start>>
  try {
    started = await images.start(request)
  } catch (raw) {
    const error = raw as { code?: string; message: string; details?: string }
    const mapped = mapError((error.code ?? 'INTERNAL') as Parameters<typeof mapError>[0])
    const message =
      mapped.status === 400 && error.details ? `${error.message} (${error.details})` : error.message
    return fail(
      ex,
      mapped.status,
      errorBody(message, mapped.type, mapped.code, null),
      errorKindFor(mapped.status)
    )
  }

  // The client going away cancels the job, and so does the ceiling: nobody is waiting for it.
  const gone = clientGone(ex)
  const onGone = () => void images.cancel(started.id)
  gone.addEventListener('abort', onGone, { once: true })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const result = await Promise.race([started.done, timeout])
    if (result === 'timeout') {
      void images.cancel(started.id)
      const minutes = Math.round(timeoutMs / 60_000)
      return fail(
        ex,
        504,
        errorBody(
          `Generation did not finish within ${minutes} minutes and was cancelled.`,
          'server_error',
          'timeout',
          null
        ),
        'timeout'
      )
    }
    if (!result.ok) {
      const mapped = mapError(result.error.code)
      const message = result.error.details
        ? `${result.error.message}\n${result.error.details}`
        : result.error.message
      return fail(
        ex,
        mapped.status,
        errorBody(message, mapped.type, mapped.code, null),
        errorKindFor(mapped.status)
      )
    }
    const { job, images: pngs } = result.outcome
    const body = JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: pngs.map((png) => ({ b64_json: png.toString('base64') })),
      atomic: {
        job_id: job.id,
        seed: job.outputs[0]?.recipe.batchSeed ?? null,
        paths: job.outputs.map((output) => output.path),
        ...extra,
      },
    })
    answer(ex, 200, body, JSON_HEADERS)
  } finally {
    clearTimeout(timer)
    gone.removeEventListener('abort', onGone)
  }
}
