/**
 * `hf-videos`: Hugging Face Inference Providers' video models, through fal-ai's queue behind the HF
 * router. The provider is registered with the router's OpenAI-compatible base
 * (`https://router.huggingface.co/v1`); the router proxies each inference provider under
 * `/{provider}` of its origin, so `hfRouterBase` strips the trailing `/v1` and every call goes to
 * `{router}/fal-ai/…?_subdomain=queue`, the way huggingface.js routes fal-ai's queue
 * (`packages/inference/src/providers/fal-ai.ts`). The HF token never goes to `queue.fal.run` itself.
 *
 * A catalog model names its route in `options`: `hf_provider` (`fal-ai`, the only one spoken here)
 * and `provider_model` (fal's endpoint id, e.g. `fal-ai/wan/v2.2-5b/text-to-video`).
 *
 * - submit → `POST {router}/fal-ai/{provider_model}?_subdomain=queue` `{prompt, …}` →
 *   `{request_id, response_url, status_url}`. fal's URLs point at `queue.fal.run`; only their path
 *   (`/{owner}/{app}/requests/{id}`) is kept, to be asked through the router later;
 * - poll → `GET {router}/fal-ai{path}/status?_subdomain=queue` → `status` IN_QUEUE | IN_PROGRESS |
 *   COMPLETED (with `error`/`error_type` when it failed); once completed, `GET
 *   {router}/fal-ai{path}?_subdomain=queue` → `{video:{url}}`;
 * - download → `video.url` on fal's CDN, without the key;
 * - no cancel; the listing is the public Hub API (no key), and only for the real router.
 */

import type { AtomicCoreError } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  downloadResult,
  MAX_VIDEO_BYTES,
  networkError,
  providerMessage,
  remoteError,
  remoteHttpError,
  SHORT_TIMEOUT_MS,
  sniffVideoMime,
  toDataUrl,
} from '../http.js'
import type { MediaContext } from '../http.js'
import type { VideoAdapter, VideoGenerationJob, VideoPoll } from './types.js'

type Fields = Record<string, unknown>

const fields = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {}

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** The only inference provider this adapter speaks. */
const FAL_AI = 'fal-ai'
/** The router asks fal's queue (not its synchronous endpoint) with this. */
const QUEUE = '?_subdomain=queue'
/** The host whose models the public Hub lists. */
const HF_ROUTER_HOST = 'router.huggingface.co'
/** The Hub's text-to-video models served by fal-ai, with their provider mappings. */
export const HF_VIDEO_LISTING_URL =
  'https://huggingface.co/api/models?inference_provider=fal-ai&pipeline_tag=text-to-video&expand[]=inferenceProviderMapping&limit=100'

/** A fal endpoint id: `owner/app[/sub/path]`, no empty or dot segments. */
const ENDPOINT_ID = /^[A-Za-z0-9_-][\w.-]*(\/[A-Za-z0-9_-][\w.-]*)+$/

