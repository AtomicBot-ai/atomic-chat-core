/**
 * The generation recipe of a video, written as `<jobId>.json` beside the clip (WebM has no text
 * chunk to carry it). Exactly `VideoRecipe`, every key present and absent values `null`, in the
 * order of `ImageRecipe`'s sibling, so a clip copied anywhere can be reproduced. The parser is as
 * strict as `parseRecipe`, because it decides whether a `.webm` in the folder is ours.
 */

import type {
  DiffusionBackend,
  DiffusionEngineId,
  DiffusionOffloadPolicy,
  VideoRecipe,
  VideoWorkflowId,
} from '../contracts/index.js'
import { VIDEO_WORKFLOWS } from './workflow.js'

export const RECIPE_SIDECAR_SUFFIX = '.json'

type Fields = Record<string, unknown>

const ENGINES: readonly DiffusionEngineId[] = ['sd-cpp', 'diffusers']
const BACKENDS: readonly DiffusionBackend[] = ['cpu', 'metal', 'cuda', 'vulkan', 'rocm']
const OFFLOADS: readonly DiffusionOffloadPolicy[] = ['none', 'group', 'model']

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

/** The sidecar's text: every key, fixed order, `null`s, two-space indent like the flags file. */
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
    steps: recipe.steps,
    cfgScale: recipe.cfgScale,
    guidance: recipe.guidance,
    seed: recipe.seed,
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
  return `${JSON.stringify(ordered, null, 2)}\n`
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
  const ok =
    isString(raw['jobId']) &&
    isString(raw['prompt']) &&
    isWhole(raw['width']) &&
    isWhole(raw['height']) &&
    isWhole(raw['frames']) &&
    isWhole(raw['frameCount']) &&
    isWhole(raw['fps']) &&
    isWhole(raw['steps']) &&
    isNumber(raw['cfgScale']) &&
    isI64(raw['seed']) &&
    among<VideoWorkflowId>(raw['workflow'], VIDEO_WORKFLOWS) &&
    raw['outputFormat'] === 'webm' &&
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
    flowShift !== undefined
  if (!ok) return undefined
  return {
    jobId: raw['jobId'] as string,
    prompt: raw['prompt'] as string,
    negativePrompt,
    width: raw['width'] as number,
    height: raw['height'] as number,
    frames: raw['frames'] as number,
    frameCount: raw['frameCount'] as number,
    fps: raw['fps'] as number,
    steps: raw['steps'] as number,
    cfgScale: raw['cfgScale'] as number,
    guidance,
    seed: raw['seed'] as number,
    samplingMethod,
    flowShift,
    workflow: raw['workflow'] as VideoWorkflowId,
    outputFormat: 'webm',
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
