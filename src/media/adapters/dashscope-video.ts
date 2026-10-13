/**
 * `dashscope-video`: Alibaba Cloud Model Studio's (DashScope) Wan video models. The provider is
 * registered with its OpenAI-compatible base (`https://dashscope-intl.aliyuncs.com/compatible-mode/v1`,
 * or a workspace host); video lives on DashScope's native API on the same origin, so every URL is
 * `originOf(base)` + a native path.
 *
 * - submit → `POST {origin}/api/v1/services/aigc/video-generation/video-synthesis` with
 *   `X-DashScope-Async: enable` (required: the API is asynchronous only) and `{model, input:{prompt,
 *   negative_prompt, img_url | media}, parameters:{resolution | size, ratio, duration, prompt_extend,
 *   watermark, seed}}` → `{output:{task_id, task_status}}`. Wan 2.7 takes its frames as `media`
 *   (`first_frame`, `last_frame`) and `resolution` + `ratio`; older models take `img_url` and `size`
 *   (`1280*720`) or a `resolution` tier;
 * - poll → `GET {origin}/api/v1/tasks/{task_id}` → `output.task_status` PENDING | RUNNING | SUCCEEDED |
 *   FAILED | CANCELED | UNKNOWN (expired, past 24 h), `output.video_url` once it succeeded,
 *   `output.code`/`output.message` once it failed;
 * - download → `output.video_url`, a signed link valid for 24 h;
 * - cancel → `POST {origin}/api/v1/tasks/{task_id}/cancel` (only a pending task; errors are ignored);
 * - listing → `GET {origin}/api/v1/models?capabilities=VG` (`output.models[]`).
 *
 * DashScope names its errors by `code` (`InvalidParameter`, `DataInspectionFailed`, `Arrearage`, …);
 * `dashscopeCodeKind` reads those before the HTTP status.
 */

import type { AtomicCoreError, DiffusionErrorCode } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  downloadResult,
  MAX_VIDEO_BYTES,
  originOf,
  parseWxH,
  providerMessage,
  remoteError,
  remoteHttpError,
  sniffVideoMime,
  toDataUrl,
} from '../http.js'
import type { CallOptions, MediaContext } from '../http.js'
import type { VideoAdapter, VideoGenerationJob } from './types.js'

type Fields = Record<string, unknown>

const fields = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {}

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const SUBMIT_PATH = '/api/v1/services/aigc/video-generation/video-synthesis'

/** Wan 2.7 speaks the newer protocol: frames as `media`, `resolution` + `ratio`. */
const MEDIA_PROTOCOL = /wan2\.7/i

/** DashScope's native API origin: the registered base's (`…/compatible-mode/v1` → its origin). */
export function dashscopeOrigin(baseUrl: string): string {
  return originOf(baseUrl) ?? baseUrl.replace(/\/+$/, '')
}

/** What a DashScope error `code` says, before the HTTP status does; `undefined` when it says nothing known. */
export function dashscopeCodeKind(code: string | undefined): DiffusionErrorCode | undefined {
  if (!code) return undefined
  if (/DataInspection|IPInfringement|Inappropriate|Sensitive|GreenNet/i.test(code))
    return 'REMOTE_CONTENT_BLOCKED'
  if (/Throttling|RateLimit|RateQuota/i.test(code)) return 'REMOTE_RATE_LIMITED'
  if (/Arrearage|Quota|Balance|FreeTierOnly|Overdue/i.test(code)) return 'REMOTE_QUOTA'
  if (/ApiKey|AccessDenied|Unauthorized|NoPermission|Forbidden/i.test(code)) return 'REMOTE_AUTH_FAILED'
  if (
    /InvalidParameter|InvalidURL|InvalidFile|InvalidImage|BadRequest|ModelNotFound|NotSupported/i.test(code)
  )
    return 'REMOTE_REJECTED'
  return undefined
}

