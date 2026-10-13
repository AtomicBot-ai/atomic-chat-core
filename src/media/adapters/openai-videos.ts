/**
 * `openai-videos`: the shape of the OpenAI Videos API. OpenAI shut its own Videos API down on
 * 2026-09-24; the shape lives on at Eden AI (`https://api.edenai.run/v3`) and in OpenAI-compatible
 * servers, another Atomic Chat core among them (`http://host:1337/v1`, text to video only).
 *
 * Every URL is the registered `ctx.baseUrl` joined with a fixed path:
 * - submit: `POST {base}/videos`. `create` sends JSON `{model, prompt, seconds, size, seed,
 *   negative_prompt}`. `image-to-video` sends multipart with the first frame as the `input_reference`
 *   file part: OpenAI's own form, and the one Eden AI documents for a local image (its JSON
 *   `input_reference.image_url` must be a public URL; data URLs are refused). A model whose
 *   `options.input_reference` is `image_url` gets JSON `input_reference: {image_url: <data URL>}`
 *   instead, for a server that takes it. There is no last frame in this API.
 * - poll: `GET {base}/videos/{id}` → `queued | in_progress | completed | failed` (`cancelled` and
 *   `expired` fail too), `progress` 0..100, `error: {code, message}`.
 * - download: `GET {base}/videos/{id}/content`. Eden AI answers with a redirect to a signed URL;
 *   `downloadResult` follows it and leaves the key home.
 * - cancel: `DELETE {base}/videos/{id}`, best effort (Eden AI answers 409 while a clip runs).
 * - models: `GET {base}/videos/models` (Eden AI); a server without that route lists none.
 *
 * `seconds` goes as a number (Eden AI's schema; the Atomic core takes both); a model whose
 * `options.seconds_as_string` is true gets OpenAI's original string form (`"8"`).
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
  SHORT_TIMEOUT_MS,
  sniffVideoMime,
  toDataUrl,
} from '../http.js'
import type { MediaContext } from '../http.js'
import type { VideoAdapter, VideoGenerationJob, VideoPoll } from './types.js'

type Fields = Record<string, unknown>

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const BLOCKED = /moderation|content[ _-]?polic|safety|nsfw|sensitive|prohibited|blocked|flagged/i

/** The plain fields of a submit, each only when the job set it and the model offers it. */
export function openaiVideoFields(job: VideoGenerationJob): Record<string, string | number> {
  const params = job.model.params
  const body: Record<string, string | number> = { model: job.model.id, prompt: job.prompt }
  if (job.durationSecs !== undefined && params.durations)
    body['seconds'] =
      job.model.options?.['seconds_as_string'] === true ? String(job.durationSecs) : job.durationSecs
  if (job.size && params.sizes) body['size'] = job.size
  if (job.seed !== undefined && params.seed) body['seed'] = job.seed
  if (job.negativePrompt && params.negative_prompt) body['negative_prompt'] = job.negativePrompt
  return body
}

/** A failed job's `error` as the closest `REMOTE_*` code, with the provider's words. */
export function openaiVideoError(provider: string, status: string, error: unknown): AtomicCoreError {
  const code = isObject(error) && typeof error['code'] === 'string' ? error['code'] : ''
  const said = providerMessage({ error })
  const details = [code, said].filter(Boolean).join(': ') || status
  if (BLOCKED.test(`${code} ${said ?? ''}`))
    return remoteError('REMOTE_CONTENT_BLOCKED', `${provider} refused the request: ${said ?? code}`, details)
  if (/invalid|unsupported|bad_request/i.test(code))
    return remoteError(
      'REMOTE_REJECTED',
      said ? `${provider}: ${said}` : `${provider} refused the request.`,
      details
    )
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

/** `progress` 0..100 as a fraction, when the answer carries one. */
function progressOf(value: unknown): { progress?: number } {
  return typeof value === 'number' && Number.isFinite(value)
    ? { progress: Math.min(1, Math.max(0, value / 100)) }
    : {}
}

/** One video object (`GET {base}/videos/{id}`, or the submit's answer) as a poll result. */
export function readOpenaiVideo(provider: string, json: unknown): VideoPoll {
  const fields = isObject(json) ? json : {}
  const status = typeof fields['status'] === 'string' ? fields['status'].toLowerCase() : ''
  switch (status) {
    case 'queued':
    case 'pending':
      return { state: 'queued', ...progressOf(fields['progress']) }
    case 'completed':
    case 'succeeded':
      return { state: 'completed', result: {} }
    case 'failed':
    case 'cancelled':
    case 'canceled':
    case 'expired':
      return { state: 'failed', error: openaiVideoError(provider, status, fields['error']) }
    default:
      // `in_progress`, and anything this core does not know yet: keep polling.
      return { state: 'running', ...progressOf(fields['progress']) }
  }
}

/** The models of a `GET {base}/videos/models` answer (`{data: [{id}]}`). */
export function openaiVideoModels(json: unknown): LiveMediaModel[] {
  const fields = isObject(json) ? json : {}
  const data = fields['data'] ?? fields['models'] ?? json
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data) ? data : []) {
    if (!isObject(item) || typeof item['id'] !== 'string' || item['id'] === '' || seen.has(item['id']))
      continue
    seen.add(item['id'])
    const name = typeof item['name'] === 'string' && item['name'] !== '' ? item['name'] : undefined
    out.push(name ? { id: item['id'], name } : { id: item['id'] })
  }
  return out
}

