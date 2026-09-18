/**
 * The client's `POST /v1/images/generations` body, structurally validated but not yet bound to a
 * model, and the OpenAI-shaped error envelope. Pure; port of the parsing half of the app's
 * `images_route.rs` (commit `767ff6350`).
 */

import type {
  DiffusionErrorCode,
  DiffusionFamilyDefaults,
  ImageGenerateRequest,
} from '../../contracts/index.js'
import { modelIdsMatch } from '../../router/index.js'

export const MAX_N = 4
export const MIN_DIM = 256
export const MAX_DIM = 2048
export const DIM_MULTIPLE = 16

export interface ImagesParams {
  model?: string
  prompt: string
  n: number
  /** Absent = `auto`: the loaded family's default size. */
  size?: { width: number; height: number }
  seed?: number
  negativePrompt?: string
}

export class ParamError extends Error {
  constructor(
    readonly param: string,
    message: string
  ) {
    super(message)
    this.name = 'ParamError'
  }
}

const bad = (param: string, message: string) => new ParamError(param, message)
const SIZE_MESSAGE = "size must be 'WIDTHxHEIGHT' (e.g. '1024x1024') or 'auto'"

/** `'1024x1024'` → the dimensions; `'auto'` or `''` → `undefined`. Throws a `ParamError` on `size`. */
export function parseSize(size: string): { width: number; height: number } | undefined {
  const trimmed = size.trim()
  if (trimmed === '' || trimmed.toLowerCase() === 'auto') return undefined
  const at = trimmed.search(/[xX]/)
  if (at < 0) throw bad('size', SIZE_MESSAGE)
  const parse = (text: string): number | undefined =>
    /^\+?\d+$/.test(text.trim()) ? Number(text.trim()) : undefined
  const width = parse(trimmed.slice(0, at))
  const height = parse(trimmed.slice(at + 1))
  if (width === undefined || height === undefined || width > 0xffff_ffff || height > 0xffff_ffff)
    throw bad('size', SIZE_MESSAGE)
  for (const [label, value] of [
    ['width', width],
    ['height', height],
  ] as const) {
    if (value < MIN_DIM || value > MAX_DIM)
      throw bad('size', `${label} must be between ${MIN_DIM} and ${MAX_DIM}`)
    if (value % DIM_MULTIPLE !== 0) throw bad('size', `${label} must be a multiple of ${DIM_MULTIPLE}`)
  }
  return { width, height }
}

const isNil = (value: unknown): value is undefined | null => value === undefined || value === null

export function parseParams(body: unknown): ImagesParams {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw bad('body', 'request body must be a JSON object')
  const obj = body as Record<string, unknown>
  const rawPrompt = obj['prompt']
  const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : ''
  if (prompt === '') throw bad('prompt', 'prompt is required')

  let n = 1
  if (!isNil(obj['n'])) {
    const value = obj['n']
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_N)
      throw bad('n', `n must be an integer between 1 and ${MAX_N}`)
    n = value
  }

  const params: ImagesParams = { prompt, n }
  if (!isNil(obj['size'])) {
    if (typeof obj['size'] !== 'string') throw bad('size', 'size must be a string')
    const size = parseSize(obj['size'])
    if (size) params.size = size
  }
  const format = obj['response_format']
  if (!isNil(format)) {
    if (typeof format !== 'string') throw bad('response_format', 'response_format must be a string')
    if (format !== 'b64_json')
      throw bad(
        'response_format',
        `response_format '${format}' is not supported; the local server only returns 'b64_json'`
      )
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

/** Bind the request to the loaded family: steps, guidance, sampler and the default size are what the model was loaded with. */
export function buildRequest(params: ImagesParams, defaults: DiffusionFamilyDefaults): ImageGenerateRequest {
  const request: ImageGenerateRequest = {
    prompt: params.prompt,
    width: params.size?.width ?? defaults.width,
    height: params.size?.height ?? defaults.height,
    steps: defaults.steps,
    cfgScale: defaults.cfgScale,
    batchSize: params.n,
  }
  if (params.negativePrompt !== undefined) request.negativePrompt = params.negativePrompt
  if (defaults.guidance !== undefined) request.guidance = defaults.guidance
  if (params.seed !== undefined) request.seed = params.seed
  if (defaults.samplingMethod !== undefined) request.samplingMethod = defaults.samplingMethod
  if (defaults.flowShift !== undefined) request.flowShift = defaults.flowShift
  return request
}

/** Does the client's `model` name the resident model? An absent one always does. */
export function modelMatches(
  requested: string | undefined,
  loaded: { modelId: string; displayName: string }
): boolean {
  if (requested === undefined) return true
  return modelIdsMatch(requested, loaded.modelId) || modelIdsMatch(requested, loaded.displayName)
}

/** The OpenAI error envelope: `param` and `code` are present, `null` when there is none. */
export function errorBody(message: string, type: string, code: string | null, param: string | null): string {
  return JSON.stringify({ error: { message, type, param, code } })
}

export interface MappedError {
  status: number
  type: string
  code: string
}

/** HTTP status, error type and `code` for a diffusion error. */
export function mapError(code: DiffusionErrorCode): MappedError {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'INVALID_DIMENSIONS':
    case 'UNSUPPORTED_WORKFLOW':
      return { status: 400, type: 'invalid_request_error', code: 'invalid_request' }
    case 'MODEL_NOT_LOADED':
    case 'NOT_CONFIGURED':
    case 'ENGINE_MISSING':
      return { status: 503, type: 'server_error', code: 'model_not_loaded' }
    case 'JOB_BUSY':
    case 'QUEUE_FULL':
      return { status: 429, type: 'server_error', code: 'busy' }
    case 'OUT_OF_MEMORY':
      return { status: 500, type: 'server_error', code: 'insufficient_memory' }
    case 'CANCELLED':
      return { status: 500, type: 'server_error', code: 'cancelled' }
    default:
      return { status: 500, type: 'server_error', code: 'server_error' }
  }
}

/** The analytics label for a status the facade answered with. */
export function errorKindFor(status: number): string {
  if (status === 400) return 'bad_request'
  if (status === 429) return 'busy'
  if (status === 503) return 'not_found'
  return 'upstream'
}
