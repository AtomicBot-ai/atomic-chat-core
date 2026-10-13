/**
 * `xai-images`: xAI's image API (Grok Imagine), registered with base `https://api.x.ai/v1`, Bearer key.
 *
 * Every URL is the registered base joined to a path: `create` → `POST {base}/images/generations`;
 * `edit` and `reference` → `POST {base}/images/edits` with the inputs as data URLs, one image as
 * `image: {url}`, several (up to five) as `images: [{url}]`, never both. xAI has no mask, so
 * `inpaint` and `transform` are refused. The answer is the Images API shape (`data[]` with `b64_json`
 * or a `url`); we ask for `b64_json`. The live listing is `GET {base}/image-generation-models`.
 */

import type { RemoteImageWorkflow } from '../../contracts/index.js'
import type { LiveMediaModel } from '../catalog.js'
import { callProvider, GENERATE_TIMEOUT_MS, joinUrl, remoteError, toDataUrl } from '../http.js'
import { imagesFromAnswer } from './openai-images.js'
import type { ImageAdapter, ImageGenerationJob } from './types.js'

const WORKFLOWS: readonly RemoteImageWorkflow[] = ['create', 'edit', 'reference']

/** The JSON body of a generation or an edit: what the job set, and the inputs for an edit. */
export function xaiImageBody(job: ImageGenerationJob): Record<string, unknown> {
  const body: Record<string, unknown> = { model: job.model.id, prompt: job.prompt }
  if (job.n > 1) body['n'] = job.n
  if (job.aspectRatio) body['aspect_ratio'] = job.aspectRatio
  if (job.resolution) body['resolution'] = job.resolution
  if (job.quality) body['quality'] = job.quality
  body['response_format'] = 'b64_json'
  if (job.workflow !== 'create') {
    const inputs = job.images.map((image) => ({ url: toDataUrl(image.bytes, image.mime), type: 'image_url' }))
    if (inputs.length === 1) body['image'] = inputs[0]
    else if (inputs.length > 1) body['images'] = inputs
  }
  return body
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string')

/**
 * The models of `GET /image-generation-models`: those that output images (when the entry says), able
 * to edit and take references when they accept images.
 */
export function xaiImageModels(json: unknown): LiveMediaModel[] {
  const list =
    json && typeof json === 'object' && !Array.isArray(json)
      ? ((json as Record<string, unknown>)['models'] ?? (json as Record<string, unknown>)['data'])
      : undefined
  const out: LiveMediaModel[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const id = entry['id']
    if (typeof id !== 'string' || id === '' || seen.has(id)) continue
    const outputs = entry['output_modalities']
    if (isStrings(outputs) && !outputs.some((m) => m.toLowerCase() === 'image')) continue
    seen.add(id)
    const inputs = entry['input_modalities']
    const takesImages = isStrings(inputs) && inputs.some((m) => m.toLowerCase() === 'image')
    out.push({ id, workflows: takesImages ? ['create', 'edit', 'reference'] : ['create'] })
  }
  return out
}

export const XAI_IMAGES: ImageAdapter = {
  dialect: 'xai-images',
  kind: 'image',

  async listModels(ctx) {
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/image-generation-models'))
    return xaiImageModels(answer.json)
  },

  async generate(ctx, job, report) {
    if (!WORKFLOWS.includes(job.workflow))
      throw remoteError('REMOTE_UNSUPPORTED', `${ctx.provider} does not support this workflow.`, job.workflow)
    if (job.workflow !== 'create' && job.images.length === 0)
      throw remoteError('REMOTE_UNSUPPORTED', 'This workflow needs a source image.', job.workflow)
    report({ phase: 'generating' })
    const path = job.workflow === 'create' ? '/images/generations' : '/images/edits'
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, path), {
      json: xaiImageBody(job),
      timeoutMs: GENERATE_TIMEOUT_MS,
    })
    return imagesFromAnswer(ctx, answer.json)
  },
}
