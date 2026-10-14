/**
 * `aimlapi-videos`: AIMLAPI's video API. The provider is registered with `https://api.aimlapi.com/v1`;
 * video lives on `/v2` of the same server, so `{video}` is the base with its trailing version
 * segment swapped for `/v2/video/generations` (`https://api.aimlapi.com/v2/video/generations`).
 *
 * - submit: `POST {video}`, JSON `{model, prompt, duration, aspect_ratio, resolution, generate_audio,
 *   seed, negative_prompt, image_url}` → `{id, status}`. The first frame goes as a data URL in
 *   `image_url` (the field most of its image-to-video models take), or in the field the model's
 *   `options.image_field` names; a last frame only into the field `options.last_frame_field` names.
 * - poll: `GET {video}?generation_id={id}` → `queued | generating | completed | error` (also
 *   `waiting`, `active`), `video: {url}`, `error: {name, message}`.
 * - download: `video.url`, a file on AIMLAPI's CDN; off the API's origin it goes without the key.
 * - models: `GET {base}/models`, the entries typed `internal/video-generations/submit`. An id that
 *   says image to video (`-i2v`, `image-to-video`) takes only that workflow, one that says text to
 *   video only `create`; models that need a video, references or a voice are left out.
 *
 * No cancel: AIMLAPI has none.
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
  toDataUrl,
} from '../http.js'
import type { VideoAdapter, VideoGenerationJob, VideoPoll } from './types.js'

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const BLOCKED = /moderation|content[ _-]?polic|safety|nsfw|sensitive|prohibited|blocked|flagged/i

const VIDEO_TYPE = 'internal/video-generations/submit'
const IMAGE_TO_VIDEO = /(^|[-/_.])(i2v|image-to-video)([-/_.]|$)/i
const TEXT_TO_VIDEO = /(^|[-/_.])(t2v|text-to-video)([-/_.]|$)/i
/** Models whose input is a video, reference images, a pose or a voice: nothing the form gives. */
const OTHER_INPUTS =
  /(^|[-/_.])(v2v|r2v|video-to-video|reference-to-video|extend-video|video-edit|motion-control|vace|foley|avatar|omnihuman|animate)([-/_.]|$)/i

/** `POST`/`GET` URL of AIMLAPI's video API: the registered base with `/v2/video/generations` for its version. */
export function aimlapiVideoUrl(baseUrl: string): string {
  return joinUrl(baseUrl.replace(/\/+$/, '').replace(/\/v\d+$/, ''), '/v2/video/generations')
}

/** The submit body: each field only when the job set it and the model offers it; frames as data URLs. */
export function aimlapiVideoBody(job: VideoGenerationJob, provider = 'AIMLAPI'): Fields {
  const params = job.model.params
  const options = job.model.options ?? {}
  const body: Fields = { model: job.model.id, prompt: job.prompt }
  if (job.durationSecs !== undefined && params.durations) body['duration'] = Math.round(job.durationSecs)
  if (job.aspectRatio && params.aspect_ratios) body['aspect_ratio'] = job.aspectRatio
  if (job.resolution && params.resolutions) body['resolution'] = job.resolution
  if (job.generateAudio !== undefined && params.audio) body['generate_audio'] = job.generateAudio
  if (job.seed !== undefined && params.seed) body['seed'] = job.seed
  if (job.negativePrompt && params.negative_prompt) body['negative_prompt'] = job.negativePrompt
  if (job.workflow === 'image-to-video') {
    if (!job.firstFrame)
      throw remoteError('REMOTE_UNSUPPORTED', 'Image to video needs a first frame.', job.workflow)
    const field =
      typeof options['image_field'] === 'string' && options['image_field']
        ? options['image_field']
        : 'image_url'
    body[field] = toDataUrl(job.firstFrame.bytes, job.firstFrame.mime)
    if (job.lastFrame) {
      const last = options['last_frame_field']
      if (!params.last_frame || typeof last !== 'string' || last === '')
        throw remoteError(
          'REMOTE_UNSUPPORTED',
          `${provider} takes no last frame for this model.`,
          job.model.id
        )
      body[last] = toDataUrl(job.lastFrame.bytes, job.lastFrame.mime)
    }
  }
  return body
}

