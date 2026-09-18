/**
 * The generation recipe that travels inside every PNG: `tEXt` keyword `atomic` holds it as JSON
 * (exactly `ImageRecipe`, so an image copied anywhere can be reproduced), and `parameters` holds the
 * Automatic1111 line other tools read. `gallery.rs` in `tauri-plugin-atomic-diffusion` (app commit
 * `767ff6350`).
 */

import type {
  DiffusionBackend,
  DiffusionEngineId,
  DiffusionOffloadPolicy,
  ImageRecipe,
  ImageWorkflowId,
} from '../contracts/index.js'
import { expandExponent } from '../util/index.js'
import { internalError } from './errors.js'
import { insertAfterHeader, textChunk } from './png.js'
import { IMAGE_WORKFLOWS } from './workflow.js'

export const RECIPE_KEYWORD = 'atomic'
export const PARAMETERS_KEYWORD = 'parameters'

/** A whole number without a fraction, anything else as Rust's `Display` prints it (never an exponent). */
export function fmtFloat(value: number): string {
  if (Number.isNaN(value)) return 'NaN'
  if (!Number.isFinite(value)) return value > 0 ? 'inf' : '-inf'
  if (Number.isInteger(value)) {
    if (value >= 2 ** 63) return '9223372036854775807'
    if (value <= -(2 ** 63)) return '-9223372036854775808'
    return BigInt(value).toString()
  }
  return expandExponent(String(value))
}

/** The Automatic1111 `parameters` string, so other tools show the settings. */
export function a1111Parameters(recipe: ImageRecipe): string {
  let out = `${recipe.prompt}\n`
  if (recipe.negativePrompt) out += `Negative prompt: ${recipe.negativePrompt}\n`
  const fields = [
    `Steps: ${recipe.steps}`,
    `Sampler: ${recipe.samplingMethod ?? 'default'}`,
    `CFG scale: ${fmtFloat(recipe.cfgScale)}`,
  ]
  if (recipe.guidance !== null) fields.push(`Distilled Guidance: ${fmtFloat(recipe.guidance)}`)
  fields.push(
    `Seed: ${recipe.seed}`,
    `Size: ${recipe.width}x${recipe.height}`,
    `Model: ${recipe.model.filename}`
  )
  if (recipe.flowShift !== null) fields.push(`Flow shift: ${fmtFloat(recipe.flowShift)}`)
  if (recipe.strength !== null) fields.push(`Denoising strength: ${fmtFloat(recipe.strength)}`)
  return out + fields.join(', ')
}

/** The recipe as it is embedded: every key present, in the plugin's order, absent values as `null`. */
export function serializeRecipe(recipe: ImageRecipe): string {
  const ordered: ImageRecipe = {
    jobId: recipe.jobId,
    index: recipe.index,
    prompt: recipe.prompt,
    negativePrompt: recipe.negativePrompt,
    width: recipe.width,
    height: recipe.height,
    steps: recipe.steps,
    cfgScale: recipe.cfgScale,
    guidance: recipe.guidance,
    seed: recipe.seed,
    batchSeed: recipe.batchSeed,
    batchSize: recipe.batchSize,
    samplingMethod: recipe.samplingMethod,
    flowShift: recipe.flowShift,
    workflow: recipe.workflow,
    strength: recipe.strength,
    model: {
      modelId: recipe.model.modelId,
      family: recipe.model.family,
      displayName: recipe.model.displayName,
      filename: recipe.model.filename,
    },
    engine: {
      kind: recipe.engine.kind,
      backend: recipe.engine.backend,
      tag: recipe.engine.tag,
      offload: recipe.engine.offload,
      cpuFallback: recipe.engine.cpuFallback,
    },
    createdAtMs: recipe.createdAtMs,
    durationMs: recipe.durationMs,
  }
  return JSON.stringify(ordered)
}

/**
 * Insert the `atomic` and `parameters` chunks right after `IHDR`, without touching the image data.
 * Whatever the engine wrote after them (sd.cpp adds a `parameters` chunk of its own) stays.
 */
export function spliceRecipe(png: Buffer, recipe: ImageRecipe): Buffer {
  const spliced = insertAfterHeader(png, [
    textChunk(RECIPE_KEYWORD, serializeRecipe(recipe)),
    textChunk(PARAMETERS_KEYWORD, a1111Parameters(recipe)),
  ])
  if (spliced === 'not-png') throw internalError('The engine returned something that is not a PNG.')
  if (spliced === 'no-ihdr') throw internalError('The engine returned a PNG without an IHDR chunk.')
  return spliced
}

