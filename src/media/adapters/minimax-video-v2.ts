/**
 * `minimax-video-v2`: MiniMax's V2 video API (MiniMax H3, H3 Max). The provider is registered with its
 * V1 base (`https://api.minimax.io/v1`); V2 lives next to it, so `minimaxV2Base` swaps the trailing
 * `/v1` for `/v2` (`https://api.minimax.io/v2`).
 *
 * - submit → `POST {v2}/video_generation` `{model, content, resolution, duration, ratio}`, where
 *   `content` is the prompt as a `text` item and the frames as `image_url` items with a
 *   `first_frame`/`last_frame` role; `resolution` and `duration` are required, and text to video
 *   needs a concrete `ratio` (image to video follows the frame) → `{task_id}`;
 * - poll → `GET {v2}/query/video_generation/{task_id}` → `task.status` queued | running | succeeded |
 *   failed | cancelled, `task.content.url` once it succeeded, `task.error {code, message}` once it
 *   failed;
 * - download → `task.content.url`, time-limited; an expired link is refreshed by asking again;
 * - cancel → `DELETE {v2}/video_generation/{task_id}` (only a queued task; errors are ignored).
 *
 * V2 answers real HTTP statuses with an OpenAI-style error body; 422 is a content refusal.
 */

import type { AtomicCoreError } from '../../contracts/index.js'
import {
  callProvider,
  downloadResult,
  MAX_VIDEO_BYTES,
  providerMessage,
  remoteError,
  remoteHttpError,
  sniffVideoMime,
  toDataUrl,
} from '../http.js'
import type { CallOptions, MediaContext } from '../http.js'
import { minimaxCodeError } from './minimax-video.js'
import type { VideoAdapter, VideoGenerationJob, VideoPoll } from './types.js'

type Fields = Record<string, unknown>

const fields = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {}

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** A content refusal the provider names by MiniMax's code in its message: `... (1026)`. */
const BLOCKED_CODE = /\((1026|1027)\)/

/** The V2 base next to the registered V1 one: `…/v1` → `…/v2`; a base without a version gets `/v2`. */
export function minimaxV2Base(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  if (/\/v2$/.test(trimmed)) return trimmed
  if (/\/v1$/.test(trimmed)) return trimmed.replace(/\/v1$/, '/v2')
  return `${trimmed}/v2`
}

/** A V2 non-2xx answer as a `REMOTE_*` error: 422 and a 1026/1027 message are content refusals. */
export function minimaxV2HttpError(
  provider: string,
  status: number,
  body: unknown,
  text = ''
): AtomicCoreError {
  const said = providerMessage(body, text)
  if (status === 422 || (said && BLOCKED_CODE.test(said)))
    return remoteError(
      'REMOTE_CONTENT_BLOCKED',
      said ? `${provider} refused the content: ${said}` : `${provider} refused the content.`,
      `HTTP ${status}${said ? `: ${said}` : ''}`
    )
  return remoteHttpError(provider, status, body, text)
}

/** A failed task's `error {code, message}` as a `REMOTE_*` error. */
export function minimaxTaskError(provider: string, error: unknown): AtomicCoreError {
  const said = textOf(fields(error)['message'])
  const raw = fields(error)['code']
  const code =
    typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN
  if (Number.isFinite(code)) return minimaxCodeError(provider, code, said)
  // No numeric code: the same words-based reading as an HTTP refusal.
  if (said) {
    const mapped = remoteHttpError(provider, 400, { message: said })
    if (mapped.code === 'REMOTE_CONTENT_BLOCKED') return mapped
  }
  return remoteError(
    'REMOTE_UNAVAILABLE',
    said ? `${provider} could not make the clip: ${said}` : `${provider} could not make the clip.`,
    typeof raw === 'string' ? raw : undefined
  )
}

