/**
 * `minimax-image`: MiniMax's image API (`image-01`), registered with base `https://api.minimax.io/v1`,
 * Bearer key.
 *
 * Every workflow is `POST {base}/image_generation` (the registered base joined to the path):
 * `create` from the prompt, `reference` with the first input as a character `subject_reference`.
 * MiniMax cannot edit an image or take a mask, so the other workflows are refused. We ask for
 * `base64`; `image_urls` are taken too. MiniMax answers most failures as HTTP 200 with a non-zero
 * `base_resp.status_code`, mapped here. It has no model listing: the catalog alone applies.
 */

import type { AtomicCoreError, RemoteImageWorkflow } from '../../contracts/index.js'
import {
  callProvider,
  decodeBase64Image,
  downloadResult,
  GENERATE_TIMEOUT_MS,
  joinUrl,
  MAX_IMAGE_BYTES,
  parseWxH,
  remoteError,
  sniffImageMime,
  toDataUrl,
} from '../http.js'
import type { MediaContext } from '../http.js'
import type { GeneratedImage, ImageAdapter, ImageGenerationJob } from './types.js'

const WORKFLOWS: readonly RemoteImageWorkflow[] = ['create', 'reference']

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** The JSON body of `POST /image_generation`. */
export function minimaxImageBody(job: ImageGenerationJob): Record<string, unknown> {
  const body: Record<string, unknown> = { model: job.model.id, prompt: job.prompt }
  if (job.aspectRatio) body['aspect_ratio'] = job.aspectRatio
  else {
    // Used only without an aspect ratio, which MiniMax would put first.
    const size = job.width && job.height ? { width: job.width, height: job.height } : parseWxH(job.size)
    if (size) {
      body['width'] = size.width
      body['height'] = size.height
    }
  }
  body['response_format'] = 'base64'
  if (job.seed !== undefined && job.model.params.seed) body['seed'] = job.seed
  if (job.n > 1) body['n'] = job.n
  body['prompt_optimizer'] = false
  const subject = job.images[0]
  if (job.workflow === 'reference' && subject)
    body['subject_reference'] = [{ type: 'character', image_file: toDataUrl(subject.bytes, subject.mime) }]
  return body
}

/**
 * The `REMOTE_*` error a non-zero `base_resp.status_code` means (MiniMax answers those with HTTP
 * 200); `undefined` when the body says the call succeeded or says nothing.
 */
export function minimaxImageStatusError(provider: string, json: unknown): AtomicCoreError | undefined {
  const base = isObject(json) && isObject(json['base_resp']) ? json['base_resp'] : undefined
  const code = base?.['status_code']
  if (typeof code !== 'number' || code === 0) return undefined
  const said =
    typeof base?.['status_msg'] === 'string' && base['status_msg'] !== '' ? base['status_msg'] : undefined
  const details = `status_code ${code}${said ? `: ${said}` : ''}`
  switch (code) {
    case 1002:
      return remoteError('REMOTE_RATE_LIMITED', `${provider} is rate-limiting requests.`, details)
    case 1004:
    case 2049:
      return remoteError('REMOTE_AUTH_FAILED', `${provider} refused the API key.`, details)
    case 1008:
      return remoteError('REMOTE_QUOTA', `${provider} says the account is out of credit.`, details)
    case 1026:
    case 1027:
      return remoteError(
        'REMOTE_CONTENT_BLOCKED',
        `${provider} refused the request: ${said ?? 'sensitive content'}`,
        details
      )
    case 2013:
      return remoteError(
        'REMOTE_REJECTED',
        said ? `${provider}: ${said}` : `${provider} refused the request.`,
        details
      )
    default:
      return remoteError('REMOTE_UNAVAILABLE', `${provider} failed to answer.`, details)
  }
}

/** A file the provider pointed at, with the type its bytes say. Local: `http.ts` has no such helper. */
async function downloadImage(ctx: MediaContext, url: string): Promise<GeneratedImage> {
  const file = await downloadResult(ctx, url, { maxBytes: MAX_IMAGE_BYTES, what: 'image' })
  const mime = sniffImageMime(file.bytes)
  if (!mime) throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} returned a file that is not an image.`)
  return { bytes: file.bytes, mime }
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item !== '') : []

/**
 * The images of an `/image_generation` answer (base64, or URLs downloaded), or the error it amounts
 * to: a status code, or every image held back by the safety check (`metadata.failed_count`).
 */
export async function minimaxImages(ctx: MediaContext, json: unknown): Promise<GeneratedImage[]> {
  const failed = minimaxImageStatusError(ctx.provider, json)
  if (failed) throw failed
  const data = isObject(json) && isObject(json['data']) ? json['data'] : {}
  const out: GeneratedImage[] = strings(data['image_base64']).map((payload) => decodeBase64Image(payload))
  for (const url of strings(data['image_urls'])) out.push(await downloadImage(ctx, url))
  if (out.length > 0) return out
  const metadata = isObject(json) && isObject(json['metadata']) ? json['metadata'] : {}
  const blocked = Number(metadata['failed_count'] ?? 0)
  if (blocked > 0)
    throw remoteError(
      'REMOTE_CONTENT_BLOCKED',
      `${ctx.provider} held back the image for its content.`,
      `failed_count ${blocked}`
    )
  throw remoteError('REMOTE_UNAVAILABLE', `${ctx.provider} answered without an image.`)
}

export const MINIMAX_IMAGE: ImageAdapter = {
  dialect: 'minimax-image',
  kind: 'image',

  async generate(ctx, job, report) {
    if (!WORKFLOWS.includes(job.workflow))
      throw remoteError('REMOTE_UNSUPPORTED', `${ctx.provider} does not support this workflow.`, job.workflow)
    if (job.workflow === 'reference' && job.images.length === 0)
      throw remoteError('REMOTE_UNSUPPORTED', 'This workflow needs a reference image.', job.workflow)
    report({ phase: 'generating' })
    const answer = await callProvider(ctx, joinUrl(ctx.baseUrl, '/image_generation'), {
      json: minimaxImageBody(job),
      timeoutMs: GENERATE_TIMEOUT_MS,
    })
    return minimaxImages(ctx, answer.json)
  },
}
