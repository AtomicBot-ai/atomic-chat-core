/**
 * `gemini-veo`: Google's Veo through the Gemini API. The provider is registered with Gemini's
 * OpenAI-compatible base (`https://generativelanguage.googleapis.com/v1beta/openai`); Veo lives on
 * the native API next to it, so `{native}` is that base without its trailing `/openai`
 * (`.../v1beta`). The key goes as `x-goog-api-key`.
 *
 * - submit: `POST {native}/models/{model}:predictLongRunning`, JSON `{instances: [{prompt, image,
 *   lastFrame}], parameters: {aspectRatio, resolution, durationSeconds, seed, negativePrompt,
 *   numberOfVideos: 1}}` → `{name: 'models/…/operations/…'}`. Frames go as `{inlineData: {mimeType,
 *   data}}`. Veo renders 1080p and 4k at 8 seconds only, so a shorter clip at those sizes is asked
 *   for at 8. `durationSeconds` goes as a number (the SDKs' form); a model whose
 *   `options.duration_as_string` is true sends the docs table's string (`"8"`).
 * - poll: `GET {native}/{name}` → `{done, error: {code, message}, response: {generateVideoResponse:
 *   {generatedSamples: [{video: {uri}}], raiMediaFilteredCount, raiMediaFilteredReasons}}}`. A done
 *   operation without samples that names filter reasons is `REMOTE_CONTENT_BLOCKED`.
 * - download: the sample's `uri`, on the API's own host, so with the key; it redirects to storage,
 *   where `downloadResult` leaves the key behind.
 * - models: `GET {native}/models?pageSize=1000`, the `veo-` models that offer `predictLongRunning`.
 *
 * No cancel: the Gemini API cannot cancel a Veo operation.
 */

import type { AtomicCoreError } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  downloadResult,
  joinUrl,
  MAX_VIDEO_BYTES,
  remoteError,
  sniffVideoMime,
} from '../http.js'
import type { MediaInput, VideoAdapter, VideoGenerationJob, VideoPoll } from './types.js'

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const BLOCKED =
  /moderation|content[ _-]?polic|safety|nsfw|sensitive|prohibited|blocked|flagged|filtered|responsible ai|usage guidelines/i

/** Resolutions Veo renders at 8 seconds only. */
const EIGHT_SECONDS_ONLY = /^(1080p|4k)$/i

/** `{base}` of the Gemini API's native routes: the registered base without its `/openai`. */
export function veoNativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/openai$/, '')
}

/** The clip length to ask for: 8 seconds whenever the resolution allows nothing else. */
export function veoDuration(resolution: string | undefined, seconds: number | undefined): number | undefined {
  if (seconds === undefined) return undefined
  return resolution && EIGHT_SECONDS_ONLY.test(resolution) && seconds < 8 ? 8 : seconds
}

function inline(input: MediaInput): Fields {
  return { inlineData: { mimeType: input.mime, data: input.bytes.toString('base64') } }
}

/** The `predictLongRunning` body: each parameter only when the job set it and the model offers it. */
export function veoRequest(job: VideoGenerationJob, provider = 'Google'): Fields {
  const params = job.model.params
  const instance: Fields = { prompt: job.prompt }
  if (job.workflow === 'image-to-video') {
    if (!job.firstFrame)
      throw remoteError('REMOTE_UNSUPPORTED', 'Image to video needs a first frame.', job.workflow)
    instance['image'] = inline(job.firstFrame)
    if (job.lastFrame) {
      if (!params.last_frame)
        throw remoteError(
          'REMOTE_UNSUPPORTED',
          `${provider} takes no last frame for this model.`,
          job.model.id
        )
      instance['lastFrame'] = inline(job.lastFrame)
    }
  }
  const parameters: Fields = { numberOfVideos: 1 }
  if (job.aspectRatio && params.aspect_ratios) parameters['aspectRatio'] = job.aspectRatio
  const resolution = job.resolution && params.resolutions ? job.resolution : undefined
  if (resolution) parameters['resolution'] = resolution
  const seconds = params.durations ? veoDuration(resolution, job.durationSecs) : undefined
  if (seconds !== undefined)
    parameters['durationSeconds'] =
      job.model.options?.['duration_as_string'] === true ? String(seconds) : seconds
  if (job.seed !== undefined && params.seed) parameters['seed'] = job.seed
  if (job.negativePrompt && params.negative_prompt) parameters['negativePrompt'] = job.negativePrompt
  return { instances: [instance], parameters }
}

/** An operation's `error: {code, message}` (google.rpc codes) as the closest `REMOTE_*` code. */
export function veoError(provider: string, error: unknown): AtomicCoreError {
  const fields = isObject(error) ? error : {}
  const code = typeof fields['code'] === 'number' ? fields['code'] : undefined
  const said =
    typeof fields['message'] === 'string' && fields['message'].trim() !== '' ? fields['message'].trim() : ''
  const details = [code, said].filter((part) => part !== undefined && part !== '').join(': ') || undefined
  if (BLOCKED.test(said))
    return remoteError('REMOTE_CONTENT_BLOCKED', `${provider} refused the request: ${said}`, details)
  switch (code) {
    case 3: // INVALID_ARGUMENT
    case 9: // FAILED_PRECONDITION
      return remoteError(
        'REMOTE_REJECTED',
        said ? `${provider}: ${said}` : `${provider} refused the request.`,
        details
      )
    case 7: // PERMISSION_DENIED
    case 16: // UNAUTHENTICATED
      return remoteError('REMOTE_AUTH_FAILED', `${provider} refused the API key or the model.`, details)
    case 8: // RESOURCE_EXHAUSTED
      return remoteError('REMOTE_RATE_LIMITED', `${provider} is rate-limiting requests.`, details)
    case 4: // DEADLINE_EXCEEDED
      return remoteError('REMOTE_TIMEOUT', `${provider} took too long to make the clip.`, details)
    default:
      return remoteError(
        'REMOTE_UNAVAILABLE',
        said ? `${provider} failed to make the clip: ${said}` : `${provider} failed to make the clip.`,
        details
      )
  }
}