/** One V2 request: a 400 or 422 read with `minimaxV2HttpError`, other statuses as `callProvider` does. */
async function callV2(ctx: MediaContext, url: string, options: CallOptions = {}): Promise<Fields> {
  const answer = await callProvider(ctx, url, { ...options, accept: [400, 422] })
  if (answer.status === 400 || answer.status === 422)
    throw minimaxV2HttpError(ctx.provider, answer.status, answer.json, answer.text)
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

/**
 * The `POST /video_generation` body. `resolution` and `duration` are required, so the model's
 * defaults fill in what the job left out; text to video takes the job's ratio or the model's default
 * (`16:9` without one), image to video none.
 */
export function minimaxV2Body(job: VideoGenerationJob): Fields {
  checkInputs(job)
  const params = job.model.params
  const content: Fields[] = [{ type: 'text', text: job.prompt }]
  if (job.workflow === 'image-to-video' && job.firstFrame) {
    content.push({
      type: 'image_url',
      image_url: { url: toDataUrl(job.firstFrame.bytes, job.firstFrame.mime) },
      role: 'first_frame',
    })
    if (job.lastFrame)
      content.push({
        type: 'image_url',
        image_url: { url: toDataUrl(job.lastFrame.bytes, job.lastFrame.mime) },
        role: 'last_frame',
      })
  }
  const body: Fields = {
    model: job.model.id,
    content,
    resolution: job.resolution ?? params.resolutions?.default ?? params.resolutions?.values[0] ?? '768P',
    duration: Math.round(job.durationSecs ?? params.durations?.default ?? params.durations?.min ?? 6),
  }
  if (job.workflow === 'create') body['ratio'] = job.aspectRatio ?? params.aspect_ratios?.default ?? '16:9'
  return body
}

async function pollTask(ctx: MediaContext, id: string): Promise<VideoPoll> {
  const body = await callV2(
    ctx,
    `${minimaxV2Base(ctx.baseUrl)}/query/video_generation/${encodeURIComponent(id)}`
  )
  const task = 'task' in body ? fields(body['task']) : body
  const status = typeof task['status'] === 'string' ? task['status'].toLowerCase() : ''
  switch (status) {
    case 'queued':
      return { state: 'queued' }
    case 'succeeded': {
      const url = textOf(fields(task['content'])['url'])
      if (!url)
        return {
          state: 'failed',
          error: remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} finished without a clip.`),
        }
      return { state: 'completed', result: { url } }
    }
    case 'failed':
      return { state: 'failed', error: minimaxTaskError(ctx.provider, task['error']) }
    case 'cancelled':
      return { state: 'failed', error: remoteError('CANCELLED', `${ctx.provider} cancelled the generation.`) }
    default:
      return { state: 'running' }
  }
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

/** The clip's link as the task gives it now. */
async function refreshedUrl(ctx: MediaContext, id: string): Promise<string> {
  const poll = await pollTask(ctx, id)
  if (poll.state === 'completed' && poll.result.url) return poll.result.url
  if (poll.state === 'failed') throw poll.error
  throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} has no clip for this task.`, poll.state)
}

/** A link refused like this has most likely expired; the task hands out a fresh one. */
const EXPIRED: readonly string[] = ['REMOTE_AUTH_FAILED', 'REMOTE_REJECTED']

export const MINIMAX_VIDEO_V2: VideoAdapter = {
  dialect: 'minimax-video-v2',
  kind: 'video',
  pollIntervalMs: { first: 5000, max: 15000 },

  async submit(ctx, job) {
    const body = await callV2(ctx, `${minimaxV2Base(ctx.baseUrl)}/video_generation`, {
      json: minimaxV2Body(job),
    })
    const id =
      textOf(body['task_id']) ?? (typeof body['task_id'] === 'number' ? String(body['task_id']) : undefined)
    if (!id) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without a task id.`)
    return { id }
  },

  poll(ctx, submission) {
    return pollTask(ctx, submission.id)
  },

  async download(ctx, submission, result) {
    const first = result.url ?? (await refreshedUrl(ctx, submission.id))
    try {
      return await fetchClip(ctx, first)
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (!result.url || typeof code !== 'string' || !EXPIRED.includes(code)) throw error
      const fresh = await refreshedUrl(ctx, submission.id)
      if (fresh === first) throw error
      return fetchClip(ctx, fresh)
    }
  },

  async cancel(ctx, submission) {
    try {
      await callProvider(
        ctx,
        `${minimaxV2Base(ctx.baseUrl)}/video_generation/${encodeURIComponent(submission.id)}`,
        {
          method: 'DELETE',
        }
      )
    } catch (error) {
      // Only a queued task can be cancelled; a running one just finishes.
      ctx.log('debug', `${ctx.provider}: cancel of ${submission.id} refused: ${(error as Error).message}`)
    }
  },
}
