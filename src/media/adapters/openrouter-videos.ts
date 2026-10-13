/**
 * `openrouter-videos`: OpenRouter's video API (registered base `https://openrouter.ai/api/v1`).
 *
 * Every URL is derived from `ctx.baseUrl`:
 * - submit: `POST {base}/videos`, JSON `{model, prompt, duration, resolution, aspect_ratio, size,
 *   generate_audio, seed, frame_images}` → 202 `{id, polling_url, status}`. Frames go as
 *   `frame_images: [{type: 'image_url', image_url: {url: <data URL>}, frame_type: 'first_frame' |
 *   'last_frame'}]`.
 * - poll: the answer's `polling_url` (resolved against the base) when it is on the base's own origin,
 *   else `GET {base}/videos/{id}` → `pending | in_progress | completed | failed | cancelled |
 *   expired`, with `unsigned_urls` once completed.
 * - download: `unsigned_urls[0]` (OpenRouter's own content route, so the key goes along; a URL off
 *   its origin goes bare), else `GET {base}/videos/{id}/content?index=0`.
 * - models: `GET {base}/videos/models`, translated into the form's parameters the way conf builds
 *   its catalog from the same listing.
 *
 * No cancel: OpenRouter documents none.
 */

import type { AtomicCoreError, MediaChoice, MediaVideoParams } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  downloadResult,
  joinUrl,
  MAX_VIDEO_BYTES,
  originOf,
  providerMessage,
  remoteError,
  sniffVideoMime,
  toDataUrl,
} from '../http.js'
import type { MediaContext } from '../http.js'
import type { MediaInput, VideoAdapter, VideoGenerationJob, VideoPoll } from './types.js'

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const BLOCKED = /moderation|content[ _-]?polic|safety|nsfw|sensitive|prohibited|blocked|flagged/i

function frame(input: MediaInput, type: 'first_frame' | 'last_frame'): Fields {
  return { type: 'image_url', image_url: { url: toDataUrl(input.bytes, input.mime) }, frame_type: type }
}

/**
 * The submit body: each field only when the job set it and the model offers it; for
 * `image-to-video` the frames.
 */
export function openrouterVideoBody(job: VideoGenerationJob, provider = 'OpenRouter'): Fields {
  const params = job.model.params
  const body: Fields = { model: job.model.id, prompt: job.prompt }
  if (job.durationSecs !== undefined && params.durations) body['duration'] = Math.round(job.durationSecs)
  if (job.resolution && params.resolutions) body['resolution'] = job.resolution
  if (job.aspectRatio && params.aspect_ratios) body['aspect_ratio'] = job.aspectRatio
  if (job.size && params.sizes) body['size'] = job.size
  if (job.generateAudio !== undefined && params.audio) body['generate_audio'] = job.generateAudio
  if (job.seed !== undefined && params.seed) body['seed'] = job.seed
  if (job.workflow === 'image-to-video') {
    if (!job.firstFrame)
      throw remoteError('REMOTE_UNSUPPORTED', 'Image to video needs a first frame.', job.workflow)
    const frames = [frame(job.firstFrame, 'first_frame')]
    if (job.lastFrame) {
      if (!params.last_frame)
        throw remoteError(
          'REMOTE_UNSUPPORTED',
          `${provider} takes no last frame for this model.`,
          job.model.id
        )
      frames.push(frame(job.lastFrame, 'last_frame'))
    }
    body['frame_images'] = frames
  }
  return body
}

/** `polling_url` as an absolute URL, when it is on the base's own origin; anything else is ignored. */
export function ownPollingUrl(baseUrl: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  let url: URL
  try {
    url = new URL(value.trim(), `${baseUrl.replace(/\/+$/, '')}/`)
  } catch {
    return undefined
  }
  return url.origin === originOf(baseUrl) ? url.toString() : undefined
}

