/**
 * This machine's own clips as a correction to the heuristic: how many times longer (or shorter) the
 * last few clips of the same family, backend and offload took than the heuristic said. The
 * multiplier scales the model, not seconds, so it carries over to another size or length.
 * Selection and the multiplier are pure; `VideoHistory` caches the gallery's recipes between
 * estimates.
 */

import type { VideoRecipe } from '../contracts/index.js'
import { estimateVideoMemory, heuristicSeconds, planDecodeTiling } from './video-estimate.js'
import type { VideoEstimateInput } from './video-estimate.js'

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
 * The median of `actual / heuristic` over the clips that speak for this request, within
 * `HISTORY_MULTIPLIER_RANGE`; undefined when there are none.
 */
export function historyMultiplier(
  recipes: readonly VideoRecipe[],
  input: VideoEstimateInput
): number | undefined {
  const ratios = historyRecipes(recipes, input)
    .map((recipe) => {
      const predicted = heuristicSeconds(recipeInput(input, recipe))
      return predicted > 0 ? recipe.durationMs / 1000 / predicted : undefined
    })
    .filter((ratio): ratio is number => ratio !== undefined && Number.isFinite(ratio))
  if (ratios.length === 0) return undefined
  const [min, max] = HISTORY_MULTIPLIER_RANGE
  return Math.min(Math.max(median(ratios), min), max)
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
