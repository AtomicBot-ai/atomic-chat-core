/**
 * The public API's bodies for a cloud or self-hosted provider's image and video models
 * (ADR 2026-10-13-remote-media-shares-the-diffusion-job-table): OpenAI-shaped fields, bound to the
 * provider and model the client's `model` names, into the diffusion requests the runner takes. Images
 * a client sends must be inline (`data:` URLs or base64): the core never fetches a URL it is handed.
 * Pure but for the mask conversion.
 */

import type {
  ImageGenerateRequest,
  MediaTarget,
  RemoteImageOptions,
  RemoteVideoOptions,
  VideoGenerateRequest,
} from '../../contracts/index.js'
import { alphaMaskToWhite } from '../../media/index.js'
import { ParamError } from './images-params.js'

export const MAX_REMOTE_N = 10
export const MAX_REMOTE_SECONDS = 60

export interface RemoteImageParams {
  prompt: string
  n: number
  /** `auto`, `WxH`, or a tier (`2K`), as the client wrote it. */
  size?: string
  quality?: string
  background?: string
  outputFormat?: string
  aspectRatio?: string
  resolution?: string
  seed?: number
  negativePrompt?: string
  /** Base64 payloads, source first. */
  images: string[]
  /** Base64 PNG, OpenAI's convention: transparent where the model repaints. */
  mask?: string
}

const bad = (param: string, message: string) => new ParamError(param, message)
const isNil = (value: unknown): value is undefined | null => value === undefined || value === null

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  if (isNil(value)) return undefined
  if (typeof value !== 'string') throw bad(key, `${key} must be a string`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** An inline image as its base64 payload: a `data:image/...;base64,` URL or bare base64. Links are refused. */
export function inlineImage(value: unknown, param: string): string {
  const url =
    typeof value === 'string'
      ? value
      : value &&
          typeof value === 'object' &&
          typeof (value as Record<string, unknown>)['image_url'] === 'string'
        ? ((value as Record<string, unknown>)['image_url'] as string)
        : undefined
  if (url === undefined) throw bad(param, `${param} must be an image: a data URL or {image_url}`)
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed))
    throw bad(param, `${param} must be inline: send it as a data URL, the server does not fetch links`)
  const comma = trimmed.startsWith('data:') ? trimmed.indexOf(',') : -1
  if (
    trimmed.startsWith('data:') &&
    (comma < 0 || !/^data:image\/[a-z0-9.+-]+;base64$/i.test(trimmed.slice(0, comma)))
  )
    throw bad(param, `${param} must be a base64 image data URL`)
  const payload = (comma >= 0 ? trimmed.slice(comma + 1) : trimmed).replace(/\s+/g, '')
  if (payload === '' || !/^[A-Za-z0-9+/]+=*$/.test(payload)) throw bad(param, `${param} is not base64`)
  return payload
}

/** `POST /images/generations` and `/images/edits` bodies for a remote model. */
export function parseRemoteImageParams(body: unknown, mode: 'generations' | 'edits'): RemoteImageParams {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw bad('body', 'request body must be a JSON object')
  const obj = body as Record<string, unknown>
  const prompt = optionalString(obj, 'prompt')
  if (!prompt) throw bad('prompt', 'prompt is required')
  let n = 1
  if (!isNil(obj['n'])) {
    const value = obj['n']
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_REMOTE_N)
      throw bad('n', `n must be an integer between 1 and ${MAX_REMOTE_N}`)
    n = value
  }
  const format = optionalString(obj, 'response_format')
  if (format !== undefined && format !== 'b64_json')
    throw bad(
      'response_format',
      "response_format must be 'b64_json'; this server returns image bytes, not links"
    )
  const params: RemoteImageParams = { prompt, n, images: [] }
  const assign = <K extends keyof RemoteImageParams>(key: K, value: RemoteImageParams[K] | undefined) => {
    if (value !== undefined) params[key] = value
  }
  assign('size', optionalString(obj, 'size'))
  assign('quality', optionalString(obj, 'quality'))
  assign('background', optionalString(obj, 'background'))
  assign('outputFormat', optionalString(obj, 'output_format'))
  assign('aspectRatio', optionalString(obj, 'aspect_ratio'))
  assign('resolution', optionalString(obj, 'resolution'))
  assign('negativePrompt', optionalString(obj, 'negative_prompt'))
  if (!isNil(obj['seed'])) {
    const seed = obj['seed']
    if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw bad('seed', 'seed must be an integer')
    params.seed = seed
  }
  if (mode === 'edits') {
    const list = !isNil(obj['images']) ? obj['images'] : !isNil(obj['image']) ? [obj['image']] : undefined
    if (!Array.isArray(list) || list.length === 0) throw bad('images', 'images must name at least one image')
    params.images = list.map((item, index) => inlineImage(item, `images[${index}]`))
    if (!isNil(obj['mask'])) params.mask = inlineImage(obj['mask'], 'mask')
  }
  return params
}

