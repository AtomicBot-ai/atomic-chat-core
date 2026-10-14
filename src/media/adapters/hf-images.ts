/**
 * `hf-images`: Hugging Face Inference Providers through the HF router. The registered base is
 * `https://router.huggingface.co/v1`; the router root is that base without its trailing `/v1`, and
 * every request below goes to a path under it. Each catalog model names the provider that serves it
 * in `options.hf_provider`:
 *
 * - `hf-inference` (also a model without the option): `POST {router}/hf-inference/models/{model.id}`
 *   with `{inputs: prompt, parameters}` answers the image bytes, one image per call. `transform`
 *   sends the source as `inputs` (base64) and the prompt in `parameters.prompt`.
 * - `fal-ai`: fal's queue through the router, the way huggingface.js
 *   (`packages/inference/src/providers/fal-ai.ts`) does it: submit to
 *   `{router}/fal-ai/{options.provider_model}?_subdomain=queue`, poll the request's `/status`, then
 *   read the result (`{images: [{url}]}`). The images are on fal's CDN and are downloaded bare.
 *
 * The live listing is the Hub's public model search on `https://huggingface.co` — a different host,
 * asked only when the registered base is the real router, and without the key or custom headers.
 */

import type { AtomicCoreError } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  decodeBase64Image,
  downloadResult,
  GENERATE_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  networkError,
  parseWxH,
  pollUntil,
  providerHeaders,
  remoteError,
  remoteHttpError,
  sniffImageMime,
} from '../http.js'
import type { CallAnswer, MediaContext, PollOptions } from '../http.js'
import type { GeneratedImage, ImageAdapter, ImageGenerationJob, RemoteProgress } from './types.js'

type Fields = Record<string, unknown>

const asObject = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** The only host whose registration may ask the Hub for a listing. */
const ROUTER_HOST = 'router.huggingface.co'
/** The Hub's public model search: text-to-image models with their provider mapping. */
const HUB_LISTING_URL =
  'https://huggingface.co/api/models?inference_provider=all&pipeline_tag=text-to-image&sort=likes&limit=50&expand%5B%5D=inferenceProviderMapping'
/** The providers this adapter speaks, in the order a listed model prefers them. */
const HF_PROVIDERS = ['fal-ai', 'hf-inference'] as const

/** The router root: the registered base without trailing slashes and its `/v1`. */
function routerRoot(ctx: Pick<MediaContext, 'baseUrl'>): string {
  return ctx.baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, '')
}

/** A context for a request that must not stop with the job (a best-effort cancel after it fired). */
function detached(ctx: MediaContext): MediaContext {
  return { ...ctx, signal: new AbortController().signal }
}

// ---------------------------------------------------------------------------------------------
// fal-ai's queue through the HF router (shared with `hf-videos`)
// ---------------------------------------------------------------------------------------------

/**
 * One request in fal's queue, as {@link falSubmit} answered it. Plain data, so a video job can keep
 * it on disk and follow the request after a restart. The URLs are fal's own words
 * (`https://queue.fal.run/...`); only their paths are used — every request goes to the router
 * derived from `ctx.baseUrl` at call time, so a stored handle can never send the key elsewhere.
 */
export interface FalHandle {
  requestId: string
  /** fal's `status_url`, when it gave one. */
  statusUrl?: string
  /** fal's `response_url` (the result), when it gave one. */
  responseUrl?: string
  /** The fal model id the request went to (`fal-ai/flux/schnell`): the paths' fallback. */
  providerModel?: string
}

/** One look at a fal request. A failure carries the `REMOTE_*` error it maps to. */
export type FalStatus =
  | { state: 'queued'; position?: number }
  | { state: 'running' }
  | { state: 'completed' }
  | { state: 'failed'; error: AtomicCoreError }

/** How {@link falWait} polls: 1 s first, growing to 5 s, for at most 15 minutes. */
export const FAL_POLL: PollOptions = { intervalMs: 1000, maxIntervalMs: 5000, timeoutMs: 15 * 60_000 }

