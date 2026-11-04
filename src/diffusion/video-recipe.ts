/**
 * The generation recipe of a video, written as `<jobId>.json` beside the clip (WebM has no text
 * chunk to carry it). Exactly `VideoRecipe`, every key present and absent values `null`, in the
 * order of `ImageRecipe`'s sibling, so a clip copied anywhere can be reproduced. The parser is as
 * strict as `parseRecipe`, because it decides whether a `.webm` in the folder is ours.
 */

import type {
  RemoteVideoOptions,
  VideoOutputFormat,
  VideoRecipe,
  VideoWorkflowId,
} from '../contracts/index.js'
import { knob, knobOk, orderedEngine, parseRecipeEngine } from './recipe.js'
import { VIDEO_WORKFLOWS } from './workflow.js'

export const RECIPE_SIDECAR_SUFFIX = '.json'

type Fields = Record<string, unknown>

const OUTPUT_FORMATS: readonly VideoOutputFormat[] = ['webm', 'mp4']
const REMOTE_VIDEO_STRINGS = ['resolution', 'aspectRatio', 'size'] as const

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const isWhole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0
/** Seeds as `parseRecipe` takes them: an `i64` as a double sees it. */
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
 * The sidecar's text: every key, fixed order, `null`s, two-space indent like the flags file. A
 * provider's clip leaves out the steps and CFG it is never sent, and the seed its model did not take.
 */
export function serializeVideoRecipe(recipe: VideoRecipe): string {
  const ordered: VideoRecipe = {
    jobId: recipe.jobId,
    prompt: recipe.prompt,
    negativePrompt: recipe.negativePrompt,
    width: recipe.width,
    height: recipe.height,
    frames: recipe.frames,
    frameCount: recipe.frameCount,
    fps: recipe.fps,
    ...(recipe.steps === undefined ? {} : { steps: recipe.steps }),
    ...(recipe.cfgScale === undefined ? {} : { cfgScale: recipe.cfgScale }),
    guidance: recipe.guidance,
    ...(recipe.seed === undefined ? {} : { seed: recipe.seed }),
    samplingMethod: recipe.samplingMethod,
    flowShift: recipe.flowShift,
    workflow: recipe.workflow,
    outputFormat: recipe.outputFormat,
    model: {
      modelId: recipe.model.modelId,
      family: recipe.model.family,
      displayName: recipe.model.displayName,
      filename: recipe.model.filename,
    },
    engine: orderedEngine(recipe.engine),
    createdAtMs: recipe.createdAtMs,
    durationMs: recipe.durationMs,
    ...(recipe.decodeMs === undefined ? {} : { decodeMs: recipe.decodeMs }),
    ...(recipe.durationSecs === undefined ? {} : { durationSecs: recipe.durationSecs }),
    ...(recipe.remote === undefined ? {} : { remote: orderedRemoteVideo(recipe.remote) }),
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}

function orderedRemoteVideo(options: RemoteVideoOptions): RemoteVideoOptions {
  const out: RemoteVideoOptions = {}
  if (options.durationSecs !== undefined) out.durationSecs = options.durationSecs
  for (const key of REMOTE_VIDEO_STRINGS) if (options[key] !== undefined) out[key] = options[key]
  if (options.generateAudio !== undefined) out.generateAudio = options.generateAudio
  return out
}

/** A remote clip's extra settings, or `undefined` when the value is not such an object. */
function parseRemoteVideo(value: unknown): RemoteVideoOptions | null | undefined {
  if (value === undefined || value === null) return null
  if (!isObject(value)) return undefined
  const out: RemoteVideoOptions = {}
  const duration = value['durationSecs']
  if (duration !== undefined && duration !== null) {
    if (!isNumber(duration)) return undefined
    out.durationSecs = duration
  }
  for (const key of REMOTE_VIDEO_STRINGS) {
    const item = value[key]
    if (item === undefined || item === null) continue
    if (!isString(item)) return undefined
    out[key] = item
  }
  const audio = value['generateAudio']
  if (audio !== undefined && audio !== null) {
    if (typeof audio !== 'boolean') return undefined
    out.generateAudio = audio
  }
  return out
}

/** The recipe out of a sidecar, or `undefined` when the text is not one. */
export function parseVideoRecipe(text: string): VideoRecipe | undefined {
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
  const parsedEngine = parseRecipeEngine(engine)
  const remote = parseRemoteVideo(raw['remote'])
  const fromProvider = parsedEngine?.kind === 'remote'
  const ok =
    isString(raw['jobId']) &&
    isString(raw['prompt']) &&
    isWhole(raw['width']) &&
    isWhole(raw['height']) &&
    isWhole(raw['frames']) &&
    isWhole(raw['frameCount']) &&
    isWhole(raw['fps']) &&
    knobOk(raw['steps'], fromProvider, isWhole) &&
    knobOk(raw['cfgScale'], fromProvider, isNumber) &&
    knobOk(raw['seed'], fromProvider, isI64) &&
    among<VideoWorkflowId>(raw['workflow'], VIDEO_WORKFLOWS) &&
    among(raw['outputFormat'], OUTPUT_FORMATS) &&
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
    flowShift !== undefined
  if (!ok || parsedEngine === undefined || remote === undefined) return undefined
  return {
    jobId: raw['jobId'] as string,
    prompt: raw['prompt'] as string,
    negativePrompt,
    width: raw['width'] as number,
    height: raw['height'] as number,
    frames: raw['frames'] as number,
    frameCount: raw['frameCount'] as number,
    fps: raw['fps'] as number,
    ...knob('steps', raw['steps']),
    ...knob('cfgScale', raw['cfgScale']),
    guidance,
    ...knob('seed', raw['seed']),
    samplingMethod,
    flowShift,
    workflow: raw['workflow'] as VideoWorkflowId,
    outputFormat: raw['outputFormat'] as VideoOutputFormat,
    model: {
      modelId: model['modelId'] as string,
      family: model['family'] as string,
      displayName: model['displayName'] as string,
      filename: model['filename'] as string,
    },
    engine: parsedEngine,
    createdAtMs: raw['createdAtMs'] as number,
    durationMs: raw['durationMs'] as number,
    // Older clips have none; a malformed one is dropped rather than the clip.
    ...(isWhole(raw['decodeMs']) ? { decodeMs: raw['decodeMs'] as number } : {}),
    ...(isNumber(raw['durationSecs']) && raw['durationSecs'] >= 0
      ? { durationSecs: raw['durationSecs'] }
      : {}),
    ...(remote === null ? {} : { remote }),
  }
}