/** One operation (`GET {native}/{name}`) as a poll result. */
export function readVeoOperation(provider: string, json: unknown): VideoPoll {
  const fields = isObject(json) ? json : {}
  if (isObject(fields['error'])) return { state: 'failed', error: veoError(provider, fields['error']) }
  if (fields['done'] !== true) return { state: 'running' }
  const response = isObject(fields['response']) ? fields['response'] : {}
  const generated = isObject(response['generateVideoResponse']) ? response['generateVideoResponse'] : response
  const samples = generated['generatedSamples'] ?? generated['generatedVideos']
  for (const sample of Array.isArray(samples) ? samples : []) {
    const video = isObject(sample) && isObject(sample['video']) ? sample['video'] : {}
    if (typeof video['uri'] === 'string' && video['uri'] !== '')
      return { state: 'completed', result: { url: video['uri'] } }
  }
  const reasons = Array.isArray(generated['raiMediaFilteredReasons'])
    ? generated['raiMediaFilteredReasons'].filter((r): r is string => typeof r === 'string' && r !== '')
    : []
  const filtered =
    typeof generated['raiMediaFilteredCount'] === 'number' ? generated['raiMediaFilteredCount'] : 0
  if (reasons.length > 0 || filtered > 0)
    return {
      state: 'failed',
      error: remoteError(
        'REMOTE_CONTENT_BLOCKED',
        reasons.length > 0
          ? `${provider} withheld the clip by its safety filter: ${reasons.join(' ')}`
          : `${provider} withheld the clip by its safety filter.`,
        reasons.join(' | ') || `${filtered} filtered`
      ),
    }
  return { state: 'failed', error: remoteError('REMOTE_UNAVAILABLE', `${provider} finished without a clip.`) }
}

/** The Veo models of a native `GET /models` answer. */
export function veoModels(json: unknown): LiveMediaModel[] {
  const data = isObject(json) ? json['models'] : undefined
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data) ? data : []) {
    if (!isObject(item) || typeof item['name'] !== 'string') continue
    const id = item['name'].replace(/^models\//, '')
    const methods = item['supportedGenerationMethods']
    if (
      !id.includes('veo-') ||
      !Array.isArray(methods) ||
      !methods.includes('predictLongRunning') ||
      seen.has(id)
    )
      continue
    seen.add(id)
    const name =
      typeof item['displayName'] === 'string' && item['displayName'] !== '' ? item['displayName'] : undefined
    out.push(name ? { id, name } : { id })
  }
  return out
}

/** An operation name the API gave, as a path under `{native}`; anything else is refused. */
function operationPath(provider: string, name: unknown): string {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(name) ||
    name.split('/').includes('..')
  )
    throw remoteError(
      'REMOTE_UNAVAILABLE',
      `${provider} answered without a usable operation name.`,
      String(name)
    )
  return `/${name}`
}

export const GEMINI_VEO: VideoAdapter = {
  dialect: 'gemini-veo',
  kind: 'video',
  pollIntervalMs: { first: 10_000, max: 20_000 },

  async listModels(ctx) {
    const answer = await callProvider(ctx, joinUrl(veoNativeBase(ctx.baseUrl), '/models?pageSize=1000'), {
      auth: 'goog',
    })
    return veoModels(answer.json)
  },

  async submit(ctx, job) {
    const body = veoRequest(job, ctx.provider)
    const asked = job.durationSecs
    const sent = (body['parameters'] as Fields)['durationSeconds']
    if (asked !== undefined && sent !== undefined && Number(sent) !== asked)
      ctx.log(
        'info',
        `${ctx.provider} renders ${job.resolution} at 8 seconds only; asking for 8 instead of ${asked}.`
      )
    const model = encodeURIComponent(job.model.id.replace(/^models\//, ''))
    const answer = await callProvider(
      ctx,
      joinUrl(veoNativeBase(ctx.baseUrl), `/models/${model}:predictLongRunning`),
      {
        json: body,
        auth: 'goog',
      }
    )
    const fields = isObject(answer.json) ? answer.json : {}
    if (isObject(fields['error'])) throw veoError(ctx.provider, fields['error'])
    operationPath(ctx.provider, fields['name'])
    return { id: fields['name'] as string }
  },

  async poll(ctx, submission) {
    const url = joinUrl(veoNativeBase(ctx.baseUrl), operationPath(ctx.provider, submission.id))
    const answer = await callProvider(ctx, url, { auth: 'goog' })
    return readVeoOperation(ctx.provider, answer.json)
  },

  async download(ctx, _submission, result) {
    if (!result.url) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} gave no clip to download.`)
    const file = await downloadResult(ctx, result.url, {
      maxBytes: MAX_VIDEO_BYTES,
      what: 'video',
      auth: 'goog',
    })
    const mime = sniffVideoMime(file.bytes)
    if (!mime) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not a video.`)
    return { bytes: file.bytes, mime }
  },
}
