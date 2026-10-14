/**
 * `xai-videos`: xAI's Grok Imagine video API (registered base `https://api.x.ai/v1`).
 *
 * Every URL is derived from `ctx.baseUrl`:
 * - submit: `POST {base}/videos/generations`, JSON `{model, prompt, duration, aspect_ratio,
 *   resolution, generate_audio, image: {url}, last_frame: {url}}` → `{request_id}`. Frames go as data
 *   URLs. xAI ignores `aspect_ratio` for image to video (the clip takes the image's).
 * - poll: `GET {base}/videos/{request_id}` → `pending | done | failed | expired`, `progress` 0..100,
 *   `video: {url, duration, respect_moderation}`, `error: {code, message}`. A `done` clip that
 *   moderation withheld (`respect_moderation: false`, no URL) is `REMOTE_CONTENT_BLOCKED`.
 * - download: `video.url`, a temporary file on xAI's CDN; off the API's origin it goes without the key.
 * - models: `GET {base}/video-generation-models` → `{models: [{id}]}`.
 *
 * No cancel: xAI has none.
 */

import type { AtomicCoreError } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  downloadResult,
  joinUrl,
  MAX_VIDEO_BYTES,
  providerMessage,
  remoteError,
  sniffVideoMime,
  toDataUrl,
} from '../http.js'
import type { VideoAdapter, VideoGenerationJob, VideoPoll } from './types.js'

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const BLOCKED = /moderation|content[ _-]?polic|safety|nsfw|sensitive|prohibited|blocked|flagged/i

/** The submit body: each field only when the job set it and the model offers it; frames as data URLs. */
export function xaiVideoBody(job: VideoGenerationJob, provider = 'xAI'): Fields {
  const params = job.model.params
  const body: Fields = { model: job.model.id, prompt: job.prompt }
  if (job.durationSecs !== undefined && params.durations) body['duration'] = Math.round(job.durationSecs)
  if (job.aspectRatio && params.aspect_ratios) body['aspect_ratio'] = job.aspectRatio
  if (job.resolution && params.resolutions) body['resolution'] = job.resolution
  if (job.generateAudio !== undefined && params.audio) body['generate_audio'] = job.generateAudio
  if (job.seed !== undefined && params.seed) body['seed'] = job.seed
  if (job.workflow === 'image-to-video') {
    if (!job.firstFrame)
      throw remoteError('REMOTE_UNSUPPORTED', 'Image to video needs a first frame.', job.workflow)
    body['image'] = { url: toDataUrl(job.firstFrame.bytes, job.firstFrame.mime) }
    if (job.lastFrame) {
      if (!params.last_frame)
        throw remoteError(
          'REMOTE_UNSUPPORTED',
          `${provider} takes no last frame for this model.`,
          job.model.id
        )
      body['last_frame'] = { url: toDataUrl(job.lastFrame.bytes, job.lastFrame.mime) }
    }
  }
  return body
}

/** A failed job's `error: {code, message}` as the closest `REMOTE_*` code. */
export function xaiVideoError(provider: string, error: unknown): AtomicCoreError {
  const code = isObject(error) && typeof error['code'] === 'string' ? error['code'].toLowerCase() : ''
  const said = providerMessage({ error })
  const details = [code, said].filter(Boolean).join(': ') || undefined
  if (BLOCKED.test(said ?? ''))
    return remoteError('REMOTE_CONTENT_BLOCKED', `${provider} refused the request: ${said}`, details)
  if (code === 'invalid_argument' || code === 'failed_precondition')
    return remoteError(
      'REMOTE_REJECTED',
      said ? `${provider}: ${said}` : `${provider} refused the request.`,
      details
    )
  if (code === 'permission_denied' || code === 'unauthenticated')
    return remoteError('REMOTE_AUTH_FAILED', `${provider} refused the API key or the model.`, details)
  if (code === 'resource_exhausted')
    return remoteError('REMOTE_RATE_LIMITED', `${provider} is rate-limiting requests.`, details)
  return remoteError(
    'REMOTE_UNAVAILABLE',
    said ? `${provider} failed to make the clip: ${said}` : `${provider} failed to make the clip.`,
    details
  )
}

function progressOf(value: unknown): { progress?: number } {
  return typeof value === 'number' && Number.isFinite(value)
    ? { progress: Math.min(1, Math.max(0, value / 100)) }
    : {}
}

/** One `GET {base}/videos/{request_id}` answer as a poll result. */
export function readXaiVideo(provider: string, json: unknown): VideoPoll {
  const fields = isObject(json) ? json : {}
  const status = typeof fields['status'] === 'string' ? fields['status'].toLowerCase() : ''
  switch (status) {
    case 'done':
    case 'completed': {
      const video = isObject(fields['video']) ? fields['video'] : {}
      const url = typeof video['url'] === 'string' ? video['url'].trim() : ''
      if (url !== '') return { state: 'completed', result: { url } }
      if (video['respect_moderation'] === false)
        return {
          state: 'failed',
          error: remoteError('REMOTE_CONTENT_BLOCKED', `${provider} withheld the clip by moderation.`),
        }
      return {
        state: 'failed',
        error: remoteError('REMOTE_UNAVAILABLE', `${provider} finished without a clip.`),
      }
    }
    case 'failed':
      return { state: 'failed', error: xaiVideoError(provider, fields['error']) }
    case 'expired':
      return {
        state: 'failed',
        error: remoteError('REMOTE_UNAVAILABLE', `${provider} let the clip expire before it was fetched.`),
      }
    default:
      // `pending`: xAI does not tell a queue from a render.
      return { state: 'running', ...progressOf(fields['progress']) }
  }
}

/** The models of a `GET {base}/video-generation-models` answer. */
export function xaiVideoModels(json: unknown): LiveMediaModel[] {
  const fields = isObject(json) ? json : {}
  const data = fields['models'] ?? fields['data']
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data) ? data : []) {
    if (!isObject(item) || typeof item['id'] !== 'string' || item['id'] === '' || seen.has(item['id']))
      continue
    seen.add(item['id'])
    out.push({ id: item['id'] })
  }
  return out
}

export const XAI_VIDEOS: VideoAdapter = {
  dialect: 'xai-videos',
  kind: 'video',
  pollIntervalMs: { first: 5_000, max: 15_000 },

  async listModels(ctx) {
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/video-generation-models'), {
      accept: [404],
    })
    return answer.status === 200 ? xaiVideoModels(answer.json) : []
  },

  async submit(ctx, job) {
    const body = xaiVideoBody(job, ctx.provider)
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/videos/generations'), { json: body })
    const fields = isObject(answer.json) ? answer.json : {}
    const id = fields['request_id'] ?? fields['id']
    if (typeof id !== 'string' || id === '')
      throw remoteError(
        'REMOTE_UNAVAILABLE',
        `${ctx.provider} answered without a request id.`,
        answer.text.slice(0, 500)
      )
    return { id }
  },

  async poll(ctx, submission) {
    // 202 is how xAI's other deferred routes say "not yet"; take it as a pending job.
    const answer = await callProvider(
      ctx,
      joinUrl(ctx.baseUrl, `/videos/${encodeURIComponent(submission.id)}`),
      {
        accept: [202],
      }
    )
    return readXaiVideo(ctx.provider, answer.json)
  },

  async download(ctx, _submission, result) {
    if (!result.url) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} gave no clip to download.`)
    const file = await downloadResult(ctx, result.url, { maxBytes: MAX_VIDEO_BYTES, what: 'video' })
    const mime = sniffVideoMime(file.bytes)
    if (!mime) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not a video.`)
    return { bytes: file.bytes, mime }
  },
}
