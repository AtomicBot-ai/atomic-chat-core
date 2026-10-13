/**
 * `dashscope-image`: Alibaba Model Studio (DashScope) image models — Qwen-Image and Wan image — on the
 * native API, Bearer key.
 *
 * The provider is registered with its OpenAI-compatible base
 * `https://dashscope-intl.aliyuncs.com/compatible-mode/v1`; the native API lives on the same origin
 * (the base cut after its host) under `/api/v1`. Every workflow (`create`, `edit`, `reference`) is
 * the synchronous `POST {origin}/api/v1/services/aigc/multimodal-generation/generation`: one user
 * message whose content is the input images (data URLs, the source first) and then the prompt. The
 * answer points at signed image URLs on Alibaba's storage, downloaded without the key. The listing is
 * `GET {origin}/api/v1/models?capabilities=IG`.
 */

import type { AtomicCoreError, DiffusionErrorCode, RemoteImageWorkflow } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  downloadResult,
  GENERATE_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  originOf,
  parseWxH,
  providerMessage,
  remoteError,
  remoteHttpError,
  sniffImageMime,
  toDataUrl,
} from '../http.js'
import type { MediaContext } from '../http.js'
import type { GeneratedImage, ImageAdapter, ImageGenerationJob } from './types.js'

const WORKFLOWS: readonly RemoteImageWorkflow[] = ['create', 'edit', 'reference']
const GENERATION_PATH = '/api/v1/services/aigc/multimodal-generation/generation'
/** Error codes (and words) DashScope uses when its content check refused the input or the output. */
const BLOCKED = /DataInspection|data_inspection|IPInfringement|inappropriate/i

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** The native API's origin from the registered base: everything after the host goes. */
export function dashscopeOrigin(baseUrl: string): string {
  const origin = originOf(baseUrl)
  if (!origin) throw remoteError('REMOTE_NOT_CONFIGURED', 'The provider base URL is not a URL.', baseUrl)
  return origin
}

/** `size` as DashScope writes it: `W*H`, or a tier (`1K`, `2K`, `4K`) for a model that takes one. */
function sizeOf(job: ImageGenerationJob): string | undefined {
  const pixels = job.width && job.height ? { width: job.width, height: job.height } : parseWxH(job.size)
  if (pixels) return `${pixels.width}*${pixels.height}`
  return job.resolution || undefined
}

/** The JSON body of a multimodal generation. */
export function dashscopeImageBody(job: ImageGenerationJob): Record<string, unknown> {
  const content: Fields[] = []
  if (job.workflow !== 'create')
    for (const image of job.images) content.push({ image: toDataUrl(image.bytes, image.mime) })
  content.push({ text: job.prompt })
  const parameters: Fields = { n: Math.max(1, job.n) }
  const size = sizeOf(job)
  if (size) parameters['size'] = size
  if (job.negativePrompt && job.model.params.negative_prompt)
    parameters['negative_prompt'] = job.negativePrompt
  parameters['prompt_extend'] = false
  parameters['watermark'] = false
  if (job.seed !== undefined && job.model.params.seed) parameters['seed'] = job.seed
  return { model: job.model.id, input: { messages: [{ role: 'user', content }] }, parameters }
}

/** Every image URL of an answer, across all its choices. */
export function dashscopeImageUrls(json: unknown): string[] {
  const output = isObject(json) && isObject(json['output']) ? json['output'] : {}
  const choices = Array.isArray(output['choices']) ? output['choices'] : []
  const urls: string[] = []
  for (const choice of choices) {
    const message = isObject(choice) && isObject(choice['message']) ? choice['message'] : {}
    const content = Array.isArray(message['content']) ? message['content'] : []
    for (const item of content) {
      const url = isObject(item) ? text(item['image']) : undefined
      if (url) urls.push(url)
    }
  }
  return urls
}

