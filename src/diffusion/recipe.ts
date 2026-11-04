/**
 * The generation recipe that travels inside every PNG: `tEXt` keyword `atomic` holds it as JSON
 * (exactly `ImageRecipe`, so an image copied anywhere can be reproduced), and `parameters` holds the
 * Automatic1111 line other tools read. `gallery.rs` in `tauri-plugin-atomic-diffusion` (app commit
 * `767ff6350`).
 */

import { MEDIA_DIALECTS } from '../contracts/index.js'
import type {
  DiffusionBackend,
  DiffusionEngineId,
  DiffusionOffloadPolicy,
  DiffusionRecipeEngine,
  ImageRecipe,
  ImageWorkflowId,
  MediaDialect,
  RemoteImageOptions,
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

/**
 * The Automatic1111 `parameters` string, so other tools show the settings. A knob a provider's
 * model was not sent has no field.
 */
export function a1111Parameters(recipe: ImageRecipe): string {
  let out = `${recipe.prompt}\n`
  if (recipe.negativePrompt) out += `Negative prompt: ${recipe.negativePrompt}\n`
  const fields: string[] = []
  if (recipe.steps !== undefined) fields.push(`Steps: ${recipe.steps}`)
  fields.push(`Sampler: ${recipe.samplingMethod ?? 'default'}`)
  if (recipe.cfgScale !== undefined) fields.push(`CFG scale: ${fmtFloat(recipe.cfgScale)}`)
  if (recipe.guidance !== null) fields.push(`Distilled Guidance: ${fmtFloat(recipe.guidance)}`)
  if (recipe.seed !== undefined) fields.push(`Seed: ${recipe.seed}`)
  fields.push(
    `Size: ${recipe.width}x${recipe.height}`,
    // A remote model has no file: its id stands in.
    `Model: ${recipe.model.filename || recipe.model.modelId}`
  )
  if (recipe.flowShift !== null) fields.push(`Flow shift: ${fmtFloat(recipe.flowShift)}`)
  if (recipe.strength !== null) fields.push(`Denoising strength: ${fmtFloat(recipe.strength)}`)
  return out + fields.join(', ')
}

/**
 * The recipe as it is embedded: every key present, in the plugin's order, absent values as `null`.
 * A remote recipe leaves out the knobs its model was not sent (`steps`, `cfgScale`, `seed`,
 * `batchSeed`); the others keep their places.
 */
export function serializeRecipe(recipe: ImageRecipe): string {
  const ordered: ImageRecipe = {
    jobId: recipe.jobId,
    index: recipe.index,
    prompt: recipe.prompt,
    negativePrompt: recipe.negativePrompt,
    width: recipe.width,
    height: recipe.height,
    ...(recipe.steps === undefined ? {} : { steps: recipe.steps }),
    ...(recipe.cfgScale === undefined ? {} : { cfgScale: recipe.cfgScale }),
    guidance: recipe.guidance,
    ...(recipe.seed === undefined ? {} : { seed: recipe.seed }),
    ...(recipe.batchSeed === undefined ? {} : { batchSeed: recipe.batchSeed }),
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
    engine: orderedEngine(recipe.engine),
    // Only a remote recipe has it, so a local recipe keeps the plugin's exact shape.
    ...(recipe.remote === undefined ? {} : { remote: orderedRemoteImage(recipe.remote) }),
    createdAtMs: recipe.createdAtMs,
    durationMs: recipe.durationMs,
  }
  return JSON.stringify(ordered)
}

/** A recipe's engine with its keys in a fixed order, whichever kind it is. */
export function orderedEngine(engine: DiffusionRecipeEngine): DiffusionRecipeEngine {
  if (engine.kind === 'remote') return { kind: 'remote', provider: engine.provider, api: engine.api }
  return {
    kind: engine.kind,
    backend: engine.backend,
    tag: engine.tag,
    offload: engine.offload,
    cpuFallback: engine.cpuFallback,
  }
}

const REMOTE_IMAGE_KEYS = [
  'size',
  'aspectRatio',
  'resolution',
  'quality',
  'background',
  'outputFormat',
] as const

function orderedRemoteImage(options: RemoteImageOptions): RemoteImageOptions {
  const out: RemoteImageOptions = {}
  for (const key of REMOTE_IMAGE_KEYS) if (options[key] !== undefined) out[key] = options[key]
  return out
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
 * Whether a generation knob (`steps`, `cfgScale`, a seed) is acceptable: a value that passes, or, in
 * a remote recipe only, no key at all — a provider's model is sent only the knobs it takes. A local
 * recipe has every knob, as the plugin wrote it.
 */
export function knobOk(value: unknown, remote: boolean, check: (v: unknown) => v is number): boolean {
  return remote && value === undefined ? true : check(value)
}

/** `{ [key]: value }` for a knob that is there, `{}` for one a remote recipe leaves out. */
export function knob<K extends string>(key: K, value: unknown): { [P in K]?: number } {
  return value === undefined ? {} : ({ [key]: value as number } as { [P in K]?: number })
}

/**
 * A recipe's engine, or `undefined` when it is neither a local engine the plugin knew nor a remote
 * provider through an adapter this core has.
 */
export function parseRecipeEngine(engine: Fields): DiffusionRecipeEngine | undefined {
  if (engine['kind'] === 'remote') {
    if (!isString(engine['provider']) || engine['provider'] === '') return undefined
    if (!among<MediaDialect>(engine['api'], MEDIA_DIALECTS)) return undefined
    return { kind: 'remote', provider: engine['provider'], api: engine['api'] }
  }
  const ok =
    among(engine['kind'], ENGINES) &&
    among(engine['backend'], BACKENDS) &&
    isString(engine['tag']) &&
    among(engine['offload'], OFFLOADS) &&
    typeof engine['cpuFallback'] === 'boolean'
  if (!ok) return undefined
  return {
    kind: engine['kind'] as DiffusionEngineId,
    backend: engine['backend'] as DiffusionBackend,
    tag: engine['tag'] as string,
    offload: engine['offload'] as DiffusionOffloadPolicy,
    cpuFallback: engine['cpuFallback'] as boolean,
  }
}

/** A remote recipe's extra settings: strings only; `undefined` when the value is not such an object. */
function parseRemoteImage(value: unknown): RemoteImageOptions | null | undefined {
  if (value === undefined || value === null) return null
  if (!isObject(value)) return undefined
  const out: RemoteImageOptions = {}
  for (const key of REMOTE_IMAGE_KEYS) {
    const item = value[key]
    if (item === undefined || item === null) continue
    if (!isString(item)) return undefined
    out[key] = item
  }
  return out
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
  const parsedEngine = parseRecipeEngine(engine)
  const remote = parseRemoteImage(raw['remote'])
  const fromProvider = parsedEngine?.kind === 'remote'
  const ok =
    isString(raw['jobId']) &&
    isWhole(raw['index']) &&
    isString(raw['prompt']) &&
    isWhole(raw['width']) &&
    isWhole(raw['height']) &&
    knobOk(raw['steps'], fromProvider, isWhole) &&
    knobOk(raw['cfgScale'], fromProvider, isNumber) &&
    knobOk(raw['seed'], fromProvider, isI64) &&
    knobOk(raw['batchSeed'], fromProvider, isI64) &&
    isWhole(raw['batchSize']) &&
    among<ImageWorkflowId>(raw['workflow'], IMAGE_WORKFLOWS) &&
    isString(model['modelId']) &&
    isString(model['family']) &&
    isString(model['displayName']) &&
    isString(model['filename']) &&
    parsedEngine !== undefined &&
    remote !== undefined &&
    isWhole(raw['createdAtMs']) &&
    isWhole(raw['durationMs']) &&
    negativePrompt !== undefined &&
    guidance !== undefined &&
    samplingMethod !== undefined &&
    flowShift !== undefined &&
    strength !== undefined
  if (!ok || parsedEngine === undefined || remote === undefined) return undefined
  return {
    jobId: raw['jobId'] as string,
    index: raw['index'] as number,
    prompt: raw['prompt'] as string,
    negativePrompt,
    width: raw['width'] as number,
    height: raw['height'] as number,
    ...knob('steps', raw['steps']),
    ...knob('cfgScale', raw['cfgScale']),
    guidance,
    ...knob('seed', raw['seed']),
    ...knob('batchSeed', raw['batchSeed']),
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
    engine: parsedEngine,
    ...(remote === null ? {} : { remote }),
    createdAtMs: raw['createdAtMs'] as number,
    durationMs: raw['durationMs'] as number,
  }
}
