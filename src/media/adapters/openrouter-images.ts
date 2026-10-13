/**
 * `openrouter-images`: OpenRouter's image API, registered with base `https://openrouter.ai/api/v1`,
 * Bearer key.
 *
 * Every URL is the registered base joined to a path. Every workflow (`create`, `edit`, `reference`)
 * is one `POST {base}/images`; inputs go along as `input_references` of data URLs (at most 16), the
 * source first. OpenRouter has no mask, so `inpaint` and `transform` are refused. The answer is
 * `data[]` of `b64_json`. The live listing, `GET {base}/images/models`, describes each model's
 * parameters, which become the model's controls.
 */

import type {
  AtomicCoreError,
  MediaChoice,
  MediaImageParams,
  RemoteImageWorkflow,
} from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  GENERATE_TIMEOUT_MS,
  joinUrl,
  remoteError,
  remoteHttpError,
  toDataUrl,
} from '../http.js'
import { imagesFromAnswer } from './openai-images.js'
import type { ImageAdapter, ImageGenerationJob } from './types.js'

const WORKFLOWS: readonly RemoteImageWorkflow[] = ['create', 'edit', 'reference']
/** OpenRouter takes at most this many `input_references`. */
const MAX_REFERENCES = 16
/** The form never offers more images per run than this. */
const MAX_N = 4

/** The JSON body of `POST /images`. */
export function openRouterImageBody(job: ImageGenerationJob): Record<string, unknown> {
  const body: Record<string, unknown> = { model: job.model.id, prompt: job.prompt }
  if (job.n > 1) body['n'] = job.n
  if (job.aspectRatio) body['aspect_ratio'] = job.aspectRatio
  if (job.resolution) body['resolution'] = job.resolution
  const size = job.size ?? (job.width && job.height ? `${job.width}x${job.height}` : undefined)
  if (size && size !== 'auto') body['size'] = size
  if (job.quality) body['quality'] = job.quality
  if (job.background) body['background'] = job.background
  // PNG keeps what the model drew; asked for only when the model offers a format and the job chose none.
  const format =
    job.outputFormat ?? (job.model.params.output_format?.values.includes('png') ? 'png' : undefined)
  if (format) body['output_format'] = format
  if (job.seed !== undefined && job.model.params.seed) body['seed'] = job.seed
  if (job.workflow !== 'create' && job.images.length > 0)
    body['input_references'] = job.images.map((image) => ({
      type: 'image_url',
      image_url: { url: toDataUrl(image.bytes, image.mime) },
    }))
  return body
}

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** An `enum` parameter's values as a choice that starts on the first of `preferred` it offers. */
function enumChoice(value: unknown, preferred: readonly string[]): MediaChoice | undefined {
  if (!isObject(value) || value['type'] !== 'enum' || !Array.isArray(value['values'])) return undefined
  const values = value['values'].filter((v): v is string => typeof v === 'string' && v !== '')
  if (values.length === 0) return undefined
  const start = preferred.find((p) => values.includes(p)) ?? values[0]
  return start === undefined ? { values } : { values, default: start }
}

/** A `range` parameter's maximum, when it is one. */
function rangeMax(value: unknown): number | undefined {
  if (!isObject(value) || value['type'] !== 'range') return undefined
  const max = value['max']
  return typeof max === 'number' && Number.isFinite(max) ? max : undefined
}

/** One entry of `GET /images/models` as a live model whose controls are its `supported_parameters`. */
export function openRouterImageModel(entry: unknown): LiveMediaModel | undefined {
  if (!isObject(entry) || typeof entry['id'] !== 'string' || entry['id'] === '') return undefined
  const architecture = entry['architecture']
  const outputs = isObject(architecture) ? architecture['output_modalities'] : undefined
  if (Array.isArray(outputs) && !outputs.includes('image')) return undefined
  const supported = isObject(entry['supported_parameters']) ? entry['supported_parameters'] : {}
  const params: MediaImageParams = {}
  const aspect = enumChoice(supported['aspect_ratio'], ['1:1'])
  if (aspect) params.aspect_ratios = aspect
  const resolution = enumChoice(supported['resolution'], ['1K'])
  if (resolution) params.resolutions = resolution
  const quality = enumChoice(supported['quality'], ['auto'])
  if (quality) params.quality = quality
  const background = enumChoice(supported['background'], ['auto'])
  if (background) params.background = background
  const format = enumChoice(supported['output_format'], ['png'])
  if (format) params.output_format = format
  const n = rangeMax(supported['n'])
  if (n !== undefined && n > 1) params.n = { max: Math.min(MAX_N, Math.floor(n)) }
  const seed = supported['seed']
  if (isObject(seed) && seed['type'] === 'boolean') params.seed = true
  const references = rangeMax(supported['input_references'])
  const takesImages = references !== undefined && references > 0
  if (takesImages) params.max_input_images = Math.min(MAX_REFERENCES, Math.floor(references))
  const model: LiveMediaModel = {
    id: entry['id'],
    workflows: takesImages ? ['create', 'edit', 'reference'] : ['create'],
    params,
  }
  if (typeof entry['name'] === 'string' && entry['name'] !== '') model.name = entry['name']
  if (typeof entry['description'] === 'string' && entry['description'] !== '')
    model.description = entry['description']
  return model
}

/** The models of `GET /images/models`, each once. */
export function openRouterImageModels(json: unknown): LiveMediaModel[] {
  const data = isObject(json) ? json['data'] : undefined
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data) ? data : []) {
    const model = openRouterImageModel(item)
    if (!model || seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}

/**
 * An error OpenRouter put in a 200 body (`{error: {code, message}}` without images), as the
 * `REMOTE_*` error its code means; `undefined` when the body carries none.
 */
export function openRouterBodyError(provider: string, json: unknown): AtomicCoreError | undefined {
  if (!isObject(json) || !isObject(json['error'])) return undefined
  if (Array.isArray(json['data']) && json['data'].length > 0) return undefined
  const code = json['error']['code']
  const status = typeof code === 'number' && code >= 400 && code < 600 ? code : 502
  return remoteHttpError(provider, status, json)
}

export const OPENROUTER_IMAGES: ImageAdapter = {
  dialect: 'openrouter-images',
  kind: 'image',

  async listModels(ctx) {
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/images/models'))
    return openRouterImageModels(answer.json)
  },

  async generate(ctx, job, report) {
    if (!WORKFLOWS.includes(job.workflow))
      throw remoteError('REMOTE_UNSUPPORTED', `${ctx.provider} does not support this workflow.`, job.workflow)
    if (job.workflow !== 'create' && job.images.length === 0)
      throw remoteError('REMOTE_UNSUPPORTED', 'This workflow needs a source image.', job.workflow)
    report({ phase: 'generating' })
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/images'), {
      json: openRouterImageBody(job),
      timeoutMs: GENERATE_TIMEOUT_MS,
    })
    const failed = openRouterBodyError(ctx.provider, answer.json)
    if (failed) throw failed
    return imagesFromAnswer(ctx, answer.json)
  },
}