/** fal's hosts (`queue.fal.run`); a URL anywhere else is not one of fal's queue URLs. */
const FAL_HOST = /(^|\.)fal\.run$/i
/** Endpoint namespaces whose app id is three segments (`workflows/<owner>/<app>`), as fal's client parses them. */
const FAL_NAMESPACES = new Set(['workflows', 'comfy'])
/** A fal model id: path segments of plain characters. */
const FAL_MODEL_ID = /^[\w.-]+(\/[\w.-]+)+$/

/** The path of one of fal's queue URLs (also one already through this router), or `undefined`. */
function falPath(ctx: MediaContext, url: string | undefined): string | undefined {
  if (!url) return undefined
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol === 'https:' && FAL_HOST.test(parsed.hostname)) return parsed.pathname
  const viaRouter = `${routerRoot(ctx)}/fal-ai/`
  const plain = `${parsed.origin}${parsed.pathname}`
  return plain.startsWith(viaRouter) ? plain.slice(viaRouter.length - 1) : undefined
}

/**
 * The request's path in fal's queue (`/fal-ai/flux/requests/{id}`): from fal's result URL as
 * huggingface.js takes it, else from its status URL, else built the way fal's own client builds it
 * (the first two segments of the model id, three for a namespaced one).
 */
function requestPath(ctx: MediaContext, handle: FalHandle): string {
  const result = falPath(ctx, handle.responseUrl)
  if (result) return result.replace(/\/+$/, '')
  const status = falPath(ctx, handle.statusUrl)?.replace(/\/+$/, '')
  if (status?.endsWith('/status')) return status.slice(0, -'/status'.length)
  const parts = (handle.providerModel ?? '').split('/').filter((part) => part !== '')
  if (parts.length >= 2 && handle.requestId) {
    const app = parts.slice(0, FAL_NAMESPACES.has(parts[0] as string) ? 3 : 2)
    return `/${app.join('/')}/requests/${encodeURIComponent(handle.requestId)}`
  }
  throw remoteError(
    'REMOTE_UNAVAILABLE',
    `${ctx.provider} gave no way to follow the request.`,
    handle.requestId
  )
}

/** A fal queue path through the router: `{router}/fal-ai{path}?_subdomain=queue`. */
function queueUrl(ctx: MediaContext, path: string): string {
  return `${routerRoot(ctx)}/fal-ai${path}?_subdomain=queue`
}

/** A failed fal request as the closest `REMOTE_*` code, from fal's `error_type` and words. */
function falFailure(
  ctx: MediaContext,
  message: string | undefined,
  type: string | undefined
): AtomicCoreError {
  const details = [type, message].filter((part) => part !== undefined).join(': ') || undefined
  const said = message ?? type
  if (
    (type && /content_policy|nsfw|moderat/i.test(type)) ||
    (message && /content checker|nsfw|content polic/i.test(message))
  )
    return remoteError('REMOTE_CONTENT_BLOCKED', `${ctx.provider} refused the request: ${said}`, details)
  if (type && /timeout/i.test(type))
    return remoteError('REMOTE_TIMEOUT', `${ctx.provider} took too long to generate.`, details)
  if (!type || /^(runner_|internal|downstream|no_media|client_)/i.test(type))
    return remoteError(
      'REMOTE_UNAVAILABLE',
      `${ctx.provider} failed to generate${said ? `: ${said}` : '.'}`,
      details
    )
  return remoteError('REMOTE_REJECTED', `${ctx.provider}: ${said}`, details)
}