/** `'1024x768'` → its dimensions; anything else → `undefined`. */
function pixels(size: string | undefined): { width: number; height: number } | undefined {
  const match = /^(\d+)x(\d+)$/i.exec(size ?? '')
  return match ? { width: Number(match[1]), height: Number(match[2]) } : undefined
}

/**
 * The runner's request: a mask goes from OpenAI's convention to the core's (white repaints), and the
 * workflow follows the inputs (a mask inpaints, several images reference, one image edits).
 */
export async function buildRemoteImageRequest(
  params: RemoteImageParams,
  target: MediaTarget
): Promise<ImageGenerateRequest> {
  const size = pixels(params.size)
  const remote: RemoteImageOptions = {}
  if (params.size !== undefined) {
    if (size || params.size.toLowerCase() === 'auto')
      remote.size = params.size.toLowerCase() === 'auto' ? 'auto' : params.size
    else remote.resolution = params.size
  }
  if (params.resolution) remote.resolution = params.resolution
  if (params.aspectRatio) remote.aspectRatio = params.aspectRatio
  if (params.quality) remote.quality = params.quality
  if (params.background) remote.background = params.background
  if (params.outputFormat) remote.outputFormat = params.outputFormat
  const request: ImageGenerateRequest = {
    prompt: params.prompt,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    steps: 0,
    cfgScale: 0,
    batchSize: params.n,
    target,
    remote,
  }
  if (params.negativePrompt) request.negativePrompt = params.negativePrompt
  if (params.seed !== undefined) request.seed = params.seed
  const [source, ...references] = params.images
  if (source !== undefined) {
    request.initImage = { base64: source }
    if (params.mask !== undefined) {
      request.workflow = 'inpaint'
      request.maskImage = {
        base64: (await alphaMaskToWhite(Buffer.from(params.mask, 'base64'))).toString('base64'),
      }
    } else if (references.length > 0) {
      request.workflow = 'reference'
      request.referenceImages = references.map((base64) => ({ base64 }))
    } else request.workflow = 'edit'
  }
  return request
}

export interface RemoteVideoParams {
  prompt: string
  seconds?: number
  size?: string
  resolution?: string
  aspectRatio?: string
  generateAudio?: boolean
  seed?: number
  negativePrompt?: string
  /** The first frame, base64. */
  inputReference?: string
}

/** `POST /videos` for a remote model: OpenAI's fields plus `resolution`, `aspect_ratio`, `generate_audio`. */
export function parseRemoteVideoParams(body: unknown): RemoteVideoParams {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw bad('body', 'request body must be a JSON object')
  const obj = body as Record<string, unknown>
  const params: RemoteVideoParams = { prompt: optionalString(obj, 'prompt') ?? '' }
  if (!isNil(obj['input_reference']))
    params.inputReference = inlineImage(obj['input_reference'], 'input_reference')
  if (params.prompt === '' && params.inputReference === undefined) throw bad('prompt', 'prompt is required')
  if (!isNil(obj['seconds'])) {
    const raw = obj['seconds']
    const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_REMOTE_SECONDS)
      throw bad('seconds', `seconds must be a number between 0 and ${MAX_REMOTE_SECONDS}`)
    params.seconds = value
  }
  const size = optionalString(obj, 'size')
  if (size && size.toLowerCase() !== 'auto') params.size = size
  const resolution = optionalString(obj, 'resolution')
  if (resolution) params.resolution = resolution
  const aspect = optionalString(obj, 'aspect_ratio')
  if (aspect) params.aspectRatio = aspect
  const negative = optionalString(obj, 'negative_prompt')
  if (negative) params.negativePrompt = negative
  if (!isNil(obj['generate_audio'])) {
    if (typeof obj['generate_audio'] !== 'boolean')
      throw bad('generate_audio', 'generate_audio must be true or false')
    params.generateAudio = obj['generate_audio']
  }
  if (!isNil(obj['seed'])) {
    const seed = obj['seed']
    if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw bad('seed', 'seed must be an integer')
    params.seed = seed
  }
  return params
}

export function buildRemoteVideoRequest(
  params: RemoteVideoParams,
  target: MediaTarget
): VideoGenerateRequest {
  const remote: RemoteVideoOptions = {}
  if (params.seconds !== undefined) remote.durationSecs = params.seconds
  if (params.resolution) remote.resolution = params.resolution
  if (params.aspectRatio) remote.aspectRatio = params.aspectRatio
  if (params.size) remote.size = params.size
  if (params.generateAudio !== undefined) remote.generateAudio = params.generateAudio
  const size = pixels(params.size)
  const request: VideoGenerateRequest = {
    prompt: params.prompt,
    width: size?.width ?? 0,
    height: size?.height ?? 0,
    steps: 0,
    cfgScale: 0,
    target,
    remote,
    workflow: params.inputReference !== undefined ? 'image-to-video' : 'create',
  }
  if (params.inputReference !== undefined) request.initImage = { base64: params.inputReference }
  if (params.negativePrompt) request.negativePrompt = params.negativePrompt
  if (params.seed !== undefined) request.seed = params.seed
  return request
}