/** A queued request's path: `/{owner}/{app}[/…]/requests/{id}`, no dot segments. */
const QUEUE_PATH = /^(\/(?!\.{1,2}(\/|$))[^/?#]+){2,}\/requests\/[\w-]+$/

/** `https://router.huggingface.co/v1` → `https://router.huggingface.co`. */
export function hfRouterBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/**
 * The queue path of a submitted request, `/{owner}/{app}/requests/{id}`: the path of fal's
 * `response_url` (or `status_url`), as huggingface.js takes it, else built from the endpoint id the
 * way fal's own client does (its first two segments).
 */
export function falRequestPath(answer: unknown, providerModel: string, requestId: string): string {
  const body = fields(answer)
  const tail = `/requests/${requestId}`
  for (const key of ['response_url', 'status_url'] as const) {
    const raw = textOf(body[key])
    if (!raw) continue
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      continue
    }
    let path = url.pathname.replace(/\/status$/, '')
    // A URL the router already rewrote carries its `/fal-ai` prefix; the path is fal's own.
    if (!url.hostname.endsWith('fal.run') && path.startsWith(`/${FAL_AI}/`))
      path = path.slice(FAL_AI.length + 1)
    if (path.endsWith(tail) && QUEUE_PATH.test(path)) return path
  }
  const [owner, app] = providerModel.split('/')
  return `/${owner}/${app}${tail}`
}

/** A fal failure (`error`/`error_type` of a completed request, or its result's error body). */
export function falError(provider: string, body: unknown, status?: number, text = ''): AtomicCoreError {
  const fieldsOf = fields(body)
  const types = [fieldsOf['error_type'], fieldsOf['type']]
  const detail = fieldsOf['detail']
  if (Array.isArray(detail)) for (const item of detail) types.push(fields(item)['type'])
  const typed = types.filter((t): t is string => typeof t === 'string')
  const said = providerMessage(body, text)
  const details = [status === undefined ? undefined : `HTTP ${status}`, typed[0], said]
    .filter(Boolean)
    .join(': ')
  if (typed.some((t) => /content_policy|nsfw|safety|moderation/i.test(t)))
    return remoteError(
      'REMOTE_CONTENT_BLOCKED',
      said ? `${provider} refused the content: ${said}` : `${provider} refused the content.`,
      details || undefined
    )
  if (status !== undefined) return remoteHttpError(provider, status, body, text)
  if (typed.some((t) => /timeout/i.test(t)))
    return remoteError('REMOTE_TIMEOUT', `${provider} took too long to make the clip.`, details || undefined)
  return remoteError(
    'REMOTE_UNAVAILABLE',
    said ? `${provider} could not make the clip: ${said}` : `${provider} could not make the clip.`,
    details || undefined
  )
}

/** The workflow is the model's, and image to video has the frames it needs. */
function checkInputs(job: VideoGenerationJob): void {
  if (!job.model.workflows.includes(job.workflow))
    throw remoteError('REMOTE_UNSUPPORTED', `${job.model.name} cannot do ${job.workflow}.`, job.workflow)
  if (job.workflow !== 'image-to-video') return
  if (!job.firstFrame) throw remoteError('REMOTE_UNSUPPORTED', 'Image to video needs a first frame.')
  if (job.lastFrame && !job.model.params.last_frame)
    throw remoteError('REMOTE_UNSUPPORTED', `${job.model.name} does not take a last frame.`)
}

/** Where a model runs: its fal endpoint id, or `REMOTE_UNSUPPORTED` for a model without one. */
export function falEndpoint(job: VideoGenerationJob): string {
  const options = job.model.options ?? {}
  const provider = options['hf_provider'] ?? FAL_AI
  if (provider !== FAL_AI)
    throw remoteError(
      'REMOTE_UNSUPPORTED',
      `${job.model.name} runs on ${String(provider)}, which is not supported.`
    )
  const endpoint = options['provider_model']
  if (typeof endpoint !== 'string' || !ENDPOINT_ID.test(endpoint))
    throw remoteError(
      'REMOTE_UNSUPPORTED',
      `${job.model.name} names no fal-ai model to run on.`,
      job.model.id
    )
  return endpoint
}

/** fal's input: what the job set and the model offers. */
export function falVideoInput(job: VideoGenerationJob): Fields {
  checkInputs(job)
  const params = job.model.params
  const input: Fields = { prompt: job.prompt }
  if (job.negativePrompt && params.negative_prompt) input['negative_prompt'] = job.negativePrompt
  if (job.aspectRatio && params.aspect_ratios) input['aspect_ratio'] = job.aspectRatio
  if (job.resolution && params.resolutions) input['resolution'] = job.resolution
  if (job.durationSecs !== undefined && params.durations) input['duration'] = Math.round(job.durationSecs)
  if (job.generateAudio !== undefined && params.audio) input['generate_audio'] = job.generateAudio
  if (job.seed !== undefined && params.seed) input['seed'] = job.seed
  if (job.workflow === 'image-to-video' && job.firstFrame) {
    input['image_url'] = toDataUrl(job.firstFrame.bytes, job.firstFrame.mime)
    if (job.lastFrame) input['end_image_url'] = toDataUrl(job.lastFrame.bytes, job.lastFrame.mime)
  }
  return input
}

/** The Hub's listing as models: a live fal-ai mapping of a single model each. */
export function falVideoModels(json: unknown): LiveMediaModel[] {
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(json) ? json : []) {
    const entry = fields(item)
    const id = textOf(entry['id']) ?? textOf(entry['modelId'])
    if (!id || seen.has(id)) continue
    const raw = entry['inferenceProviderMapping']
    // The Hub answers a list of mappings; older answers keyed them by provider.
    const mappings: Fields[] = Array.isArray(raw)
      ? raw.map(fields)
      : Object.entries(fields(raw)).map(([provider, value]) => ({ provider, ...fields(value) }))
    const fal = mappings.find(
      (m) =>
        m['provider'] === FAL_AI &&
        m['status'] === 'live' &&
        (m['task'] === undefined || m['task'] === 'text-to-video') &&
        (m['type'] === undefined || m['type'] === 'single-model') &&
        typeof m['providerId'] === 'string' &&
        ENDPOINT_ID.test(m['providerId'])
    )
    if (!fal) continue
    seen.add(id)
    out.push({
      id,
      workflows: ['create'],
      options: { hf_provider: FAL_AI, provider_model: fal['providerId'] as string },
    })
  }
  return out
}