/** DashScope's error body (`{code, message, request_id}`) as the closest `REMOTE_*` error. */
export function dashscopeError(provider: string, status: number, json: unknown, body = ''): AtomicCoreError {
  const code = isObject(json) ? text(json['code']) : undefined
  const said = providerMessage(json, body)
  const details = `HTTP ${status}${code ? ` ${code}` : ''}${said ? `: ${said}` : ''}`
  if ((code && BLOCKED.test(code)) || (said && BLOCKED.test(said)))
    return remoteError('REMOTE_CONTENT_BLOCKED', `${provider} refused the request: ${said ?? code}`, details)
  if (code === 'Arrearage')
    return remoteError('REMOTE_QUOTA', `${provider} says the account is out of credit.`, details)
  // The status decides the rest; the details keep DashScope's code.
  const mapped = remoteHttpError(provider, status, json, body)
  return remoteError(mapped.code as DiffusionErrorCode, mapped.message, details)
}

/** The models of the native listing (`output.models[]`, or `data[]`), by `model` or `id`. */
export function dashscopeImageModels(json: unknown): LiveMediaModel[] {
  const output = isObject(json) && isObject(json['output']) ? json['output'] : {}
  const list = Array.isArray(output['models'])
    ? output['models']
    : isObject(json) && Array.isArray(json['data'])
      ? json['data']
      : isObject(json) && Array.isArray(json['models'])
        ? json['models']
        : []
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of list) {
    if (!isObject(item)) continue
    const id = text(item['model']) ?? text(item['id'])
    if (!id || seen.has(id)) continue
    seen.add(id)
    const model: LiveMediaModel = { id }
    const name = text(item['name'])
    if (name && name !== id) model.name = name
    const description = text(item['description'])
    if (description) model.description = description
    out.push(model)
  }
  return out
}

/** A file the provider pointed at, with the type its bytes say. Local: `http.ts` has no such helper. */
async function downloadImage(ctx: MediaContext, url: string): Promise<GeneratedImage> {
  const file = await downloadResult(ctx, url, { maxBytes: MAX_IMAGE_BYTES, what: 'image' })
  const mime = sniffImageMime(file.bytes)
  if (!mime) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not an image.`)
  return { bytes: file.bytes, mime }
}

export const DASHSCOPE_IMAGE: ImageAdapter = {
  dialect: 'dashscope-image',
  kind: 'image',

  async listModels(ctx) {
    const query = new URLSearchParams({ page_no: '1', page_size: '100', capabilities: 'IG' })
    const url = `${dashscopeOrigin(ctx.baseUrl)}/api/v1/models?${query.toString()}`
    const answer = await callProvider(ctx, url, { accept: [400, 404] })
    if (answer.status === 404) return []
    if (answer.status === 400) throw dashscopeError(ctx.provider, answer.status, answer.json, answer.text)
    return dashscopeImageModels(answer.json)
  },

  async generate(ctx, job, report) {
    if (!WORKFLOWS.includes(job.workflow))
      throw remoteError('REMOTE_UNSUPPORTED', `${ctx.provider} does not support this workflow.`, job.workflow)
    if (job.workflow !== 'create' && job.images.length === 0)
      throw remoteError('REMOTE_UNSUPPORTED', 'This workflow needs a source image.', job.workflow)
    const url = `${dashscopeOrigin(ctx.baseUrl)}${GENERATION_PATH}`
    report({ phase: 'generating' })
    const answer = await callProvider(ctx, url, {
      json: dashscopeImageBody(job),
      timeoutMs: GENERATE_TIMEOUT_MS,
      accept: [400],
    })
    if (answer.status === 400) throw dashscopeError(ctx.provider, answer.status, answer.json, answer.text)
    const urls = dashscopeImageUrls(answer.json)
    if (urls.length === 0) {
      // A 200 that carries an error code instead of images.
      if (isObject(answer.json) && text(answer.json['code']))
        throw dashscopeError(ctx.provider, 400, answer.json, answer.text)
      throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without an image.`)
    }
    const out: GeneratedImage[] = []
    for (const image of urls) out.push(await downloadImage(ctx, image))
    return out
  },
}
