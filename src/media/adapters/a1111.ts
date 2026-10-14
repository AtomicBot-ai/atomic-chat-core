/**
 * `a1111`: the Automatic1111 web UI API (`--api`) and the forks that keep it — Forge and Forge Neo.
 * A self-hosted server, usually keyless, registered at its root (`http://127.0.0.1:7860`); a base
 * entered with a trailing `/sdapi/v1` or `/v1` is cut back to the root, and every route below is
 * `{root}/sdapi/v1/...`.
 *
 * - `create` → `POST /sdapi/v1/txt2img`; `transform` and `inpaint` → `POST /sdapi/v1/img2img` with
 *   the source as `init_images` and, for `inpaint`, the mask as is (white repaints there too).
 *   The checkpoint is picked per request (`override_settings.sd_model_checkpoint`), `n` images are
 *   one batch, and the images come back as base64 PNGs.
 * - While a generation runs, `GET /sdapi/v1/progress` is polled about once a second for the
 *   fraction; cancelling the job sends `POST /sdapi/v1/interrupt`, best effort.
 * - Listing: `GET /sdapi/v1/sd-models` (its `title` is what `sd_model_checkpoint` takes) and
 *   `GET /sdapi/v1/samplers` (missing on some forks; then no samplers are listed).
 *
 * Basic auth (`--api-auth user:pass`) is a custom `Authorization` header, or the registration's key
 * as `user:pass`, sent as `Basic` only when no custom `Authorization` is set.
 */

import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  decodeBase64Image,
  GENERATE_TIMEOUT_MS,
  joinUrl,
  parseWxH,
  remoteError,
  remoteHttpError,
} from '../http.js'
import type { CallAnswer, CallOptions, MediaContext } from '../http.js'
import type { GeneratedImage, ImageAdapter, ImageGenerationJob, RemoteProgress } from './types.js'

type Fields = Record<string, unknown>

const asObject = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** How often the progress route is asked while a generation runs. */
const PROGRESS_INTERVAL_MS = 1000
/** A progress poll or an interrupt that takes longer than this is dropped. */
const SIDE_CALL_TIMEOUT_MS = 10_000

/** The server root: the registered base without trailing slashes, `/sdapi/v1` or `/v1`. */
export function a1111Root(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/(\/sdapi)?\/v1$/i, '')
}

/** `Basic <base64(key)>` from the registration's key, unless a custom `Authorization` is set. */
export function a1111Auth(ctx: Pick<MediaContext, 'apiKey' | 'customHeaders'>): Record<string, string> {
  const key = ctx.apiKey?.trim()
  if (!key || ctx.customHeaders.some(({ header }) => header.toLowerCase() === 'authorization')) return {}
  return { Authorization: `Basic ${Buffer.from(key, 'utf8').toString('base64')}` }
}

/** One call to the server: its own auth, and a 404 read as "no API here". */
async function a1111Call(ctx: MediaContext, path: string, options: CallOptions = {}): Promise<CallAnswer> {
  const accept = options.accept ?? []
  const answer = await callProvider(ctx, joinUrl(a1111Root(ctx.baseUrl), path), {
    ...options,
    auth: 'none',
    headers: { ...a1111Auth(ctx), ...options.headers },
    accept: accept.includes(404) ? accept : [...accept, 404],
  })
  if (answer.status === 404 && !accept.includes(404))
    throw remoteError(
      'REMOTE_NOT_CONFIGURED',
      `${ctx.provider} has no Automatic1111 API at this address; start the server with --api.`,
      `HTTP 404 ${path}`
    )
  return answer
}

/** The job's pixel size: the form's width and height, its `WxH`, else the model's default. */
function pixelSize(job: ImageGenerationJob): { width: number; height: number } | undefined {
  if (job.width && job.height) return { width: job.width, height: job.height }
  const listed = parseWxH(job.size)
  if (listed) return listed
  const size = job.model.params.size
  if (size?.kind === 'range' && size.default_width && size.default_height)
    return { width: size.default_width, height: size.default_height }
  return undefined
}

/** The `txt2img` / `img2img` body of a job. The source and the mask must be there for their workflows. */
export function a1111Body(job: ImageGenerationJob): Record<string, unknown> {
  const params = job.model.params
  const body: Record<string, unknown> = { prompt: job.prompt, negative_prompt: job.negativePrompt ?? '' }
  const size = pixelSize(job)
  if (size) Object.assign(body, size)
  const steps = job.steps ?? params.steps?.default
  if (steps !== undefined) body['steps'] = steps
  const cfg = job.cfgScale ?? params.cfg?.default
  if (cfg !== undefined) body['cfg_scale'] = cfg
  // Forge's distilled CFG (FLUX); the original A1111 ignores the field.
  if (job.guidance !== undefined) body['distilled_cfg_scale'] = job.guidance
  if (job.sampler) body['sampler_name'] = job.sampler
  body['seed'] = job.seed !== undefined && job.seed >= 0 ? Math.trunc(job.seed) : -1
  body['batch_size'] = Math.max(1, job.n)
  body['n_iter'] = 1
  body['override_settings'] = { sd_model_checkpoint: job.model.id }
  body['override_settings_restore_afterwards'] = true
  body['send_images'] = true
  body['save_images'] = false
  if (job.workflow === 'transform' || job.workflow === 'inpaint') {
    const source = job.images[0]
    if (!source) throw remoteError('REMOTE_UNSUPPORTED', 'This workflow needs a source image.', job.workflow)
    body['init_images'] = [source.bytes.toString('base64')]
    body['denoising_strength'] = job.strength ?? 0.75
  }
  if (job.workflow === 'inpaint') {
    if (!job.mask) throw remoteError('REMOTE_UNSUPPORTED', 'Inpainting needs a mask.', job.workflow)
    body['mask'] = job.mask.bytes.toString('base64')
    body['inpainting_fill'] = 1
    body['inpaint_full_res'] = false
    body['mask_blur'] = 4
  }
  return body
}