/** A DashScope failure (an HTTP error body, a failed task's `output`) with its code and words. */
export function dashscopeError(
  provider: string,
  code: string | undefined,
  said: string | undefined,
  fallback: DiffusionErrorCode,
  status?: number
): AtomicCoreError {
  const kind = dashscopeCodeKind(code) ?? fallback
  const details = [status === undefined ? undefined : `HTTP ${status}`, code, said].filter(Boolean).join(': ')
  const message = said ? `${provider}: ${said}` : `${provider} failed${code ? ` (${code})` : ''}.`
  return remoteError(kind, message, details || undefined)
}

/** A non-2xx answer: its `code` when DashScope gave a known one, the status otherwise. */
export function dashscopeHttpError(
  provider: string,
  status: number,
  body: unknown,
  text = ''
): AtomicCoreError {
  const generic = remoteHttpError(provider, status, body, text)
  const code = textOf(fields(body)['code'])
  if (!dashscopeCodeKind(code)) return generic
  return dashscopeError(
    provider,
    code,
    providerMessage(body, text),
    generic.code as DiffusionErrorCode,
    status
  )
}

/** Statuses read with `dashscopeHttpError` instead of the generic mapping. */
const CODED_STATUSES = [400, 401, 403, 404, 429] as const

/** One request on the native API, its error `code` read before the status. */
async function callNative(ctx: MediaContext, path: string, options: CallOptions = {}): Promise<Fields> {
  const answer = await callProvider(ctx, `${dashscopeOrigin(ctx.baseUrl)}${path}`, {
    ...options,
    accept: CODED_STATUSES,
  })
  if (answer.status >= 300) throw dashscopeHttpError(ctx.provider, answer.status, answer.json, answer.text)
  return fields(answer.json)
}

/** The workflow is the model's, and image to video has the frames it needs. */
function checkInputs(job: VideoGenerationJob): void {
  if (!job.model.workflows.includes(job.workflow))
    throw remoteError('REMOTE_UNSUPPORTED', `${job.model.name} cannot do ${job.workflow}.`, job.workflow)
  if (job.workflow !== 'image-to-video') return
  if (!job.firstFrame) throw remoteError('REMOTE_UNSUPPORTED', 'Image to video needs a first frame.')
  if (job.lastFrame && (!job.model.params.last_frame || !MEDIA_PROTOCOL.test(job.model.id)))
    throw remoteError('REMOTE_UNSUPPORTED', `${job.model.name} does not take a last frame.`)
}

/**
 * The submit body: what the job set and the model offers. Prompt rewriting and the watermark are off,
 * so the clip is what the prompt says.
 */
export function dashscopeVideoBody(job: VideoGenerationJob): Fields {
  checkInputs(job)
  const params = job.model.params
  const input: Fields = { prompt: job.prompt }
  if (job.negativePrompt && params.negative_prompt) input['negative_prompt'] = job.negativePrompt
  if (job.workflow === 'image-to-video' && job.firstFrame) {
    const first = toDataUrl(job.firstFrame.bytes, job.firstFrame.mime)
    if (MEDIA_PROTOCOL.test(job.model.id)) {
      const media: Fields[] = [{ type: 'first_frame', url: first }]
      if (job.lastFrame)
        media.push({ type: 'last_frame', url: toDataUrl(job.lastFrame.bytes, job.lastFrame.mime) })
      input['media'] = media
    } else input['img_url'] = first
  }
  const parameters: Fields = {}
  if (job.resolution && params.resolutions) parameters['resolution'] = job.resolution
  const size = parseWxH(job.size)
  if (size && params.sizes) parameters['size'] = `${size.width}*${size.height}`
  if (job.aspectRatio && params.aspect_ratios && job.workflow === 'create')
    parameters['ratio'] = job.aspectRatio
  if (job.durationSecs !== undefined && params.durations)
    parameters['duration'] = Math.round(job.durationSecs)
  parameters['prompt_extend'] = false
  parameters['watermark'] = false
  if (job.seed !== undefined && params.seed) parameters['seed'] = job.seed
  return { model: job.model.id, input, parameters }
}

/** What a model id says it does: `…t2v…` makes clips from text, `…i2v…` from a frame. */
function workflowOf(id: string): string | undefined {
  if (/i2v/i.test(id)) return 'image-to-video'
  if (/t2v/i.test(id)) return 'create'
  return undefined
}

