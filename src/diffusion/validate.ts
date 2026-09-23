/**
 * What a generation request must satisfy before anything is spawned or evicted for it.
 * `validate_request`, `check_source` and `strip_data_url` in `jobs.rs` of
 * `tauri-plugin-atomic-diffusion` (app commit `ec1fd3ea7`); messages verbatim, checks in the same
 * order, because the first failing one is what the user is shown.
 */

import type { ImageGenerateRequest, ImageSource, VideoGenerateRequest } from '../contracts/index.js'
import { diffusionError } from './errors.js'
import { MAX_BATCH } from './types.js'
import type { ServerSpec } from './types.js'
import {
  usesMask,
  usesReferences,
  videoWorkflowsForFamily,
  workflowOf,
  workflowsForSpec,
} from './workflow.js'

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

/** Width and height inside the family's range and on its grid; the message names the first offender. */
function checkDims(request: { width: number; height: number }, spec: ServerSpec): void {
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
}

function checkSteps(steps: number, spec: ServerSpec): void {
  const [minSteps, maxSteps] = spec.ranges.steps
  if (steps < minSteps || steps > maxSteps)
    throw diffusionError(
      'INVALID_REQUEST',
      `Steps must be between ${minSteps} and ${maxSteps}.`,
      `steps=${steps}`
    )
}

export async function validateRequest(
  request: ImageGenerateRequest,
  spec: ServerSpec,
  deps: ValidateDeps
): Promise<void> {
  if (request.prompt.trim() === '') throw diffusionError('INVALID_REQUEST', 'Enter a prompt.')
  checkDims(request, spec)
  // Qwen-Image past one megapixel faults the GPU on Metal instead of failing cleanly.
  if (
    spec.backend === 'metal' &&
    spec.family === 'qwen-image' &&
    request.width * request.height > 1024 * 1024
  )
    throw diffusionError(
      'INVALID_DIMENSIONS',
      'Qwen-Image is limited to about one megapixel on Apple GPUs. Choose a smaller resolution.',
      `${request.width}x${request.height} exceeds the Metal-safe pixel budget`
    )
  checkSteps(request.steps, spec)
  if (request.batchSize < 1 || request.batchSize > MAX_BATCH)
    throw diffusionError(
      'INVALID_REQUEST',
      `Batch size must be between 1 and ${MAX_BATCH}.`,
      `batchSize=${request.batchSize}`
    )
  // Each image records `seed + index` as a double; past 2^53 that sum is rounded, and the recorded seed
  // would no longer reproduce what sd.cpp (64-bit) generated. A negative seed asks for a random one.
  if (request.seed !== undefined && request.seed >= 0) {
    const highest = Number.MAX_SAFE_INTEGER - (request.batchSize - 1)
    if (request.seed > highest)
      throw diffusionError(
        'INVALID_REQUEST',
        `The seed must be at most ${highest} for a batch of ${request.batchSize}.`,
        `seed=${request.seed}`
      )
  }
  if (!Number.isFinite(request.cfgScale) || request.cfgScale < 0)
    throw diffusionError('INVALID_REQUEST', 'CFG scale must be a non-negative number.')
  if (request.strength !== undefined && !(request.strength >= 0 && request.strength <= 1))
    throw diffusionError('INVALID_REQUEST', 'Strength must be between 0 and 1.')

  const workflow = workflowOf(request)
  if (workflow === 'create') return
  if (spec.family === 'qwen-image-2.1' && usesReferences(workflow) && spec.files.llmVision === undefined)
    throw diffusionError(
      'SIDE_FILE_MISSING',
      'Qwen Image 2.1 editing needs its Qwen3-VL vision projector.',
      'Load the model with llmVision so sd.cpp receives --llm_vision.'
    )
  if (!workflowsForSpec(spec).includes(workflow))
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

/** How a family counts frames: valid counts are `k * step + offset`. */
export interface FrameRule {
  step: number
  offset: number
}

export function isValidFrameCount(frames: number, rule: FrameRule, range: [number, number]): boolean {
  const [min, max] = range
  if (!Number.isInteger(frames) || frames < min || frames > max) return false
  const step = Math.max(rule.step, 1)
  return frames >= rule.offset && (frames - rule.offset) % step === 0
}

/** The largest valid frame count at most `wanted`; undefined when even the smallest is more. */
export function largestValidFrames(
  wanted: number,
  rule: FrameRule,
  range: [number, number]
): number | undefined {
  const [min, max] = range
  const step = Math.max(rule.step, 1)
  const ceiling = Math.min(Math.floor(wanted), max)
  if (ceiling < rule.offset) return undefined
  const frames = rule.offset + Math.floor((ceiling - rule.offset) / step) * step
  return frames >= min ? frames : undefined
}

/**
 * A video request against the loaded video family: the image checks that apply, then the frame count
 * on the family's lattice, the fixed frame rate, and the one workflow this build serves.
 */
export async function validateVideoRequest(
  request: VideoGenerateRequest,
  spec: ServerSpec,
  _deps: ValidateDeps
): Promise<void> {
  if (request.prompt.trim() === '') throw diffusionError('INVALID_REQUEST', 'Enter a prompt.')
  const video = spec.defaults.video
  const range = spec.ranges.frames
  if (video === undefined || range === undefined)
    throw diffusionError('INTERNAL', 'The loaded model has no video defaults.', spec.modelId)
  checkDims(request, spec)
  checkSteps(request.steps, spec)
  if (!Number.isFinite(request.cfgScale) || request.cfgScale < 0)
    throw diffusionError('INVALID_REQUEST', 'CFG scale must be a non-negative number.')
  // One clip per job: the recipe records the seed as is, so only the double's own limit applies.
  if (request.seed !== undefined && request.seed > Number.MAX_SAFE_INTEGER)
    throw diffusionError(
      'INVALID_REQUEST',
      `The seed must be at most ${Number.MAX_SAFE_INTEGER}.`,
      `seed=${request.seed}`
    )
  if (request.fps !== undefined && request.fps !== video.fps)
    throw diffusionError('INVALID_REQUEST', `This model generates at ${video.fps} fps.`, `fps=${request.fps}`)
  const frames = request.frames ?? video.frames
  if (!isValidFrameCount(frames, { step: video.frameStep, offset: video.frameOffset }, range))
    throw diffusionError(
      'INVALID_REQUEST',
      `Frames must be ${video.frameStep}k+${video.frameOffset} between ${range[0]} and ${range[1]}.`,
      `frames=${frames}`
    )
  const workflow = request.workflow ?? 'create'
  if (!videoWorkflowsForFamily(spec.family).includes(workflow))
    throw diffusionError('UNSUPPORTED_WORKFLOW', 'Image-to-video is not available yet.', workflow)
  if (request.initImage !== undefined || request.endImage !== undefined)
    throw diffusionError(
      'UNSUPPORTED_WORKFLOW',
      'Image-to-video is not available yet.',
      'initImage/endImage need the image-to-video workflow'
    )
}
