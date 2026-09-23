/**
 * The client's `/v1/videos` bodies and the objects it reads back, in the shape of the OpenAI Videos
 * API, structurally validated but not yet bound to a model. Pure: what the facade in `videos.ts`
 * parses and serialises.
 */

import type {
  DiffusionFamilyDefaults,
  DiffusionFamilyRanges,
  GalleryVideoItem,
  VideoGenerateRequest,
  VideoJob,
} from '../../contracts/index.js'
import { nearestValidFrames } from '../../diffusion/index.js'
import { ParamError } from './images-params.js'

export const MAX_SECONDS = 600
export const DEFAULT_LIST_LIMIT = 20
export const MAX_LIST_LIMIT = 100

export interface VideosParams {
  model?: string
  prompt: string
  /** Clip length the client asked for; absent = the family's default frame count. */
  seconds?: number
  /** Absent = the loaded family's default size. */
  size?: { width: number; height: number }
  seed?: number
  negativePrompt?: string
}

const bad = (param: string, message: string) => new ParamError(param, message)
const isNil = (value: unknown): value is undefined | null => value === undefined || value === null
const SIZE_MESSAGE = "size must be 'WIDTHxHEIGHT' (e.g. '768x512') or 'auto'"

/**
 * `'768x512'` → the dimensions; `'auto'` or `''` → `undefined`. Unlike the image facade this sets no
 * bounds of its own: a video family's range and grid differ per model, and the runner holds the
 * request to them.
 */
export function parseVideoSize(size: string): { width: number; height: number } | undefined {
  const trimmed = size.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'auto') return undefined
  const at = trimmed.search(/[xX]/)
  if (at < 0) throw bad('size', SIZE_MESSAGE)
  const parse = (text: string): number | undefined =>
    /^\+?\d+$/.test(text.trim()) ? Number(text.trim()) : undefined
  const width = parse(trimmed.slice(0, at))
  const height = parse(trimmed.slice(at + 1))
  if (
    width === undefined ||
    height === undefined ||
    width === 0 ||
    height === 0 ||
    width > 0xffff_ffff ||
    height > 0xffff_ffff
  )
    throw bad('size', SIZE_MESSAGE)
  return { width, height }
}

/** `seconds` as OpenAI takes it: a number, or a numeric string such as `"4"`. */
function parseSeconds(value: unknown): number {
  const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_SECONDS)
    throw bad('seconds', `seconds must be a number between 0 and ${MAX_SECONDS}`)
  return seconds
}

export function parseVideoParams(body: unknown): VideosParams {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw bad('body', 'request body must be a JSON object')
  const obj = body as Record<string, unknown>
  const rawPrompt = obj['prompt']
  const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : ''
  if (prompt === '') throw bad('prompt', 'prompt is required')
  if (!isNil(obj['input_reference']))
    throw bad(
      'input_reference',
      'input_reference is not supported; the local server generates from text only'
    )

  const params: VideosParams = { prompt }
  if (!isNil(obj['seconds'])) params.seconds = parseSeconds(obj['seconds'])
  if (!isNil(obj['size'])) {
    if (typeof obj['size'] !== 'string') throw bad('size', 'size must be a string')
    const size = parseVideoSize(obj['size'])
    if (size) params.size = size
  }
  if (!isNil(obj['seed'])) {
    const seed = obj['seed']
    if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw bad('seed', 'seed must be an integer')
    params.seed = seed
  }
  const negative = obj['negative_prompt']
  if (!isNil(negative)) {
    if (typeof negative !== 'string') throw bad('negative_prompt', 'negative_prompt must be a string')
    if (negative.trim() !== '') params.negativePrompt = negative
  }
  const model = obj['model']
  if (!isNil(model)) {
    if (typeof model !== 'string') throw bad('model', 'model must be a string')
    if (model.trim() !== '') params.model = model.trim()
  }
  return params
}

/** The loaded video family as the facade needs it. */
export interface LoadedVideoModel {
  modelId: string
  displayName: string
  modality: 'image' | 'video'
  defaults: DiffusionFamilyDefaults
  ranges: DiffusionFamilyRanges
}

/**
 * Bind the request to the loaded family: steps, guidance, sampler and the default size are what the
 * model was loaded with; `seconds` becomes the nearest valid frame count, clamped to the family's range.
 */
export function buildVideoRequest(params: VideosParams, loaded: LoadedVideoModel): VideoGenerateRequest {
  const { defaults, ranges } = loaded
  const video = defaults.video
  const range = ranges.frames
  if (video === undefined || range === undefined) throw bad('model', 'the loaded model has no video defaults')
  const request: VideoGenerateRequest = {
    prompt: params.prompt,
    width: params.size?.width ?? defaults.width,
    height: params.size?.height ?? defaults.height,
    frames: video.frames,
    fps: video.fps,
    steps: defaults.steps,
    cfgScale: defaults.cfgScale,
  }
  if (params.seconds !== undefined)
    request.frames = nearestValidFrames(
      params.seconds * video.fps,
      { step: video.frameStep, offset: video.frameOffset },
      range
    )
  if (params.negativePrompt !== undefined) request.negativePrompt = params.negativePrompt
  if (defaults.guidance !== undefined) request.guidance = defaults.guidance
  if (params.seed !== undefined) request.seed = params.seed
  if (defaults.samplingMethod !== undefined) request.samplingMethod = defaults.samplingMethod
  if (defaults.flowShift !== undefined) request.flowShift = defaults.flowShift
  return request
}