/**
 * The video models of a `/api/v1/models` listing (`output.models[]`, tolerating `data[]`/`models[]`):
 * those that generate video and whose id says text or image to video (a reference, editing or
 * animation model takes inputs this adapter does not send).
 */
export function dashscopeVideoModels(json: unknown): LiveMediaModel[] {
  const body = fields(json)
  const output = fields(body['output'])
  const list = [output['models'], body['data'], body['models']].find(Array.isArray) ?? []
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of list as unknown[]) {
    const entry = fields(item)
    const id = textOf(entry['model']) ?? textOf(entry['id'])
    if (!id || seen.has(id)) continue
    const capabilities = entry['capabilities']
    if (
      Array.isArray(capabilities) &&
      !capabilities.some((c) => typeof c === 'string' && c.toUpperCase() === 'VG')
    )
      continue
    const workflow = workflowOf(id)
    if (!workflow) continue
    seen.add(id)
    const model: LiveMediaModel = { id, workflows: [workflow] }
    const name = textOf(entry['name'])
    if (name) model.name = name
    const description = textOf(entry['description'])
    if (description) model.description = description
    out.push(model)
  }
  return out
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

export const DASHSCOPE_VIDEO: VideoAdapter = {
  dialect: 'dashscope-video',
  kind: 'video',
  // DashScope suggests polling about every 15 seconds.
  pollIntervalMs: { first: 10000, max: 20000 },

  async listModels(ctx) {
    const answer = await callProvider(
      ctx,
      `${dashscopeOrigin(ctx.baseUrl)}/api/v1/models?page_no=1&page_size=100&capabilities=VG`,
      { accept: [404] }
    )
    if (answer.status === 404) return []
    return dashscopeVideoModels(answer.json)
  },

  async submit(ctx, job) {
    const body = await callNative(ctx, SUBMIT_PATH, {
      json: dashscopeVideoBody(job),
      headers: { 'X-DashScope-Async': 'enable' },
    })
    const id = textOf(fields(body['output'])['task_id'])
    if (!id) {
      const code = textOf(body['code'])
      if (code) throw dashscopeError(ctx.provider, code, textOf(body['message']), 'REMOTE_REJECTED')
      throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without a task id.`)
    }
    return { id }
  },

  async poll(ctx, submission) {
    const body = await callNative(ctx, `/api/v1/tasks/${encodeURIComponent(submission.id)}`)
    const output = fields(body['output'])
    const status = (textOf(output['task_status']) ?? '').toUpperCase()
    switch (status) {
      case 'PENDING':
        return { state: 'queued' }
      case 'SUCCEEDED': {
        const url = textOf(output['video_url'])
        if (!url)
          return {
            state: 'failed',
            error: remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} finished without a clip.`),
          }
        return { state: 'completed', result: { url } }
      }
      case 'FAILED':
        return {
          state: 'failed',
          error: dashscopeError(
            ctx.provider,
            textOf(output['code']),
            textOf(output['message']),
            'REMOTE_UNAVAILABLE'
          ),
        }
      case 'CANCELED':
      case 'CANCELLED':
        return {
          state: 'failed',
          error: remoteError('CANCELLED', `${ctx.provider} cancelled the generation.`),
        }
      case 'UNKNOWN':
        return {
          state: 'failed',
          error: remoteError(
            'REMOTE_UNAVAILABLE',
            `${ctx.provider} no longer knows this task (tasks expire after 24 hours).`
          ),
        }
      default:
        return { state: 'running' }
    }
  },

  async download(ctx, _submission, result) {
    if (!result.url) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} gave no clip to download.`)
    return fetchClip(ctx, result.url)
  },

  async cancel(ctx, submission) {
    try {
      await callProvider(
        ctx,
        `${dashscopeOrigin(ctx.baseUrl)}/api/v1/tasks/${encodeURIComponent(submission.id)}/cancel`,
        { method: 'POST' }
      )
    } catch (error) {
      // Only a pending task can be cancelled; a running one just finishes.
      ctx.log('debug', `${ctx.provider}: cancel of ${submission.id} refused: ${(error as Error).message}`)
    }
  },
}
