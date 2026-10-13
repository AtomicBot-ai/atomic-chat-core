/**
 * `gemini-image`: Google's Gemini image models (Nano Banana) on the native Generative Language API,
 * key in `x-goog-api-key`.
 *
 * The provider is registered with its OpenAI-compatible base
 * `https://generativelanguage.googleapis.com/v1beta/openai`; the native base is that URL without its
 * trailing `/openai` (a base registered without it is used as it is). Every workflow (`create`,
 * `edit`, `reference`) is `POST {native}/models/{model}:generateContent`: the prompt, then each input
 * image inline. The size goes in `generationConfig.imageConfig` (the SDK's field) or, when the model's
 * `options.image_config_field` is `responseFormat`, in `generationConfig.responseFormat.image`.
 * There is no batch field, so `n` images are `n` calls in a row. The listing is
 * `GET {native}/models`, kept to the image models that answer `generateContent`.
 */

import type { AtomicCoreError, RemoteImageWorkflow } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  decodeBase64Image,
  GENERATE_TIMEOUT_MS,
  joinUrl,
  providerMessage,
  remoteError,
  remoteHttpError,
} from '../http.js'
import type { MediaContext } from '../http.js'
import type { GeneratedImage, ImageAdapter, ImageGenerationJob } from './types.js'

const WORKFLOWS: readonly RemoteImageWorkflow[] = ['create', 'edit', 'reference']
/** Why a candidate stopped when the image was refused for its content. */
const BLOCKED_FINISH = new Set([
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
])
/** Listing pages read at most; one page holds a thousand models. */
const MAX_PAGES = 5

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/** The native API's base from the registered one: `…/v1beta/openai` → `…/v1beta`. */
export function geminiNativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').replace(/\/openai$/, '')
}

/** The JSON body of `generateContent` for one image. */
export function geminiImageBody(job: ImageGenerationJob): Record<string, unknown> {
  const parts: Fields[] = [{ text: job.prompt }]
  if (job.workflow !== 'create')
    for (const image of job.images)
      parts.push({ inline_data: { mime_type: image.mime, data: image.bytes.toString('base64') } })
  const generationConfig: Fields = { responseModalities: ['TEXT', 'IMAGE'] }
  const image: Fields = {}
  if (job.aspectRatio) image['aspectRatio'] = job.aspectRatio
  if (job.resolution) image['imageSize'] = job.resolution.toUpperCase()
  if (Object.keys(image).length > 0) {
    if (job.model.options?.['image_config_field'] === 'responseFormat')
      generationConfig['responseFormat'] = { image }
    else generationConfig['imageConfig'] = image
  }
  return { contents: [{ role: 'user', parts }], generationConfig }
}

/** The images of a `generateContent` answer, or the `REMOTE_*` error it amounts to. */
export function geminiImages(provider: string, json: unknown): GeneratedImage[] {
  const body = isObject(json) ? json : {}
  const feedback = isObject(body['promptFeedback']) ? body['promptFeedback'] : {}
  const blockReason = text(feedback['blockReason'])
  if (blockReason)
    throw remoteError(
      'REMOTE_CONTENT_BLOCKED',
      `${provider} refused the prompt.`,
      [blockReason, text(feedback['blockReasonMessage'])].filter(Boolean).join(': ')
    )
  const candidates = Array.isArray(body['candidates']) ? body['candidates'] : []
  const candidate = isObject(candidates[0]) ? candidates[0] : {}
  const finish = text(candidate['finishReason'])
  const content = isObject(candidate['content']) ? candidate['content'] : {}
  const parts = Array.isArray(content['parts']) ? content['parts'] : []
  const images: GeneratedImage[] = []
  const said: string[] = []
  for (const part of parts) {
    if (!isObject(part) || part['thought'] === true) continue
    const inline = isObject(part['inlineData'])
      ? part['inlineData']
      : isObject(part['inline_data'])
        ? part['inline_data']
        : undefined
    const data = inline ? text(inline['data']) : undefined
    if (data) images.push(decodeBase64Image(data))
    else if (text(part['text'])) said.push((part['text'] as string).trim())
  }
  if (images.length > 0) return images
  const details = [finish, text(candidate['finishMessage']), ...said].filter(Boolean).join(': ') || undefined
  if (finish && BLOCKED_FINISH.has(finish))
    throw remoteError('REMOTE_CONTENT_BLOCKED', `${provider} refused to draw this.`, details)
  throw remoteError('REMOTE_REJECTED', `${provider} answered without an image.`, details)
}

