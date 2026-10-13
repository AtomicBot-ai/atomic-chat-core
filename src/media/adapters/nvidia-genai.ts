/**
 * `nvidia-genai`: NVIDIA's Visual GenAI image models — the hosted API catalog and self-hosted NIMs.
 *
 * Where a request goes:
 * - the API catalog (registered base `https://integrate.api.nvidia.com/v1`) serves visual models on a
 *   different host: `POST https://ai.api.nvidia.com/v1/genai/{model.id}`. This host mapping is
 *   hardcoded here — the one sanctioned exception to "every URL from the base" — and applies only
 *   when the base's host is `integrate.api.nvidia.com`;
 * - any other base is a self-hosted NIM: `POST {base without its /v1}/v1/infer`.
 *
 * The body follows the model's `options.schema` (each NVIDIA endpoint rejects fields it does not
 * know): `flux-schnell`, `flux-dev`, `flux2-klein`, `sd3`; a model without one gets the prompt and
 * only what the job set. The answer is `{artifacts: [{base64, finishReason, seed}]}` (SD3:
 * `{image, finish_reason, seed}`), one JPEG per call, so `n` images are `n` calls. A
 * `CONTENT_FILTERED` finish is `REMOTE_CONTENT_BLOCKED`. When the hosted API answers 202 (NVCF: the
 * job outlived its synchronous window) the request id is polled on
 * `https://ai.api.nvidia.com/v1/status/{id}` — NVIDIA documents several spellings of that path and
 * none for these models, so this one is unverified; a wrong one ends as the provider's 404.
 */

import {
  callProvider,
  decodeBase64Image,
  GENERATE_TIMEOUT_MS,
  joinUrl,
  parseWxH,
  pollUntil,
  remoteError,
} from '../http.js'
import type { MediaContext } from '../http.js'
import type { GeneratedImage, ImageAdapter, ImageGenerationJob } from './types.js'

type Fields = Record<string, unknown>

const asObject = (value: unknown): Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {}
const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

/** The hosted API catalog's host, and the host its visual models live on. */
const CATALOG_HOST = 'integrate.api.nvidia.com'
const GENAI_ORIGIN = 'https://ai.api.nvidia.com'
/** NVIDIA seeds are `0 <= seed < 2^32`; 0 asks for a random one. */
const SEED_LIMIT = 2 ** 32

/** Whether the registration is NVIDIA's hosted API catalog. */
function isCatalog(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === CATALOG_HOST
  } catch {
    return false
  }
}

/** Where a model's generation goes (see the file comment). */
export function nvidiaInferUrl(baseUrl: string, modelId: string): string {
  if (isCatalog(baseUrl))
    return `${GENAI_ORIGIN}/v1/genai/${modelId.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`
  return joinUrl(baseUrl.replace(/\/+$/, '').replace(/\/v1$/i, ''), '/v1/infer')
}

/** The seed of image `index`: the job's (counting up per image), or 0 (random) when it has none. */
function seedOf(job: ImageGenerationJob, index: number): number {
  if (job.seed === undefined || job.seed < 0 || !Number.isFinite(job.seed)) return 0
  const seed = Math.trunc(job.seed)
  return seed === 0 ? 0 : (seed + index) % SEED_LIMIT
}