/** A generation's `error: {name, message}` as the closest `REMOTE_*` code. */
export function aimlapiVideoError(provider: string, error: unknown): AtomicCoreError {
  const fields = isObject(error) ? error : {}
  const name = typeof fields['name'] === 'string' ? fields['name'] : ''
  const said =
    typeof fields['message'] === 'string' && fields['message'].trim() !== ''
      ? fields['message'].trim()
      : typeof error === 'string' && error.trim() !== ''
        ? error.trim()
        : ''
  const details = [name, said].filter(Boolean).join(': ') || undefined
  if (BLOCKED.test(`${name} ${said}`))
    return remoteError('REMOTE_CONTENT_BLOCKED', `${provider} refused the request: ${said || name}`, details)
  if (/invalid|validation|bad.?request|unprocessable/i.test(name))
    return remoteError(
      'REMOTE_REJECTED',
      said ? `${provider}: ${said}` : `${provider} refused the request.`,
      details
    )
  return remoteError(
    'REMOTE_UNAVAILABLE',
    said ? `${provider} failed to make the clip: ${said}` : `${provider} failed to make the clip.`,
    details
  )
}

/** One generation answer (the submit's or a poll's) as a poll result. */
export function readAimlapiVideo(provider: string, json: unknown): VideoPoll {
  const fields = isObject(json) ? json : {}
  const status = typeof fields['status'] === 'string' ? fields['status'].toLowerCase() : ''
  switch (status) {
    case 'queued':
    case 'waiting':
    case 'pending':
      return { state: 'queued' }
    case 'completed':
    case 'succeeded':
    case 'success': {
      const video = fields['video']
      const url =
        isObject(video) && typeof video['url'] === 'string'
          ? video['url']
          : typeof video === 'string'
            ? video
            : ''
      return url !== ''
        ? { state: 'completed', result: { url } }
        : {
            state: 'failed',
            error: remoteError('REMOTE_UNAVAILABLE', `${provider} finished without a clip.`),
          }
    }
    case 'error':
    case 'failed':
      return { state: 'failed', error: aimlapiVideoError(provider, fields['error']) }
    default:
      // `generating`, `active`, and whatever comes next.
      return { state: 'running' }
  }
}

/** The video models of AIMLAPI's `GET {base}/models`, with the workflow their id names. */
export function aimlapiVideoModels(json: unknown): LiveMediaModel[] {
  const data = isObject(json) ? json['data'] : json
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data) ? data : []) {
    if (!isObject(item) || item['type'] !== VIDEO_TYPE) continue
    const id = item['id']
    if (typeof id !== 'string' || id === '' || seen.has(id) || OTHER_INPUTS.test(id)) continue
    seen.add(id)
    const model: LiveMediaModel = { id }
    const info = isObject(item['info']) ? item['info'] : {}
    if (typeof info['name'] === 'string' && info['name'] !== '') model.name = info['name']
    if (IMAGE_TO_VIDEO.test(id)) model.workflows = ['image-to-video']
    else if (TEXT_TO_VIDEO.test(id)) model.workflows = ['create']
    out.push(model)
  }
  return out
}

export const AIMLAPI_VIDEOS: VideoAdapter = {
  dialect: 'aimlapi-videos',
  kind: 'video',
  pollIntervalMs: { first: 5_000, max: 20_000 },

  async listModels(ctx) {
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/models'))
    return aimlapiVideoModels(answer.json)
  },

  async submit(ctx, job) {
    const body = aimlapiVideoBody(job, ctx.provider)
    const answer = await callProvider(ctx, aimlapiVideoUrl(ctx.baseUrl), { json: body })
    const fields = isObject(answer.json) ? answer.json : {}
    const id = fields['id'] ?? fields['generation_id']
    if (typeof id !== 'string' || id === '')
      throw remoteError(
        'REMOTE_UNAVAILABLE',
        `${ctx.provider} answered without a generation id.`,
        answer.text.slice(0, 500)
      )
    const status = typeof fields['status'] === 'string' ? fields['status'].toLowerCase() : ''
    if (status === 'error' || status === 'failed') throw aimlapiVideoError(ctx.provider, fields['error'])
    return { id }
  },

  async poll(ctx, submission) {
    const url = `${aimlapiVideoUrl(ctx.baseUrl)}?generation_id=${encodeURIComponent(submission.id)}`
    const answer = await callProvider(ctx, url)
    return readAimlapiVideo(ctx.provider, answer.json)
  },

  async download(ctx, _submission, result) {
    if (!result.url) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} gave no clip to download.`)
    const file = await downloadResult(ctx, result.url, { maxBytes: MAX_VIDEO_BYTES, what: 'video' })
    const mime = sniffVideoMime(file.bytes)
    if (!mime) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not a video.`)
    return { bytes: file.bytes, mime }
  },
}