function videoUrl(ctx: MediaContext, id: string, suffix = ''): string {
  return joinUrl(ctx.baseUrl, `/videos/${encodeURIComponent(id)}${suffix}`)
}

function submitForm(job: VideoGenerationJob, frame: { bytes: Buffer; mime: string }): FormData {
  const form = new FormData()
  for (const [key, value] of Object.entries(openaiVideoFields(job))) form.append(key, String(value))
  const ext = frame.mime.split('/')[1] ?? 'png'
  form.append(
    'input_reference',
    new Blob([new Uint8Array(frame.bytes)], { type: frame.mime }),
    `frame.${ext}`
  )
  return form
}

export const OPENAI_VIDEOS: VideoAdapter = {
  dialect: 'openai-videos',
  kind: 'video',
  pollIntervalMs: { first: 5_000, max: 20_000 },

  async listModels(ctx) {
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/videos/models'), {
      accept: [400, 404, 405],
    })
    return answer.status === 200 ? openaiVideoModels(answer.json) : []
  },

  async submit(ctx, job) {
    const url = joinUrl(ctx.baseUrl, '/videos')
    let answer
    if (job.workflow === 'image-to-video') {
      if (!job.firstFrame)
        throw remoteError('REMOTE_UNSUPPORTED', 'Image to video needs a first frame.', job.workflow)
      if (job.lastFrame)
        throw remoteError('REMOTE_UNSUPPORTED', `${ctx.provider} takes no last frame.`, job.model.id)
      if (job.model.options?.['input_reference'] === 'image_url') {
        const body = {
          ...openaiVideoFields(job),
          input_reference: { image_url: toDataUrl(job.firstFrame.bytes, job.firstFrame.mime) },
        }
        answer = await callProvider(ctx, url, { json: body })
      } else answer = await callProvider(ctx, url, { form: submitForm(job, job.firstFrame) })
    } else answer = await callProvider(ctx, url, { json: openaiVideoFields(job) })
    const fields = isObject(answer.json) ? answer.json : {}
    const id = fields['id']
    if (typeof id !== 'string' || id === '')
      throw remoteError(
        'REMOTE_UNAVAILABLE',
        `${ctx.provider} answered without a job id.`,
        answer.text.slice(0, 500)
      )
    const state = readOpenaiVideo(ctx.provider, fields)
    if (state.state === 'failed') throw state.error
    return { id }
  },

  async poll(ctx, submission) {
    const answer = await callProvider(ctx, videoUrl(ctx, submission.id))
    return readOpenaiVideo(ctx.provider, answer.json)
  },

  async download(ctx, submission) {
    const file = await downloadResult(ctx, videoUrl(ctx, submission.id, '/content'), {
      maxBytes: MAX_VIDEO_BYTES,
      what: 'video',
    })
    const mime = sniffVideoMime(file.bytes)
    if (!mime) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not a video.`)
    return { bytes: file.bytes, mime }
  },

  async cancel(ctx, submission) {
    // The job's signal has usually fired by now (that is why it is cancelled), so the request
    // carries only its own deadline.
    const own: MediaContext = { ...ctx, signal: new AbortController().signal }
    try {
      await callProvider(own, videoUrl(ctx, submission.id), { method: 'DELETE', timeoutMs: SHORT_TIMEOUT_MS })
    } catch (error) {
      const said = error instanceof Error ? error.message : String(error)
      ctx.log('debug', `${ctx.provider} did not cancel video ${submission.id}: ${said}`)
    }
  },
}