export type OpenAiVideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed'

/** The video object of the OpenAI Videos API, with the core's own facts under `atomic`. */
export interface OpenAiVideo {
  id: string
  object: 'video'
  model: string
  status: OpenAiVideoStatus
  /** 0..100. */
  progress: number
  created_at: number
  completed_at: number | null
  expires_at: null
  /** The clip length as OpenAI writes it: a string of seconds. */
  seconds: string
  size: string
  prompt: string
  remixed_from_video_id: null
  error: { code: string; message: string } | null
  atomic: {
    job_id: string
    seed: number | null
    path: string | null
    poster_path: string | null
  }
}

export function videoStatusOf(state: VideoJob['state']): OpenAiVideoStatus {
  switch (state) {
    case 'queued':
      return 'queued'
    case 'generating':
      return 'in_progress'
    case 'completed':
      return 'completed'
    default:
      return 'failed'
  }
}

const seconds = (frames: number, fps: number): string =>
  fps > 0 ? String(Math.round((frames / fps) * 100) / 100) : '0'

export function videoObjectFromJob(job: VideoJob): OpenAiVideo {
  const item = job.outputs[0]
  const fps = job.request.fps ?? item?.fps ?? 0
  const frames = item?.frameCount ?? job.request.frames ?? 0
  const error =
    job.state === 'cancelled'
      ? { code: 'cancelled', message: job.error?.message ?? 'Generation was cancelled.' }
      : job.error
        ? { code: job.error.code.toLowerCase(), message: job.error.message }
        : null
  return {
    id: job.id,
    object: 'video',
    model: job.modelId,
    status: videoStatusOf(job.state),
    progress:
      job.state === 'completed'
        ? 100
        : Math.max(0, Math.min(100, Math.round((job.progress?.fraction ?? 0) * 100))),
    created_at: Math.floor(job.createdAtMs / 1000),
    completed_at: job.finishedAtMs === undefined ? null : Math.floor(job.finishedAtMs / 1000),
    expires_at: null,
    seconds: seconds(frames, fps),
    size: `${job.request.width}x${job.request.height}`,
    prompt: job.request.prompt,
    remixed_from_video_id: null,
    error,
    atomic: {
      job_id: job.id,
      seed: item?.recipe.seed ?? null,
      path: item?.path ?? null,
      poster_path: item?.posterPath ?? null,
    },
  }
}

/** A clip the gallery still holds after the job record is gone: always completed. */
export function videoObjectFromItem(item: GalleryVideoItem): OpenAiVideo {
  return {
    id: item.id,
    object: 'video',
    model: item.recipe.model.modelId,
    status: 'completed',
    progress: 100,
    created_at: Math.floor(item.createdAtMs / 1000),
    completed_at: Math.floor((item.createdAtMs + item.recipe.durationMs) / 1000),
    expires_at: null,
    seconds: seconds(item.frameCount, item.fps),
    size: `${item.width}x${item.height}`,
    prompt: item.recipe.prompt,
    remixed_from_video_id: null,
    error: null,
    atomic: { job_id: item.id, seed: item.recipe.seed, path: item.path, poster_path: item.posterPath },
  }
}

export type VideoPathMatch =
  { kind: 'collection' } | { kind: 'video'; id: string } | { kind: 'content'; id: string }

/** `/videos`, `/videos/{id}` and `/videos/{id}/content`; anything else under `/videos/` is nothing. */
export function matchVideoPath(path: string): VideoPathMatch | undefined {
  if (path === '/videos') return { kind: 'collection' }
  const m = /^\/videos\/([^/]+)(\/content)?$/.exec(path)
  if (!m) return undefined
  const id = decodeURIComponent(m[1] as string)
  return m[2] ? { kind: 'content', id } : { kind: 'video', id }
}

/** The methods a matched path accepts, for the 405's `Allow`. */
export function allowedVideoMethods(match: VideoPathMatch): string[] {
  switch (match.kind) {
    case 'collection':
      return ['GET', 'POST']
    case 'video':
      return ['GET', 'DELETE']
    default:
      return ['GET']
  }
}

/** `?limit&after&order` of the listing; `order` is accepted and the list is newest first either way. */
export function parseListQuery(query: string | undefined): { limit: number; after?: string } {
  const params = new URLSearchParams(query ?? '')
  const rawLimit = params.get('limit')
  let limit = DEFAULT_LIST_LIMIT
  if (rawLimit !== null && rawLimit !== '') {
    const value = Number(rawLimit)
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIST_LIMIT)
      throw bad('limit', `limit must be an integer between 1 and ${MAX_LIST_LIMIT}`)
    limit = value
  }
  const after = params.get('after')
  return after ? { limit, after } : { limit }
}
