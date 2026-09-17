/**
 * What a generation request must satisfy before anything is spawned or evicted for it.
 * `validate_request`, `check_source` and `strip_data_url` in `jobs.rs` of
 * `tauri-plugin-atomic-diffusion` (app commit `767ff6350`); messages verbatim, checks in the same
 * order, because the first failing one is what the user is shown.
 */

import type { ImageGenerateRequest, ImageSource } from '../contracts/index.js'
import { diffusionError } from './errors.js'
import { MAX_BATCH } from './types.js'
import type { ServerSpec } from './types.js'
import { usesMask, workflowOf, workflowsForFamily } from './workflow.js'

export interface ValidateDeps {
  /** Whether `path` is an existing regular file. */
  isFile: (path: string) => Promise<boolean>
}

/** `data:image/png;base64,....` → the base64 part. A plain payload is returned unchanged. */
export function stripDataUrl(value: string): string {
  if (!value.startsWith('data:')) return value
  const rest = value.slice('data:'.length)
  const comma = rest.indexOf(',')
  return comma < 0 ? rest : rest.slice(comma + 1)
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Canonical standard base64, which is what the plugin's decoder insisted on: the standard alphabet,
 * no whitespace, padding present and exact, unused trailing bits zero. Checked without decoding,
 * because a payload can be tens of megabytes.
 */
export function isCanonicalBase64(payload: string): boolean {
  if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return false
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  if (padding === 0) return true
  const last = BASE64_ALPHABET.indexOf(payload[payload.length - padding - 1] as string)
  // Two padding characters leave 4 unused bits in the last sextet, one leaves 2.
  return (last & (padding === 2 ? 0x0f : 0x03)) === 0
}

/**
 * A source must be present and usable: an existing file, or base64 that decodes. Refusing here
 * keeps a bad input from evicting the chat model and spinning up the server for nothing.
 */
async function checkSource(source: ImageSource | undefined, what: string, deps: ValidateDeps): Promise<void> {
  if (source === undefined) throw diffusionError('INVALID_REQUEST', `This workflow needs ${what}.`)
  if ('path' in source) {
    if (await deps.isFile(source.path)) return
    throw diffusionError('INVALID_REQUEST', 'The source image could not be found.', source.path)
  }
  const payload = stripDataUrl(source.base64)
  if (payload === '' || !isCanonicalBase64(payload))
    throw diffusionError('INVALID_REQUEST', 'The inline image is not valid base64.')
}

export async function validateRequest(
  request: ImageGenerateRequest,
  spec: ServerSpec,
  deps: ValidateDeps
): Promise<void> {
  if (request.prompt.trim() === '') throw diffusionError('INVALID_REQUEST', 'Enter a prompt.')
  const [minDim, maxDim] = spec.ranges.dims
  const multiple = Math.max(spec.ranges.dimMultiple, 1)
  for (const [label, value] of [
    ['width', request.width],
    ['height', request.height],
  ] as const) {
    if (value < minDim || value > maxDim)
      throw diffusionError(
        'INVALID_DIMENSIONS',
        `${label} must be between ${minDim} and ${maxDim}.`,
        `${label}=${value}`
      )
    if (value % multiple !== 0)
      throw diffusionError(
        'INVALID_DIMENSIONS',
        `${label} must be a multiple of ${multiple}.`,
        `${label}=${value}`
      )
  }
  const [minSteps, maxSteps] = spec.ranges.steps
  if (request.steps < minSteps || request.steps > maxSteps)
    throw diffusionError(
      'INVALID_REQUEST',
      `Steps must be between ${minSteps} and ${maxSteps}.`,
      `steps=${request.steps}`
    )
  if (request.batchSize < 1 || request.batchSize > MAX_BATCH)
    throw diffusionError(
      'INVALID_REQUEST',
      `Batch size must be between 1 and ${MAX_BATCH}.`,
      `batchSize=${request.batchSize}`
    )
  if (!Number.isFinite(request.cfgScale) || request.cfgScale < 0)
    throw diffusionError('INVALID_REQUEST', 'CFG scale must be a non-negative number.')
  if (request.strength !== undefined && !(request.strength >= 0 && request.strength <= 1))
    throw diffusionError('INVALID_REQUEST', 'Strength must be between 0 and 1.')

  const workflow = workflowOf(request)
  if (workflow === 'create') return
  if (!workflowsForFamily(spec.family).includes(workflow))
    throw diffusionError(
      'UNSUPPORTED_WORKFLOW',
      `This model cannot run the ${workflow} workflow.`,
      spec.family
    )
  // Every workflow but Create starts from one source image; the reference workflows send it as the
  // first reference.
  await checkSource(request.initImage, 'a source image', deps)
  if (usesMask(workflow)) await checkSource(request.maskImage, 'a mask', deps)
  for (const extra of request.referenceImages ?? []) await checkSource(extra, 'a reference image', deps)
}