/** A non-2xx fal answer (`{detail: [{msg, type}]}` or `{detail, error_type}`) as a `REMOTE_*` error. */
function falHttpError(ctx: MediaContext, answer: CallAnswer): AtomicCoreError {
  const fields = asObject(answer.json)
  const detail = fields['detail']
  const first = Array.isArray(detail) ? asObject(detail[0]) : {}
  const type = text(first['type']) ?? text(fields['error_type'])
  if (type && /content_policy/i.test(type)) return falFailure(ctx, text(first['msg']) ?? text(detail), type)
  return remoteHttpError(ctx.provider, answer.status, answer.json, answer.text)
}

/**
 * Submits `input` to fal model `providerModel` (`fal-ai/flux/schnell`) through the HF router:
 * `POST {router}/fal-ai/{providerModel}?_subdomain=queue` with the HF key. Starts a generation, so
 * it is never retried. Answers the handle {@link falStatus}, {@link falResult}, {@link falWait} and
 * {@link falCancel} take.
 */
export async function falSubmit(
  ctx: MediaContext,
  providerModel: string,
  input: Record<string, unknown>
): Promise<FalHandle> {
  const model = providerModel.trim().replace(/^\/+|\/+$/g, '')
  if (!FAL_MODEL_ID.test(model) || model.split('/').some((part) => part === '.' || part === '..'))
    throw remoteError('REMOTE_NOT_CONFIGURED', `The model has no usable fal model id.`, providerModel)
  const answer = await callProvider(ctx, queueUrl(ctx, `/${model}`), { json: input, accept: [422] })
  if (answer.status === 422) throw falHttpError(ctx, answer)
  const fields = asObject(answer.json)
  const requestId = text(fields['request_id'])
  if (!requestId)
    throw remoteError(
      'REMOTE_UNAVAILABLE',
      `${ctx.provider} accepted the request without an id.`,
      answer.text.slice(0, 300) || undefined
    )
  const handle: FalHandle = { requestId, providerModel: model }
  const statusUrl = text(fields['status_url'])
  const responseUrl = text(fields['response_url'])
  if (statusUrl) handle.statusUrl = statusUrl
  if (responseUrl) handle.responseUrl = responseUrl
  return handle
}

/**
 * One look at a fal request: `GET {router}/fal-ai/{request path}/status?_subdomain=queue`.
 * `IN_QUEUE` → `queued` (with fal's queue position), `IN_PROGRESS` → `running`, `COMPLETED` →
 * `completed`, or `failed` when fal reports an `error` on it. An unknown status counts as running.
 */
export async function falStatus(ctx: MediaContext, handle: FalHandle): Promise<FalStatus> {
  const answer = await callProvider(ctx, queueUrl(ctx, `${requestPath(ctx, handle)}/status`))
  const fields = asObject(answer.json)
  const status = text(fields['status'])?.toUpperCase()
  if (!status)
    return {
      state: 'failed',
      error: remoteError(
        'REMOTE_UNAVAILABLE',
        `${ctx.provider} answered without a status.`,
        answer.text.slice(0, 300)
      ),
    }
  if (status === 'IN_QUEUE') {
    const position = fields['queue_position']
    return typeof position === 'number' && Number.isFinite(position)
      ? { state: 'queued', position }
      : { state: 'queued' }
  }
  if (status === 'IN_PROGRESS') return { state: 'running' }
  const error = text(fields['error'])
  const type = text(fields['error_type'])
  if (status === 'COMPLETED')
    return error || type ? { state: 'failed', error: falFailure(ctx, error, type) } : { state: 'completed' }
  if (/FAIL|ERROR|CANCEL/.test(status))
    return { state: 'failed', error: falFailure(ctx, error ?? status, type) }
  return { state: 'running' }
}

/**
 * The result of a completed fal request: `GET {router}/fal-ai/{request path}?_subdomain=queue`.
 * The JSON is the model's own (`{images: [{url}]}`, `{video: {url}}`); a content refusal is
 * `REMOTE_CONTENT_BLOCKED`.
 */
