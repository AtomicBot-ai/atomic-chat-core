/**
 * This machine's own clips as a correction to the heuristic: how many times longer (or shorter) the
 * last few clips of the same family, backend and offload took than the heuristic said. The
 * multiplier scales the model, not seconds, so it carries over to another size or length.
 * Selection and the multiplier are pure; `VideoHistory` caches the gallery's recipes between
 * estimates.
 */

import type { VideoRecipe } from '../contracts/index.js'
import { estimateVideoMemory, heuristicParts, planDecodeTiling } from './video-estimate.js'
import type { VideoEstimateInput, VideoHistoryMultiplier } from './video-estimate.js'

/** At most this many clips, the newest first. */
export const HISTORY_LIMIT = 5
/** The multiplier never moves the heuristic further than this either way. */
export const HISTORY_MULTIPLIER_RANGE: readonly [number, number] = [0.1, 10]

/**
 * The request's inputs with a recipe's own size, length, steps and guidance, and the decode tiling
 * this machine plans for that clip (the recipe does not record one; a clip made before the plan
 * existed ran on the pixel-frame threshold instead).
 */
export function recipeInput(input: VideoEstimateInput, recipe: VideoRecipe): VideoEstimateInput {
  const { decodeTiling: _request, ...rest } = input
  const base: VideoEstimateInput = {
    ...rest,
    width: recipe.width,
    height: recipe.height,
    frames: recipe.frames,
    steps: recipe.steps,
    cfgScale: recipe.cfgScale,
  }
  if (!input.decodeTiling) return base
  const decodeTiling = planDecodeTiling(base)
  return decodeTiling ? { ...base, decodeTiling } : base
}

/**
 * The clips that speak for this request: the same family, backend and offload, not finished on the
 * CPU fallback, and not a run whose own parameters exceed memory (a clip that swapped says nothing
 * about the machine's speed). Newest first, at most `HISTORY_LIMIT`.
 */
export function historyRecipes(recipes: readonly VideoRecipe[], input: VideoEstimateInput): VideoRecipe[] {
  return recipes
    .filter(
      (recipe) =>
        recipe.model.family === input.family &&
        recipe.engine.backend === input.backend &&
        recipe.engine.offload === input.offload &&
        !recipe.engine.cpuFallback &&
        recipe.durationMs > 0 &&
        estimateVideoMemory(recipeInput(input, recipe))?.verdict !== 'exceeds'
    )
    .sort((a, b) => b.createdAtMs - a.createdAtMs)
    .slice(0, HISTORY_LIMIT)
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

/**
 * The median of `actual / heuristic` over the clips that speak for this request, for the sampling
 * and for the decode apart, each within `HISTORY_MULTIPLIER_RANGE`; undefined when there are none.
 * A clip that recorded its `decodeMs` calibrates the two separately: a single-graph decode on Metal
 * can be most of a short clip's time and miss the table by far more than the steps do, so one ratio
 * for both under-forecasts a few-step clip. An older clip has only its total, which stands for both.
 */
export function historyMultiplier(
  recipes: readonly VideoRecipe[],
  input: VideoEstimateInput
): VideoHistoryMultiplier | undefined {
  const sampling: number[] = []
  const decode: number[] = []
  for (const recipe of historyRecipes(recipes, input)) {
    const clip = recipeInput(input, recipe)
    const parts = heuristicParts(clip)
    const samplingSeconds = parts.encodeSeconds + Math.max(clip.steps, 1) * parts.stepSeconds
    const seconds = recipe.durationMs / 1000
    if (recipe.decodeMs !== undefined && samplingSeconds > 0 && parts.decodeSeconds > 0) {
      const decodeSeconds = recipe.decodeMs / 1000
      sampling.push((seconds - decodeSeconds) / samplingSeconds)
      decode.push(decodeSeconds / parts.decodeSeconds)
      continue
    }
    const predicted = samplingSeconds + parts.decodeSeconds
    if (predicted > 0) {
      sampling.push(seconds / predicted)
      decode.push(seconds / predicted)
    }
  }
  const [min, max] = HISTORY_MULTIPLIER_RANGE
  const calibrated = (ratios: number[]): number | undefined => {
    const finite = ratios.filter(Number.isFinite)
    return finite.length === 0 ? undefined : Math.min(Math.max(median(finite), min), max)
  }
  const samplingK = calibrated(sampling)
  const decodeK = calibrated(decode)
  return samplingK === undefined || decodeK === undefined
    ? undefined
    : { sampling: samplingK, decode: decodeK }
}

/**
 * The recipes of the video gallery, read once per folder and kept until a clip is added or removed.
 * A failed read is not cached: the next estimate tries again.
 */
export class VideoHistory {
  private cached: { dir: string; recipes: Promise<VideoRecipe[]> } | undefined

  constructor(private readonly read: (dir: string) => Promise<VideoRecipe[]>) {}

  recipes(dir: string): Promise<VideoRecipe[]> {
    if (this.cached?.dir === dir) return this.cached.recipes
    const recipes = this.read(dir)
    const entry = { dir, recipes }
    this.cached = entry
    recipes.catch(() => {
      if (this.cached === entry) this.cached = undefined
    })
    return recipes
  }

  /** A clip was saved or deleted: the next estimate reads the gallery again. */
  invalidate(): void {
    this.cached = undefined
  }
}