/** The router URL of a queued request, from its persisted path. */
function queueUrl(ctx: MediaContext, path: string, suffix = ''): string {
  return `${hfRouterBase(ctx.baseUrl)}/${FAL_AI}${path}${suffix}${QUEUE}`
}

/** The persisted queue path, checked: it goes to the router with the key. */
function pathOf(submission: { id: string; data?: Record<string, unknown> }): string {
  const path = submission.data?.['path']
  if (typeof path === 'string' && QUEUE_PATH.test(path)) return path
  throw remoteError('REMOTE_UNAVAILABLE', 'The submitted request has no queue path to ask.', submission.id)
}

/** Statuses of the result fetch that end the job rather than the poll. */
const RESULT_REFUSALS = [400, 404, 410, 422] as const

async function completed(ctx: MediaContext, path: string): Promise<VideoPoll> {
  const answer = await callProvider(ctx, queueUrl(ctx, path), { accept: RESULT_REFUSALS })
  if (answer.status >= 300)
    return { state: 'failed', error: falError(ctx.provider, answer.json, answer.status, answer.text) }
  const url = textOf(fields(fields(answer.json)['video'])['url'])
  if (!url)
    return {
      state: 'failed',
      error: remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} finished without a clip.`),
    }
  return { state: 'completed', result: { url } }
}

export const HF_VIDEOS: VideoAdapter = {
  dialect: 'hf-videos',
  kind: 'video',
  pollIntervalMs: { first: 5000, max: 15000 },

  async listModels(ctx) {
    // The Hub lists the router's models; a base elsewhere (a proxy) has the catalog alone.
    let host: string
    try {
      host = new URL(ctx.baseUrl).hostname
    } catch {
      return []
    }
    if (host !== HF_ROUTER_HOST) return []
    // A public listing on another origin: neither the key nor custom headers go along.
    let response: Response
    let text: string
    try {
      response = await ctx.fetch(HF_VIDEO_LISTING_URL, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(SHORT_TIMEOUT_MS)]),
      })
      text = await response.text()
    } catch (error) {
      throw networkError(ctx, error)
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    if (!response.ok) throw remoteHttpError(ctx.provider, response.status, json, text)
    return falVideoModels(json)
  },

  async submit(ctx, job) {
    const endpoint = falEndpoint(job)
    const answer = await callProvider(ctx, `${hfRouterBase(ctx.baseUrl)}/${FAL_AI}/${endpoint}${QUEUE}`, {
      json: falVideoInput(job),
    })
    const body = fields(answer.json)
    const id = textOf(body['request_id'])
    if (!id || !/^[\w-]+$/.test(id))
      throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without a request id.`)
    return { id, data: { path: falRequestPath(body, endpoint, id) } }
  },

  async poll(ctx, submission) {
    const path = pathOf(submission)
    const answer = await callProvider(ctx, queueUrl(ctx, path, '/status'))
    const body = fields(answer.json)
    const status = (textOf(body['status']) ?? '').toUpperCase()
    if (status === 'IN_QUEUE') return { state: 'queued' }
    if (status !== 'COMPLETED') return { state: 'running' }
    if (body['error'] !== undefined && body['error'] !== null)
      return { state: 'failed', error: falError(ctx.provider, body) }
    return completed(ctx, path)
  },

  async download(ctx, _submission, result) {
    if (!result.url) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} gave no clip to download.`)
    const file = await downloadResult(ctx, result.url, { maxBytes: MAX_VIDEO_BYTES, what: 'video' })
    const mime = sniffVideoMime(file.bytes)
    if (!mime)
      throw remoteError(
        'REMOTE_UNAVAILABLE',
        `${ctx.provider} returned a file that is not a video.`,
        file.mime || undefined
      )
    return { bytes: file.bytes, mime }
  },
}