export async function falResult(ctx: MediaContext, handle: FalHandle): Promise<unknown> {
  const answer = await callProvider(ctx, queueUrl(ctx, requestPath(ctx, handle)), { accept: [400, 422] })
  if (answer.status >= 400) throw falHttpError(ctx, answer)
  if (answer.json === undefined)
    throw remoteError(
      'REMOTE_UNAVAILABLE',
      `${ctx.provider} answered the result without JSON.`,
      answer.text.slice(0, 300)
    )
  return answer.json
}

/**
 * Polls a fal request until it completes ({@link FAL_POLL} unless `poll` says otherwise), telling
 * `report` whether it is queued or generating, then answers its result ({@link falResult}). Throws
 * the request's `REMOTE_*` error when it failed, `CANCELLED` when the job was cancelled (the caller
 * may then {@link falCancel} it), `REMOTE_TIMEOUT` past the poll's limit.
 */
export async function falWait(
  ctx: MediaContext,
  handle: FalHandle,
  report: (progress: RemoteProgress) => void = () => {},
  poll: PollOptions = FAL_POLL
): Promise<unknown> {
  await pollUntil(
    ctx,
    async () => {
      const status = await falStatus(ctx, handle)
      if (status.state === 'failed') throw status.error
      if (status.state === 'completed') return true
      report({ phase: status.state === 'queued' ? 'queued' : 'generating' })
      return undefined
    },
    poll
  )
  return falResult(ctx, handle)
}

/**
 * Asks fal to drop a request: `PUT {router}/fal-ai/{request path}/cancel?_subdomain=queue`. A
 * queued request goes at once; a running one may still finish. A request already finished or gone
 * is not an error. Pass a context whose signal has not fired (the job's own one has, on cancel).
 */
export async function falCancel(ctx: MediaContext, handle: FalHandle): Promise<void> {
  await callProvider(ctx, queueUrl(ctx, `${requestPath(ctx, handle)}/cancel`), {
    method: 'PUT',
    accept: [400, 404, 405],
  })
}

// ---------------------------------------------------------------------------------------------
// The image adapter
// ---------------------------------------------------------------------------------------------

/** The pixel size of a job: its `WxH`, else the form's width and height. */
function jobSize(job: ImageGenerationJob): { width: number; height: number } | undefined {
  return (
    parseWxH(job.size) ?? (job.width && job.height ? { width: job.width, height: job.height } : undefined)
  )
}

/** fal's text-to-image input: `{prompt, image_size, num_images, seed, ...}`. */
function falInput(job: ImageGenerationJob): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: job.prompt }
  const size = jobSize(job)
  if (size) input['image_size'] = size
  if (job.n > 1) input['num_images'] = job.n
  if (job.seed !== undefined && job.seed >= 0 && job.model.params.seed) input['seed'] = job.seed
  if (job.negativePrompt && job.model.params.negative_prompt) input['negative_prompt'] = job.negativePrompt
  if (job.steps !== undefined) input['num_inference_steps'] = job.steps
  const guidance = job.guidance ?? job.cfgScale
  if (guidance !== undefined) input['guidance_scale'] = guidance
  return input
}

/** One image a provider pointed at (a data URL or a download), sniffed. */
async function imageAt(ctx: MediaContext, url: string): Promise<GeneratedImage> {
  if (url.startsWith('data:')) return decodeBase64Image(url)
  const file = await downloadResult(ctx, url, { maxBytes: MAX_IMAGE_BYTES, what: 'image' })
  const mime = sniffImageMime(file.bytes)
  if (!mime) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not an image.`)
  return { bytes: file.bytes, mime }
}

/**
 * The images of a fal result (`{images: [{url}], has_nsfw_concepts}`, or one `image`). An image fal
 * flagged as NSFW is blacked out by fal and left out; all of them flagged is a content refusal.
 */
async function falImages(ctx: MediaContext, result: unknown): Promise<GeneratedImage[]> {
  const fields = asObject(result)
  const listed = Array.isArray(fields['images']) ? fields['images'] : fields['image'] ? [fields['image']] : []
  const flags = Array.isArray(fields['has_nsfw_concepts']) ? fields['has_nsfw_concepts'] : []
  const out: GeneratedImage[] = []
  let flagged = 0
  for (const [index, item] of listed.entries()) {
    const url = text(asObject(item)['url']) ?? text(item)
    if (!url) continue
    if (flags[index] === true) {
      flagged++
      continue
    }
    out.push(await imageAt(ctx, url))
  }
  if (out.length === 0 && flagged > 0)
    throw remoteError(
      'REMOTE_CONTENT_BLOCKED',
      `${ctx.provider} withheld the image as unsafe.`,
      'has_nsfw_concepts'
    )
  if (out.length === 0) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without an image.`)
  return out
}