/** The images of an answer: `n` of them, without the grid a batch may put first. */
export function a1111Images(ctx: Pick<MediaContext, 'provider'>, json: unknown, n: number): GeneratedImage[] {
  const listed = (
    Array.isArray(asObject(json)['images']) ? (asObject(json)['images'] as unknown[]) : []
  ).filter((item): item is string => typeof item === 'string' && item !== '')
  const count = Math.max(1, n)
  const images = count > 1 && listed.length === count + 1 ? listed.slice(1) : listed
  const out = images.slice(0, count).map((payload) => decodeBase64Image(payload))
  if (out.length === 0) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without an image.`)
  return out
}

/** The checkpoints of `/sd-models`, each with the samplers of `/samplers`. */
export function liveModelsFromA1111(models: unknown, samplers: unknown): LiveMediaModel[] {
  const names = (Array.isArray(samplers) ? samplers : [])
    .map((item) => text(asObject(item)['name']))
    .filter((name): name is string => name !== undefined)
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(models) ? models : []) {
    const entry = asObject(item)
    const id = text(entry['title']) ?? text(entry['model_name'])
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: LiveMediaModel = { id, name: text(entry['model_name']) ?? id }
    if (names.length > 0) model.samplers = [...new Set(names)]
    out.push(model)
  }
  return out
}

/**
 * Polls the progress route until `finished` settles, reporting the fraction. Best effort: a failed
 * poll is skipped, a server without the route stops the polling.
 */
async function followProgress(
  ctx: MediaContext,
  finished: Promise<void>,
  report: (progress: RemoteProgress) => void
): Promise<void> {
  let over = false
  void finished.then(() => {
    over = true
  })
  for (;;) {
    const woke = await Promise.race([
      ctx.sleep(PROGRESS_INTERVAL_MS).then(
        () => true,
        () => false
      ),
      finished.then(() => false),
    ])
    if (!woke || over) return
    let answer: CallAnswer
    try {
      answer = await a1111Call(ctx, '/sdapi/v1/progress?skip_current_image=true', {
        accept: [404, 405],
        timeoutMs: SIDE_CALL_TIMEOUT_MS,
      })
    } catch {
      continue
    }
    if (over || answer.status === 404 || answer.status === 405) return
    const fraction = asObject(answer.json)['progress']
    if (typeof fraction === 'number' && Number.isFinite(fraction) && fraction > 0)
      report({ phase: 'generating', fraction: Math.min(fraction, 1) })
  }
}

/** Stops the server's current generation, best effort and without waiting. */
function interrupt(ctx: MediaContext): void {
  const quiet = { ...ctx, signal: new AbortController().signal }
  void a1111Call(quiet, '/sdapi/v1/interrupt', { method: 'POST', timeoutMs: SIDE_CALL_TIMEOUT_MS }).catch(
    () => undefined
  )
}

export const A1111: ImageAdapter = {
  dialect: 'a1111',
  kind: 'image',

  async listModels(ctx) {
    const models = await a1111Call(ctx, '/sdapi/v1/sd-models')
    const samplers = await a1111Call(ctx, '/sdapi/v1/samplers', { accept: [404] })
    return liveModelsFromA1111(models.json, samplers.status === 404 ? [] : samplers.json)
  },

  async generate(ctx, job, report) {
    report({ phase: 'generating' })
    if (job.workflow !== 'create' && job.workflow !== 'transform' && job.workflow !== 'inpaint')
      throw remoteError('REMOTE_UNSUPPORTED', 'Automatic1111 cannot do that workflow here.', job.workflow)
    const body = a1111Body(job)
    const route = job.workflow === 'create' ? '/sdapi/v1/txt2img' : '/sdapi/v1/img2img'
    const onAbort = (): void => interrupt(ctx)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
    try {
      const call = a1111Call(ctx, route, { json: body, timeoutMs: GENERATE_TIMEOUT_MS, accept: [500] })
      void followProgress(
        ctx,
        call.then(
          () => undefined,
          () => undefined
        ),
        report
      ).catch(() => undefined)
      const answer = await call
      if (answer.status === 500) {
        // A1111 puts the exception class in `error` and its words in `errors`.
        const fields = asObject(answer.json)
        const said = [text(fields['error']), text(fields['errors']) ?? text(fields['detail'])]
          .filter(Boolean)
          .join(': ')
        throw remoteHttpError(ctx.provider, 500, said ? { message: said } : answer.json, answer.text)
      }
      return a1111Images(ctx, answer.json, job.n)
    } finally {
      ctx.signal.removeEventListener('abort', onAbort)
    }
  },
}