/** A non-2xx answer: Google's 400 for a bad key is an auth failure; the rest as `remoteHttpError`. */
export function geminiHttpError(provider: string, status: number, json: unknown, body = ''): AtomicCoreError {
  const error = isObject(json) && isObject(json['error']) ? json['error'] : {}
  const reasons = (Array.isArray(error['details']) ? error['details'] : [])
    .map((detail) => (isObject(detail) ? detail['reason'] : undefined))
    .filter((reason): reason is string => typeof reason === 'string')
  if (
    status === 400 &&
    (reasons.includes('API_KEY_INVALID') || /api key not valid/i.test(text(error['message']) ?? ''))
  ) {
    const said = providerMessage(json, body)
    return remoteError(
      'REMOTE_AUTH_FAILED',
      `${provider} refused the API key.`,
      `HTTP 400${said ? `: ${said}` : ''}`
    )
  }
  return remoteHttpError(provider, status, json, body)
}

/** The image models of `GET /models` that answer `generateContent`, without the `models/` prefix. */
export function geminiImageModels(json: unknown): LiveMediaModel[] {
  const list = isObject(json) && Array.isArray(json['models']) ? json['models'] : []
  const out: LiveMediaModel[] = []
  for (const item of list) {
    if (!isObject(item)) continue
    const id = text(item['name'])?.replace(/^models\//, '')
    if (!id || !/-image|nano-banana/i.test(id)) continue
    const methods = item['supportedGenerationMethods']
    if (!Array.isArray(methods) || !methods.includes('generateContent')) continue
    const model: LiveMediaModel = { id }
    const name = text(item['displayName'])
    if (name) model.name = name
    const description = text(item['description'])
    if (description) model.description = description
    out.push(model)
  }
  return out
}

async function generateOne(ctx: MediaContext, job: ImageGenerationJob): Promise<GeneratedImage[]> {
  const id = job.model.id.replace(/^models\//, '')
  const url = joinUrl(geminiNativeBase(ctx.baseUrl), `/models/${encodeURIComponent(id)}:generateContent`)
  const answer = await callProvider(ctx, url, {
    json: geminiImageBody(job),
    auth: 'goog',
    timeoutMs: GENERATE_TIMEOUT_MS,
    accept: [400],
  })
  if (answer.status === 400) throw geminiHttpError(ctx.provider, answer.status, answer.json, answer.text)
  return geminiImages(ctx.provider, answer.json)
}

export const GEMINI_IMAGE: ImageAdapter = {
  dialect: 'gemini-image',
  kind: 'image',

  async listModels(ctx) {
    const base = joinUrl(geminiNativeBase(ctx.baseUrl), '/models')
    const out: LiveMediaModel[] = []
    const seen = new Set<string>()
    let token: string | undefined
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ pageSize: '1000' })
      if (token) query.set('pageToken', token)
      const answer = await callProvider(ctx, `${base}?${query.toString()}`, { auth: 'goog', accept: [400] })
      if (answer.status === 400) throw geminiHttpError(ctx.provider, answer.status, answer.json, answer.text)
      for (const model of geminiImageModels(answer.json))
        if (!seen.has(model.id)) {
          seen.add(model.id)
          out.push(model)
        }
      token = isObject(answer.json) ? text(answer.json['nextPageToken']) : undefined
      if (!token) break
    }
    return out
  },

  async generate(ctx, job, report) {
    if (!WORKFLOWS.includes(job.workflow))
      throw remoteError('REMOTE_UNSUPPORTED', `${ctx.provider} does not support this workflow.`, job.workflow)
    if (job.workflow !== 'create' && job.images.length === 0)
      throw remoteError('REMOTE_UNSUPPORTED', 'This workflow needs a source image.', job.workflow)
    report({ phase: 'generating' })
    const count = Math.max(1, job.n)
    const out: GeneratedImage[] = []
    // No batch field: one call per image, in a row, never retried.
    for (let i = 0; i < count; i++) {
      out.push(...(await generateOne(ctx, job)))
      if (count > 1) report({ phase: 'generating', fraction: (i + 1) / count })
    }
    return out
  },
}
