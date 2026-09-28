import { describe, expect, it } from 'vitest'
import type { SystemInfo, VideoRecipe } from '../contracts/index.js'
import { jobId, sampleVideoRecipe } from '../../test/helpers/diffusion-fixtures.js'
import { VIDEO_VAE_TILING_PIXEL_FRAMES } from './args.js'
import { estimateVideoCost, heuristicSeconds } from './video-estimate.js'
import type { VideoEstimateInput } from './video-estimate.js'
import {
  HISTORY_LIMIT,
  historyMultiplier,
  historyRecipes,
  recipeInput,
  VideoHistory,
} from './video-history.js'

const MAC: SystemInfo = {
  cpu: { name: 'Apple M3 Max', core_count: 14, arch: 'aarch64', extensions: [], extensions_known: true },
  os_type: 'macos',
  os_name: 'macOS 15',
  total_memory: 64 * 1024,
  gpus: [],
}

/** An LTX request at the recipe fixture's backend and offload (metal, group). */
function input(overrides: Partial<VideoEstimateInput> = {}): VideoEstimateInput {
  return {
    family: 'ltx-2',
    backend: 'metal',
    offload: 'group',
    cpuFallback: false,
    fileBytes: { diffusionModel: 14e9, vae: 1.5e9, llm: 7.4e9 },
    width: 768,
    height: 512,
    frames: 121,
    steps: 8,
    cfgScale: 1,
    tilingPixelFrames: VIDEO_VAE_TILING_PIXEL_FRAMES,
    system: MAC,
    ...overrides,
  }
}

/** A clip that took `factor` times the heuristic for its own parameters. */
function clip(n: number, factor: number, overrides: Partial<VideoRecipe> = {}): VideoRecipe {
  const recipe = sampleVideoRecipe({ jobId: jobId(n), createdAtMs: 1_000 + n, ...overrides })
  return { ...recipe, durationMs: Math.round(heuristicSeconds(recipeInput(input(), recipe)) * factor * 1000) }
}

describe('historyRecipes', () => {
  it('keeps the same family, backend and offload, without the CPU fallback or a swapped run, newest first', () => {
    const recipes = [
      clip(1, 2),
      clip(2, 2, { model: { ...sampleVideoRecipe().model, family: 'wan2.2-ti2v-5b' } }),
      clip(3, 2, { engine: { ...sampleVideoRecipe().engine, backend: 'cuda' } }),
      clip(4, 2, { engine: { ...sampleVideoRecipe().engine, offload: 'none' } }),
      clip(5, 2, { engine: { ...sampleVideoRecipe().engine, cpuFallback: true } }),
      // 1216×704 × 257 frames at this model's weights is more than 64 GB of unified memory holds.
      clip(6, 2, { width: 1216, height: 704, frames: 257, frameCount: 257 }),
      clip(7, 2),
      { ...clip(8, 2), durationMs: 0 },
    ]
    expect(historyRecipes(recipes, input()).map((r) => r.jobId)).toEqual([jobId(7), jobId(1)])
  })

  it('reads at most the newest few', () => {
    const recipes = Array.from({ length: 9 }, (_, n) => clip(n + 1, 1))
    const chosen = historyRecipes(recipes, input())
    expect(chosen).toHaveLength(HISTORY_LIMIT)
    expect(chosen[0]?.jobId).toBe(jobId(9))
  })
})

describe('historyMultiplier', () => {
  it('is undefined on a machine without matching clips', () => {
    expect(historyMultiplier([], input())).toBeUndefined()
    const other = clip(1, 2, { model: { ...sampleVideoRecipe().model, family: 'wan2.2-ti2v-5b' } })
    expect(historyMultiplier([other], input())).toBeUndefined()
    const cost = estimateVideoCost(input(), historyMultiplier([other], input()))
    expect(cost?.estimate.basis).toBe('heuristic')
  })

  it('doubles the middle after three clips that each took twice the heuristic', () => {
    const recipes = [
      clip(1, 2),
      clip(2, 2, { frames: 49, frameCount: 49 }),
      clip(3, 2, { width: 512, height: 768 }),
    ]
    const k = historyMultiplier(recipes, input())
    expect(k).toBeCloseTo(2, 3)
    const heuristic = estimateVideoCost(input()) as NonNullable<ReturnType<typeof estimateVideoCost>>
    const history = estimateVideoCost(input(), k) as NonNullable<ReturnType<typeof estimateVideoCost>>
    expect(history.estimate.basis).toBe('history')
    const mid = (s: { low: number; high: number } | null) => Math.sqrt((s?.low ?? 0) * (s?.high ?? 0))
    expect(mid(history.estimate.seconds) / mid(heuristic.estimate.seconds)).toBeCloseTo(2, 1)
    // Never wider than the heuristic range for the same parameters.
    const width = (s: { low: number; high: number } | null) => (s?.high ?? 0) / (s?.low ?? 1)
    expect(width(history.estimate.seconds)).toBeLessThan(width(heuristic.estimate.seconds))
  })

  it('takes the median, and keeps it within ×0.1..×10', () => {
    expect(historyMultiplier([clip(1, 1), clip(2, 3), clip(3, 100)], input())).toBeCloseTo(3, 3)
    expect(historyMultiplier([clip(1, 1), clip(2, 3)], input())).toBeCloseTo(2, 3)
    expect(historyMultiplier([clip(1, 50)], input())).toBe(10)
    expect(historyMultiplier([clip(1, 0.01)], input())).toBe(0.1)
  })
})

describe('VideoHistory', () => {
  it('reads a folder once until a clip changes it, and retries a failed read', async () => {
    const reads: string[] = []
    let fail = true
    const history = new VideoHistory(async (dir) => {
      reads.push(dir)
      if (fail) throw new Error('unreadable')
      return [clip(1, 1)]
    })
    await expect(history.recipes('/videos')).rejects.toThrow('unreadable')
    fail = false
    expect(await history.recipes('/videos')).toHaveLength(1)
    expect(await history.recipes('/videos')).toHaveLength(1)
    expect(reads).toEqual(['/videos', '/videos'])
    // Another folder is another gallery.
    await history.recipes('/elsewhere')
    history.invalidate()
    await history.recipes('/elsewhere')
    expect(reads).toEqual(['/videos', '/videos', '/elsewhere', '/elsewhere'])
  })
})
