/**
 * `openai-images`: the OpenAI Images API and the servers that copy it — OpenAI (gpt-image-*), Meta's
 * Muse Image, Eden AI (`/v3/images/*`), AIMLAPI, Ollama's experimental image models, and any
 * OpenAI-compatible self-hosted server (LocalAI, sd.cpp's `sd-server`, another Atomic core).
 *
 * `create` → `POST {base}/images/generations`. `edit`, `reference`, `inpaint` → `POST
 * {base}/images/edits` in its JSON form (`images: [{image_url}]`, `mask: {image_url}`), or as
 * multipart when the model's `options.edit_transport` is `multipart`. A model whose
 * `options.edit_via` is `image_urls` (AIMLAPI's non-OpenAI models) edits through generations with
 * `image_urls` instead. Images come back as `b64_json` or a `url`; both are taken.
 */

import type { LiveMediaModel } from '../catalog.js'
import {
  callProvider,
  decodeBase64Image,
  downloadResult,
  GENERATE_TIMEOUT_MS,
  joinUrl,
  MAX_IMAGE_BYTES,
  remoteError,
  sniffImageMime,
  toDataUrl,
} from '../http.js'
import type { MediaContext } from '../http.js'
import { maskToAlpha } from '../mask.js'
import type { GeneratedImage, ImageAdapter, ImageGenerationJob } from './types.js'

/** gpt-image models always answer `b64_json` and refuse `response_format`. */
const GPT_IMAGE = /(^|\/)gpt-image|(^|\/)chatgpt-image/i

/** Ids that name an image model in a plain `/models` listing (an OpenAI-compatible server lists everything). */
export const IMAGE_MODEL_ID =
  /gpt-image|chatgpt-image|dall-e|(^|[/._-])image([._-]|$)|flux|stable-diffusion|sdxl|sd3|sd-?1\.5|z-image|qwen-image|imagen|seedream|recraft|ideogram|kolors|hidream|muse-image|nano-banana/i

/** The fields both endpoints share. */
export function commonFields(job: ImageGenerationJob): Record<string, unknown> {
  const body: Record<string, unknown> = { model: job.model.id, prompt: job.prompt }
  if (job.n > 1) body['n'] = job.n
  const size = job.size ?? (job.width && job.height ? `${job.width}x${job.height}` : undefined)
  if (size && size !== 'auto') body['size'] = size
  else if (size === 'auto' && job.model.params.size) body['size'] = 'auto'
  if (job.quality) body['quality'] = job.quality
  if (job.background) body['background'] = job.background
  if (job.outputFormat) body['output_format'] = job.outputFormat
  if (job.aspectRatio) body['aspect_ratio'] = job.aspectRatio
  if (job.resolution) body['resolution'] = job.resolution
  if (job.seed !== undefined && job.model.params.seed) body['seed'] = job.seed
  if (job.negativePrompt && job.model.params.negative_prompt) body['negative_prompt'] = job.negativePrompt
  if (!GPT_IMAGE.test(job.model.id)) body['response_format'] = 'b64_json'
  return body
}