function failure(provider: string, status: string, error: unknown): AtomicCoreError {
  const said = providerMessage({ error })
  const code = isObject(error) && typeof error['code'] === 'string' ? error['code'] : ''
  const details = [code, said].filter(Boolean).join(': ') || status
  if (BLOCKED.test(`${code} ${said ?? ''}`))
    return remoteError('REMOTE_CONTENT_BLOCKED', `${provider} refused the request: ${said ?? code}`, details)
  if (status === 'cancelled' || status === 'canceled')
    return remoteError('REMOTE_UNAVAILABLE', `${provider} cancelled the clip.`, details)
  if (status === 'expired')
    return remoteError('REMOTE_UNAVAILABLE', `${provider} let the clip expire.`, details)
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

/** One job answer as a poll result. */
export function readOpenrouterVideo(provider: string, json: unknown): VideoPoll {
  const fields = isObject(json) ? json : {}
  const status = typeof fields['status'] === 'string' ? fields['status'].toLowerCase() : ''
  switch (status) {
    case 'pending':
    case 'queued':
      return { state: 'queued', ...progressOf(fields['progress']) }
    case 'completed':
    case 'succeeded': {
      const urls = fields['unsigned_urls']
      const first = Array.isArray(urls)
        ? urls.find((u): u is string => typeof u === 'string' && u !== '')
        : undefined
      return { state: 'completed', result: first ? { url: first } : {} }
    }
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'expired':
      return { state: 'failed', error: failure(provider, status, fields['error']) }
    default:
      return { state: 'running', ...progressOf(fields['progress']) }
  }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? [...new Set(value.filter((v): v is string => typeof v === 'string' && v !== ''))]
    : []

function choiceOf(values: string[], preferred: string): MediaChoice {
  return { values, default: values.includes(preferred) ? preferred : (values[0] as string) }
}

/** One `/videos/models` entry's capabilities as the form's parameters and workflows. */
export function openrouterVideoParams(entry: Fields): { workflows: string[]; params: MediaVideoParams } {
  const params: MediaVideoParams = {}
  const durations = Array.isArray(entry['supported_durations'])
    ? [
        ...new Set(entry['supported_durations'].filter((d): d is number => typeof d === 'number' && d > 0)),
      ].sort((a, b) => a - b)
    : []
  if (durations.length > 0)
    params.durations = {
      values: durations,
      default: durations.includes(8) ? 8 : durations.includes(5) ? 5 : (durations[0] as number),
    }
  const resolutions = strings(entry['supported_resolutions'])
  if (resolutions.length > 0) params.resolutions = choiceOf(resolutions, '720p')
  const aspects = strings(entry['supported_aspect_ratios'])
  if (aspects.length > 0) params.aspect_ratios = choiceOf(aspects, '16:9')
  if (entry['generate_audio'] === true) params.audio = true
  if (entry['seed'] === true) params.seed = true
  const frames = strings(entry['supported_frame_images'])
  if (frames.includes('last_frame')) params.last_frame = true
  return { workflows: frames.includes('first_frame') ? ['create', 'image-to-video'] : ['create'], params }
}

/**
 * The models of a `GET {base}/videos/models` answer. An entry without durations is an editing,
 * upscaling or avatar model that needs a video or a voice the form does not have; it is left out.
 */
export function openrouterVideoModels(json: unknown): LiveMediaModel[] {
  const data = isObject(json) ? json['data'] : json
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data) ? data : []) {
    if (!isObject(item) || typeof item['id'] !== 'string' || item['id'] === '' || seen.has(item['id']))
      continue
    if (!Array.isArray(item['supported_durations']) || item['supported_durations'].length === 0) continue
    seen.add(item['id'])
    const { workflows, params } = openrouterVideoParams(item)
    const model: LiveMediaModel = { id: item['id'], workflows, params }
    const name = typeof item['name'] === 'string' ? item['name'].trim() : ''
    // "Google: Veo 3.1" → "Veo 3.1"
    if (name !== '') model.name = name.includes(': ') ? name.slice(name.indexOf(': ') + 2) : name
    out.push(model)
  }
  return out
}

function jobUrl(ctx: MediaContext, id: string, suffix = ''): string {
  return joinUrl(ctx.baseUrl, `/videos/${encodeURIComponent(id)}${suffix}`)
}

export const OPENROUTER_VIDEOS: VideoAdapter = {
  dialect: 'openrouter-videos',
  kind: 'video',
  pollIntervalMs: { first: 10_000, max: 30_000 },

  async listModels(ctx) {
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/videos/models'))
    return openrouterVideoModels(answer.json)
  },

  async submit(ctx, job) {
    const body = openrouterVideoBody(job, ctx.provider)
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/videos'), { json: body })
    const fields = isObject(answer.json) ? answer.json : {}
    const id = fields['id']
    if (typeof id !== 'string' || id === '')
      throw remoteError(
        'REMOTE_UNAVAILABLE',
        `${ctx.provider} answered without a job id.`,
        answer.text.slice(0, 500)
      )
    const state = readOpenrouterVideo(ctx.provider, fields)
    if (state.state === 'failed') throw state.error
    const polling = ownPollingUrl(ctx.baseUrl, fields['polling_url'])
    return polling ? { id, data: { polling_url: polling } } : { id }
  },

  async poll(ctx, submission) {
    const url = ownPollingUrl(ctx.baseUrl, submission.data?.['polling_url']) ?? jobUrl(ctx, submission.id)
    const answer = await callProvider(ctx, url)
    return readOpenrouterVideo(ctx.provider, answer.json)
  },

  async download(ctx, submission, result) {
    const url = result.url ?? jobUrl(ctx, submission.id, '/content?index=0')
    const file = await downloadResult(ctx, url, { maxBytes: MAX_VIDEO_BYTES, what: 'video' })
    const mime = sniffVideoMime(file.bytes)
    if (!mime) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not a video.`)
    return { bytes: file.bytes, mime }
  },
}
