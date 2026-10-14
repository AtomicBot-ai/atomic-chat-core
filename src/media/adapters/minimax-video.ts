/**
 * `minimax-video`: MiniMax's V1 video API (Hailuo 2.3, Hailuo 2.3 Fast, Hailuo 02) on the registered
 * base, `https://api.minimax.io/v1` (`https://api.minimaxi.com/v1` in mainland China).
 *
 * - submit → `POST {base}/video_generation` `{model, prompt, prompt_optimizer, duration, resolution,
 *   first_frame_image, last_frame_image}` (frames as data URLs) → `{task_id}`;
 * - poll → `GET {base}/query/video_generation?task_id=` → `status` Preparing | Queueing | Processing |
 *   Success | Fail, and `file_id` once it succeeded;
 * - download → `GET {base}/files/retrieve?file_id=` → `file.download_url` (a CDN link valid for an
 *   hour, fetched without the key) → the clip.
 *
 * No cancel and no listing: the catalog names the models. V1 answers most failures as HTTP 200 with
 * `base_resp.status_code` other than 0; `minimaxStatusError` maps those codes.
 */

import type { AtomicCoreError } from '../../contracts/index.js'
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
import type { CallOptions, MediaContext } from '../http.js'
import type { VideoAdapter, VideoGenerationJob } from './types.js'

type Fields = Record<string, unknown>

const fields = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {}

/** A string, or a number the provider sent where a string id was meant. */
const idOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : undefined

/** A MiniMax status code (`base_resp.status_code`, a failed task's `error.code`) as a `REMOTE_*` error. */
export function minimaxCodeError(provider: string, code: number, said: string | undefined): AtomicCoreError {
  const details = `status_code ${code}${said ? `: ${said}` : ''}`
  switch (code) {
    case 1002:
    case 1039:
      return remoteError('REMOTE_RATE_LIMITED', `${provider} is rate-limiting requests.`, details)
    case 1004:
    case 2049:
      return remoteError('REMOTE_AUTH_FAILED', `${provider} refused the API key or the model.`, details)
    case 1008:
      return remoteError('REMOTE_QUOTA', `${provider} says the account is out of credit.`, details)
    case 1026:
    case 1027:
      return remoteError(
        'REMOTE_CONTENT_BLOCKED',
        said ? `${provider} refused the content: ${said}` : `${provider} refused the content.`,
        details
      )
    case 2013:
      return remoteError(
        'REMOTE_REJECTED',
        said ? `${provider}: ${said}` : `${provider} refused the request.`,
        details
      )
    default:
      return remoteError(
        'REMOTE_UNAVAILABLE',
        said ? `${provider} failed: ${said}` : `${provider} failed.`,
        details
      )
  }
}

/**
 * The failure a V1 answer carries in `base_resp` (MiniMax answers errors as HTTP 200), or `undefined`
 * when `status_code` is 0 or absent.
 */
export function minimaxStatusError(provider: string, body: unknown): AtomicCoreError | undefined {
  const base = fields(fields(body)['base_resp'])
  const raw = base['status_code']
  const code = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : 0
  if (!Number.isFinite(code) || code === 0) return undefined
  return minimaxCodeError(provider, code, providerMessage(base))
}

/** One V1 request: HTTP errors as `REMOTE_*`, then a non-zero `base_resp` as one too. */
async function callV1(ctx: MediaContext, url: string, options: CallOptions = {}): Promise<Fields> {
  const answer = await callProvider(ctx, url, options)
  const failure = minimaxStatusError(ctx.provider, answer.json)
  if (failure) throw failure
  return fields(answer.json)
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

/** The `POST /video_generation` body: what the job set and the model offers. */
export function minimaxV1Body(job: VideoGenerationJob): Fields {
  checkInputs(job)
  const params = job.model.params
  const body: Fields = { model: job.model.id }
  if (job.prompt.trim() !== '') body['prompt'] = job.prompt
  body['prompt_optimizer'] = true
  if (job.durationSecs !== undefined && params.durations) body['duration'] = Math.round(job.durationSecs)
  if (job.resolution && params.resolutions) body['resolution'] = job.resolution
  if (job.workflow === 'image-to-video' && job.firstFrame) {
    body['first_frame_image'] = toDataUrl(job.firstFrame.bytes, job.firstFrame.mime)
    if (job.lastFrame) body['last_frame_image'] = toDataUrl(job.lastFrame.bytes, job.lastFrame.mime)
  }
  return body
}

/** A clip the provider pointed at, refused unless its bytes are a video. */
async function fetchClip(ctx: MediaContext, url: string): Promise<{ bytes: Buffer; mime: string }> {
  const file = await downloadResult(ctx, url, { maxBytes: MAX_VIDEO_BYTES, what: 'video' })
  const mime = sniffVideoMime(file.bytes)
  if (!mime)
    throw remoteError(
      'REMOTE_UNAVAILABLE',
      `${ctx.provider} returned a file that is not a video.`,
      file.mime || undefined
    )
  return { bytes: file.bytes, mime }
}

export const MINIMAX_VIDEO: VideoAdapter = {
  dialect: 'minimax-video',
  kind: 'video',
  pollIntervalMs: { first: 5000, max: 15000 },

  async submit(ctx, job) {
    const body = await callV1(ctx, joinUrl(ctx.baseUrl, '/video_generation'), { json: minimaxV1Body(job) })
    const id = idOf(body['task_id'])
    if (!id) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without a task id.`)
    return { id }
  },

  async poll(ctx, submission) {
    const answer = await callProvider(
      ctx,
      joinUrl(ctx.baseUrl, `/query/video_generation?task_id=${encodeURIComponent(submission.id)}`)
    )
    const body = fields(answer.json)
    const failure = minimaxStatusError(ctx.provider, body)
    const status = typeof body['status'] === 'string' ? body['status'].toLowerCase() : ''
    if (status === 'fail' || status === 'failed')
      return {
        state: 'failed',
        error: failure ?? remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} could not make the clip.`),
      }
    // A refused prompt or result ends the job; any other code is the query's own failure.
    if (failure?.code === 'REMOTE_CONTENT_BLOCKED') return { state: 'failed', error: failure }
    if (failure) throw failure
    if (status === 'success') {
      const fileId = idOf(body['file_id'])
      if (!fileId)
        return {
          state: 'failed',
          error: remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} finished without a file.`),
        }
      return { state: 'completed', result: { data: { file_id: fileId } } }
    }
    if (status === 'preparing' || status === 'queueing' || status === 'queued') return { state: 'queued' }
    return { state: 'running' }
  },

  async download(ctx, _submission, result) {
    const fileId = idOf(result.data?.['file_id'])
    if (!fileId) {
      if (result.url) return fetchClip(ctx, result.url)
      throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} gave no file to download.`)
    }
    const body = await callV1(
      ctx,
      joinUrl(ctx.baseUrl, `/files/retrieve?file_id=${encodeURIComponent(fileId)}`)
    )
    const url = fields(body['file'])['download_url']
    if (typeof url !== 'string' || url === '')
      throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without a download link.`, fileId)
    return fetchClip(ctx, url)
  },
}