/** The request body for image `index` of a job, by the model's `options.schema`. */
export function nvidiaBody(job: ImageGenerationJob, index = 0): Record<string, unknown> {
  const params = job.model.params
  const size =
    parseWxH(job.size) ?? (job.width && job.height ? { width: job.width, height: job.height } : undefined)
  const steps = job.steps ?? params.steps?.default
  const seed = seedOf(job, index)
  const { width, height } = size ?? { width: 1024, height: 1024 }
  switch (job.model.options?.['schema']) {
    case 'flux-schnell':
      return {
        prompt: job.prompt,
        width,
        height,
        steps: steps ?? 4,
        seed,
        cfg_scale: 0,
        mode: 'base',
        samples: 1,
      }
    case 'flux-dev':
      return {
        prompt: job.prompt,
        mode: 'base',
        cfg_scale: job.cfgScale ?? job.guidance ?? params.cfg?.default ?? 5,
        width,
        height,
        steps: steps ?? 50,
        seed,
        samples: 1,
      }
    case 'flux2-klein':
      return {
        prompt: job.prompt,
        mode: 'Image Generation',
        steps: steps ?? 4,
        cfg_scale: 0,
        seed,
        width,
        height,
      }
    case 'sd3': {
      const body: Record<string, unknown> = { prompt: job.prompt }
      if (job.negativePrompt) body['negative_prompt'] = job.negativePrompt
      const ratio = job.aspectRatio ?? params.aspect_ratios?.default
      if (ratio) body['aspect_ratio'] = ratio
      body['cfg_scale'] = job.cfgScale ?? params.cfg?.default ?? 5
      body['steps'] = steps ?? 50
      body['seed'] = seed
      return body
    }
    default: {
      // A model the catalog does not describe (a self-hosted NIM): the prompt and what the job set.
      const body: Record<string, unknown> = { prompt: job.prompt }
      if (size) Object.assign(body, size)
      if (steps !== undefined) body['steps'] = steps
      if (job.cfgScale !== undefined) body['cfg_scale'] = job.cfgScale
      if (job.negativePrompt && params.negative_prompt) body['negative_prompt'] = job.negativePrompt
      body['seed'] = seed
      return body
    }
  }
}

/** The images of an answer; a filtered or failed finish throws. */
export function nvidiaImages(ctx: Pick<MediaContext, 'provider'>, json: unknown): GeneratedImage[] {
  const fields = asObject(json)
  const artifacts = Array.isArray(fields['artifacts']) ? fields['artifacts'].map(asObject) : [fields]
  const out: GeneratedImage[] = []
  for (const artifact of artifacts) {
    const reason = text(artifact['finishReason']) ?? text(artifact['finish_reason'])
    if (reason === 'CONTENT_FILTERED')
      throw remoteError('REMOTE_CONTENT_BLOCKED', `${ctx.provider} filtered the image as unsafe.`, reason)
    if (reason === 'ERROR')
      throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} failed to generate the image.`, reason)
    const payload = text(artifact['base64']) ?? text(artifact['image'])
    if (payload) out.push(decodeBase64Image(payload))
  }
  if (out.length === 0) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without an image.`)
  return out
}

/** The request id of a 202 (the `NVCF-REQID` header, or the body's id). */
function pendingId(headers: Headers, json: unknown): string | undefined {
  const fields = asObject(json)
  return (
    text(headers.get('nvcf-reqid')) ??
    text(fields['reqId']) ??
    text(fields['requestId']) ??
    text(fields['id'])
  )
}

/** Polls a hosted request that answered 202 until it answers 200. */
async function awaitPending(ctx: MediaContext, id: string): Promise<unknown> {
  const url = `${GENAI_ORIGIN}/v1/status/${encodeURIComponent(id)}`
  return pollUntil(
    ctx,
    async () => {
      const answer = await callProvider(ctx, url)
      return answer.status === 202 ? undefined : answer.json
    },
    { intervalMs: 1000, maxIntervalMs: 5000, timeoutMs: GENERATE_TIMEOUT_MS }
  )
}

export const NVIDIA_GENAI: ImageAdapter = {
  dialect: 'nvidia-genai',
  kind: 'image',

  async generate(ctx, job, report) {
    report({ phase: 'generating' })
    if (job.workflow !== 'create')
      throw remoteError(
        'REMOTE_UNSUPPORTED',
        'This model only creates images from a prompt here.',
        job.workflow
      )
    const url = nvidiaInferUrl(ctx.baseUrl, job.model.id)
    const count = Math.max(1, job.n)
    const out: GeneratedImage[] = []
    for (let index = 0; index < count; index++) {
      const answer = await callProvider(ctx, url, {
        json: nvidiaBody(job, index),
        timeoutMs: GENERATE_TIMEOUT_MS,
      })
      let json = answer.json
      if (answer.status === 202) {
        const id = pendingId(answer.headers, answer.json)
        if (!id || !isCatalog(ctx.baseUrl))
          throw remoteError(
            'REMOTE_UNAVAILABLE',
            `${ctx.provider} accepted the request without an answer.`,
            'HTTP 202'
          )
        json = await awaitPending(ctx, id)
      }
      out.push(...nvidiaImages(ctx, json))
      if (count > 1) report({ phase: 'generating', fraction: (index + 1) / count })
    }
    return out
  },
}