async function generateFal(
  ctx: MediaContext,
  job: ImageGenerationJob,
  report: (progress: RemoteProgress) => void
): Promise<GeneratedImage[]> {
  if (job.workflow !== 'create')
    throw remoteError(
      'REMOTE_UNSUPPORTED',
      'This model only creates images from a prompt here.',
      job.workflow
    )
  const providerModel = job.model.options?.['provider_model']
  if (typeof providerModel !== 'string' || providerModel === '')
    throw remoteError(
      'REMOTE_NOT_CONFIGURED',
      'The model does not say which fal model serves it.',
      job.model.id
    )
  const handle = await falSubmit(ctx, providerModel, falInput(job))
  try {
    return await falImages(ctx, await falWait(ctx, handle, report))
  } catch (error) {
    // Best effort and not waited for: a queued request goes at once, a running one may still finish.
    if (ctx.signal.aborted) void falCancel(detached(ctx), handle).catch(() => undefined)
    throw error
  }
}

/** `hf-inference`'s parameters for one image. */
function hfParameters(job: ImageGenerationJob, index: number): Record<string, unknown> {
  const parameters: Record<string, unknown> = {}
  const size = jobSize(job)
  if (size) {
    if (job.workflow === 'transform') parameters['target_size'] = size
    else Object.assign(parameters, size)
  }
  if (job.steps !== undefined) parameters['num_inference_steps'] = job.steps
  const guidance = job.cfgScale ?? job.guidance
  if (guidance !== undefined) parameters['guidance_scale'] = guidance
  if (job.negativePrompt) parameters['negative_prompt'] = job.negativePrompt
  if (job.seed !== undefined && job.seed >= 0) parameters['seed'] = job.seed + index
  return parameters
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

/**
 * One `hf-inference` call. It answers the image itself, so the body is read as bytes here (not
 * through `callProvider`, which reads text); a non-2xx is mapped by the same `remoteHttpError`.
 */
async function hfInferenceImage(ctx: MediaContext, url: string, body: unknown): Promise<GeneratedImage> {
  const headers = providerHeaders(ctx, 'bearer', {
    'Accept': 'image/png, image/jpeg, image/webp, application/json',
    'Content-Type': 'application/json',
  })
  let response: Response
  let bytes: Buffer
  try {
    response = await ctx.fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)]),
    })
    const declared = Number(response.headers.get('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined)
      throw remoteError(
        'INVALID_OUTPUT',
        `The provider's image is larger than the core accepts.`,
        `${declared} bytes`
      )
    }
    bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_IMAGE_BYTES)
      throw remoteError(
        'INVALID_OUTPUT',
        `The provider's image is larger than the core accepts.`,
        `${bytes.length} bytes`
      )
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) throw error
    throw networkError(ctx, error)
  }
  if (response.status < 200 || response.status >= 300) {
    const said = bytes.toString('utf8')
    throw remoteHttpError(ctx.provider, response.status, parseJson(said), said)
  }
  const mime = sniffImageMime(bytes)
  if (mime) return { bytes, mime }
  // Some deployments answer JSON instead: `{data: [{b64_json}]}` or `{output: [url]}`.
  const json = asObject(parseJson(bytes.toString('utf8')))
  const data = Array.isArray(json['data']) ? asObject(json['data'][0]) : {}
  const b64 = text(data['b64_json'])
  if (b64) return decodeBase64Image(b64)
  const output = Array.isArray(json['output']) ? text(json['output'][0]) : undefined
  if (output) return imageAt(ctx, output)
  throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without an image.`)
}

async function generateHfInference(
  ctx: MediaContext,
  job: ImageGenerationJob,
  report: (progress: RemoteProgress) => void
): Promise<GeneratedImage[]> {
  if (job.workflow !== 'create' && job.workflow !== 'transform')
    throw remoteError('REMOTE_UNSUPPORTED', 'This model cannot do that here.', job.workflow)
  const source = job.images[0]
  if (job.workflow === 'transform' && !source)
    throw remoteError('REMOTE_UNSUPPORTED', 'This workflow needs a source image.', job.workflow)
  const url = `${routerRoot(ctx)}/hf-inference/models/${job.model.id.split('/').map(encodeURIComponent).join('/')}`
  const count = Math.max(1, job.n)
  const out: GeneratedImage[] = []
  for (let index = 0; index < count; index++) {
    const parameters = hfParameters(job, index)
    const body =
      job.workflow === 'transform' && source
        ? { inputs: source.bytes.toString('base64'), parameters: { ...parameters, prompt: job.prompt } }
        : { inputs: job.prompt, parameters }
    out.push(await hfInferenceImage(ctx, url, body))
    if (count > 1) report({ phase: 'generating', fraction: (index + 1) / count })
  }
  return out
}

/** The models of a Hub listing a provider here serves live, with the provider and its model id. */
export function liveModelsFromHub(json: unknown): LiveMediaModel[] {
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(json) ? json : []) {
    const entry = asObject(item)
    const id = text(entry['id']) ?? text(entry['modelId'])
    if (!id || seen.has(id)) continue
    const raw = entry['inferenceProviderMapping']
    // Listed as an array of `{provider, providerId, status, task}`, or (older) keyed by provider.
    const mapping: Fields[] = Array.isArray(raw)
      ? raw.map(asObject)
      : Object.entries(asObject(raw)).map(([provider, value]) => ({ provider, ...asObject(value) }))
    for (const provider of HF_PROVIDERS) {
      const live = mapping.find(
        (m) =>
          m['provider'] === provider &&
          m['status'] === 'live' &&
          (m['task'] === undefined || m['task'] === 'text-to-image')
      )
      if (!live) continue
      seen.add(id)
      out.push({ id, options: { hf_provider: provider, provider_model: text(live['providerId']) ?? id } })
      break
    }
  }
  return out
}

export const HF_IMAGES: ImageAdapter = {
  dialect: 'hf-images',
  kind: 'image',

  async listModels(ctx) {
    let host: string
    try {
      host = new URL(ctx.baseUrl).hostname
    } catch {
      return []
    }
    if (host !== ROUTER_HOST) {
      ctx.log('info', `${ctx.provider}: no Hub listing for a base off ${ROUTER_HOST}; the catalog applies.`)
      return []
    }
    // A public API on another host: neither the key nor the custom headers go along.
    const hub = { ...ctx, apiKey: null, customHeaders: [] }
    const answer = await callProvider(hub, HUB_LISTING_URL, { auth: 'none' })
    return liveModelsFromHub(answer.json)
  },

  async generate(ctx, job, report) {
    report({ phase: 'generating' })
    const provider = job.model.options?.['hf_provider'] ?? 'hf-inference'
    if (provider === 'fal-ai') return generateFal(ctx, job, report)
    if (provider === 'hf-inference') return generateHfInference(ctx, job, report)
    throw remoteError(
      'REMOTE_UNSUPPORTED',
      `Models served by ${String(provider)} are not supported yet.`,
      job.model.id
    )
  },
}
