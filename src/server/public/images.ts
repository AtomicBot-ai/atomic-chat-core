/**
 * `POST /v1/images/generations`: an OpenAI-shaped facade over the diffusion job runner, so a client
 * gets the same validation, events, gallery write and idle timer as the Images page. Only `b64_json`
 * is served (there is no URL to hand out), and the loaded model is the only model: image models are
 * deliberately absent from `/v1/models`. Port of the app's `images_route.rs` (commit `767ff6350`).
 */

import type { ImageGenerateRequest } from '../../contracts/index.js'
import { answer, clientGone, invalidJsonMessage } from './exchange.js'
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
import { readBody } from './wire.js'

/** The facade's own ceiling; the runner's six-hour ceiling is for the Images page, which shows progress. */
export const IMAGES_TIMEOUT_MS = 30 * 60 * 1000
export const NO_MODEL_MESSAGE = 'No image model loaded. Load an image model in Atomic Chat first.'
export const IMAGES_BACKEND_LABEL = 'atomic-diffusion'

const JSON_HEADERS: Array<[string, string]> = [['Content-Type', 'application/json']]

function fail(ex: Exchange, status: number, body: string, errorKind: string): void {
  ex.trace.errorKind = errorKind
  answer(ex, status, body, JSON_HEADERS)
}

export async function serveImagesGenerations(ex: Exchange, timeoutMs = IMAGES_TIMEOUT_MS): Promise<void> {
  const { trace, deps } = ex
  let parsed: unknown
  try {
    parsed = JSON.parse((ex.body ?? (await readBody(ex.req))).toString('utf8'))
  } catch (e) {
    return fail(ex, 400, errorBody(invalidJsonMessage(e), 'invalid_request_error', null, null), 'bad_request')
  }
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
  const images = deps.images as NonNullable<typeof deps.images>

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
      },
    })
    answer(ex, 200, body, JSON_HEADERS)
  } finally {
    clearTimeout(timer)
    gone.removeEventListener('abort', onGone)
  }
}