/** `data[]` of an Images API answer as images, downloading any that came as a URL. */
export async function imagesFromAnswer(ctx: MediaContext, json: unknown): Promise<GeneratedImage[]> {
  const data = json && typeof json === 'object' ? (json as Record<string, unknown>)['data'] : undefined
  const items = Array.isArray(data) ? data : []
  const out: GeneratedImage[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const fields = item as Record<string, unknown>
    if (typeof fields['b64_json'] === 'string' && fields['b64_json'] !== '') {
      out.push(decodeBase64Image(fields['b64_json']))
    } else if (typeof fields['url'] === 'string' && fields['url'] !== '') {
      const url = fields['url']
      if (url.startsWith('data:')) {
        out.push(decodeBase64Image(url))
        continue
      }
      const file = await downloadResult(ctx, url, { maxBytes: MAX_IMAGE_BYTES, what: 'image' })
      const mime = sniffImageMime(file.bytes)
      if (!mime)
        throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not an image.`)
      out.push({ bytes: file.bytes, mime })
    }
  }
  if (out.length === 0) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without an image.`)
  return out
}

async function editBody(job: ImageGenerationJob): Promise<Record<string, unknown>> {
  const body = commonFields(job)
  body['images'] = job.images.map((image) => ({ image_url: toDataUrl(image.bytes, image.mime) }))
  if (job.workflow === 'inpaint' && job.mask)
    body['mask'] = { image_url: toDataUrl(await maskToAlpha(job.mask.bytes), 'image/png') }
  return body
}

async function editForm(job: ImageGenerationJob): Promise<FormData> {
  const form = new FormData()
  for (const [key, value] of Object.entries(commonFields(job))) form.append(key, String(value))
  job.images.forEach((image, index) => {
    const ext = image.mime.split('/')[1] ?? 'png'
    form.append(
      'image[]',
      new Blob([new Uint8Array(image.bytes)], { type: image.mime }),
      `image-${index}.${ext}`
    )
  })
  if (job.workflow === 'inpaint' && job.mask)
    form.append(
      'mask',
      new Blob([new Uint8Array(await maskToAlpha(job.mask.bytes))], { type: 'image/png' }),
      'mask.png'
    )
  return form
}

/** What a `/models` entry says about being an image model, when its listing says anything. */
function isImageEntry(entry: Record<string, unknown>, id: string): boolean {
  const type = entry['type']
  if (typeof type === 'string') return /image/i.test(type)
  return IMAGE_MODEL_ID.test(id)
}

/** The image models of a `/models`-style listing (OpenAI, AIMLAPI, Eden AI's `/images/models`, Ollama). */
export function imageModelsFromListing(json: unknown, filter: boolean): LiveMediaModel[] {
  const data =
    json && typeof json === 'object' && !Array.isArray(json)
      ? ((json as Record<string, unknown>)['data'] ?? (json as Record<string, unknown>)['models'])
      : json
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data) ? data : []) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const id =
      typeof entry['id'] === 'string'
        ? entry['id']
        : typeof entry['name'] === 'string'
          ? entry['name']
          : undefined
    if (!id || seen.has(id)) continue
    if (filter && !isImageEntry(entry, id)) continue
    seen.add(id)
    const info = entry['info'] as Record<string, unknown> | undefined
    const name = typeof info?.['name'] === 'string' ? info['name'] : undefined
    out.push(name ? { id, name } : { id })
  }
  return out
}

export const OPENAI_IMAGES: ImageAdapter = {
  dialect: 'openai-images',
  kind: 'image',

  async listModels(ctx) {
    // Eden AI lists image models on their own route; elsewhere it is a 404 and `/models` is filtered.
    const own = await callProvider(ctx, joinUrl(ctx.baseUrl, '/images/models'), { accept: [400, 404, 405] })
    if (own.status === 200) return imageModelsFromListing(own.json, false)
    const all = await callProvider(ctx, joinUrl(ctx.baseUrl, '/models'))
    return imageModelsFromListing(all.json, true)
  },

  async generate(ctx, job, report) {
    report({ phase: 'generating' })
    const viaUrls = job.model.options?.['edit_via'] === 'image_urls'
    let answer
    if (job.workflow === 'create' || (viaUrls && job.images.length > 0)) {
      const body = commonFields(job)
      if (viaUrls && job.images.length > 0)
        body['image_urls'] = job.images.map((image) => toDataUrl(image.bytes, image.mime))
      answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/images/generations'), {
        json: body,
        timeoutMs: GENERATE_TIMEOUT_MS,
      })
    } else {
      if (job.images.length === 0)
        throw remoteError('REMOTE_UNSUPPORTED', 'This workflow needs a source image.', job.workflow)
      const url = joinUrl(ctx.baseUrl, '/images/edits')
      answer =
        job.model.options?.['edit_transport'] === 'multipart'
          ? await callProvider(ctx, url, { form: await editForm(job), timeoutMs: GENERATE_TIMEOUT_MS })
          : await callProvider(ctx, url, { json: await editBody(job), timeoutMs: GENERATE_TIMEOUT_MS })
    }
    return imagesFromAnswer(ctx, answer.json)
  },
}