type Fields = Record<string, unknown>

const ENGINES: readonly DiffusionEngineId[] = ['sd-cpp', 'diffusers']
const BACKENDS: readonly DiffusionBackend[] = ['cpu', 'metal', 'cuda', 'vulkan', 'rocm']
const OFFLOADS: readonly DiffusionOffloadPolicy[] = ['none', 'group', 'model']

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isWhole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
/**
 * Seeds. The plugin stored them as `i64`, and 2.0.40's `/v1/images/generations` took any `i64`, so a
 * gallery PNG can hold one above 2^53. `JSON.parse` has already rounded it to the nearest double, and
 * that is what the listing carries. Refusing it would make the image foreign: never listed, never
 * deleted. The bound is `i64`'s as a double sees it (`i64::MAX` rounds up to 2^63). The core itself
 * never writes one: `validateRequest` keeps `seed + batchSize - 1` within 2^53 - 1, so every
 * recorded `batchSeed + index` is exact. Sending such a rounded seed back is refused there.
 */
const isI64 = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2 ** 63
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const among = <T extends string>(value: unknown, allowed: readonly T[]): value is T =>
  isString(value) && (allowed as readonly string[]).includes(value)

/** `value` when it passes, `null` when it is absent or `null`, `undefined` (a failure) otherwise. */
function optional<T>(value: unknown, check: (v: unknown) => v is T): T | null | undefined {
  if (value === undefined || value === null) return null
  return check(value) ? value : undefined
}

/**
 * The recipe out of an `atomic` chunk, or `undefined` when the text is not one. As strict as the
 * plugin's serde was, because this is what decides whether a PNG in the output folder is ours: an
 * image without a valid recipe is never listed and never deleted.
 */
export function parseRecipe(text: string): ImageRecipe | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isObject(raw) || !isObject(raw['model']) || !isObject(raw['engine'])) return undefined
  const { model, engine } = raw
  const negativePrompt = optional(raw['negativePrompt'], isString)
  const guidance = optional(raw['guidance'], isNumber)
  const samplingMethod = optional(raw['samplingMethod'], isString)
  const flowShift = optional(raw['flowShift'], isNumber)
  const strength = optional(raw['strength'], isNumber)
  const ok =
    isString(raw['jobId']) &&
    isWhole(raw['index']) &&
    isString(raw['prompt']) &&
    isWhole(raw['width']) &&
    isWhole(raw['height']) &&
    isWhole(raw['steps']) &&
    isNumber(raw['cfgScale']) &&
    isI64(raw['seed']) &&
    isI64(raw['batchSeed']) &&
    isWhole(raw['batchSize']) &&
    among<ImageWorkflowId>(raw['workflow'], IMAGE_WORKFLOWS) &&
    isString(model['modelId']) &&
    isString(model['family']) &&
    isString(model['displayName']) &&
    isString(model['filename']) &&
    among(engine['kind'], ENGINES) &&
    among(engine['backend'], BACKENDS) &&
    isString(engine['tag']) &&
    among(engine['offload'], OFFLOADS) &&
    typeof engine['cpuFallback'] === 'boolean' &&
    isWhole(raw['createdAtMs']) &&
    isWhole(raw['durationMs']) &&
    negativePrompt !== undefined &&
    guidance !== undefined &&
    samplingMethod !== undefined &&
    flowShift !== undefined &&
    strength !== undefined
  if (!ok) return undefined
  return {
    jobId: raw['jobId'] as string,
    index: raw['index'] as number,
    prompt: raw['prompt'] as string,
    negativePrompt,
    width: raw['width'] as number,
    height: raw['height'] as number,
    steps: raw['steps'] as number,
    cfgScale: raw['cfgScale'] as number,
    guidance,
    seed: raw['seed'] as number,
    batchSeed: raw['batchSeed'] as number,
    batchSize: raw['batchSize'] as number,
    samplingMethod,
    flowShift,
    workflow: raw['workflow'] as ImageWorkflowId,
    strength,
    model: {
      modelId: model['modelId'] as string,
      family: model['family'] as string,
      displayName: model['displayName'] as string,
      filename: model['filename'] as string,
    },
    engine: {
      kind: engine['kind'] as DiffusionEngineId,
      backend: engine['backend'] as DiffusionBackend,
      tag: engine['tag'] as string,
      offload: engine['offload'] as DiffusionOffloadPolicy,
      cpuFallback: engine['cpuFallback'] as boolean,
    },
    createdAtMs: raw['createdAtMs'] as number,
    durationMs: raw['durationMs'] as number,
  }
}
