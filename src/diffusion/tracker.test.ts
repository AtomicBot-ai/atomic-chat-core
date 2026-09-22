/**
 * Hand-ported from the tracker tests of `jobs.rs` in `tauri-plugin-atomic-diffusion` (app commit
 * `767ff6350`): `progress_tracks_batches_phases_and_eta`,
 * `img2img_is_tracked_by_the_steps_sd_cpp_actually_samples`,
 * `a_tiled_vae_pass_is_not_mistaken_for_sampling`,
 * `a_job_remembers_what_the_server_said_but_not_its_redraws`.
 */
import { describe, expect, it } from 'vitest'
import type { ImageGenerateRequest } from '../contracts/index.js'
import { JOB_LOG_LINES, ProgressTracker, sampledSteps } from './tracker.js'

function request(overrides: Partial<ImageGenerateRequest> = {}): ImageGenerateRequest {
  return {
    prompt: 'a cat',
    width: 512,
    height: 512,
    steps: 4,
    cfgScale: 1.0,
    seed: 1234,
    batchSize: 2,
    ...overrides,
  }
}

describe('ProgressTracker', () => {
  it('tracks batches, phases and the ETA', () => {
    let clock = 1_000
    const t = new ProgressTracker(4, 2, () => clock)
    expect(t.takeDirty()).toBe(true)
    expect(t.takeDirty()).toBe(false)
    expect(t.phase).toBe('queued')
    t.setPhase('encoding')
    expect(t.phase).toBe('encoding')
    expect(t.takeDirty()).toBe(true)
    t.setPhase('encoding')
    expect(t.takeDirty()).toBe(false)
    expect(t.snapshot().fraction).toBe(0.02)
    t.onLine('loading 1/100')
    expect(t.snapshot().step, 'foreign denominators are ignored').toBe(0)
    expect(t.takeDirty()).toBe(false)

    t.onLine('|=>   | 1/4 - 1.0s/it')
    clock += 2_000
    t.onLine('|==>  | 2/4 - 1.0s/it')
    let p = t.snapshot()
    expect([p.step, p.totalSteps, p.batchIndex, p.batchSize]).toEqual([2, 4, 0, 2])
    expect(p.phase).toBe('sampling')
    expect(p.fraction).toBeCloseTo(0.25, 9)
    // One step measured in two seconds, six to go.
    expect(p.etaSeconds).toBeCloseTo(12, 9)
    expect(p.elapsedMs).toBe(2_000)
    expect(t.takeDirty()).toBe(true)
    // The same step again is not news.
    t.onLine('|==>  | 2/4 - 1.0s/it')
    expect(t.takeDirty()).toBe(false)

    t.onLine('4/4')
    t.onLine('1/4')
    p = t.snapshot()
    expect([p.step, p.batchIndex]).toEqual([1, 1])
    expect(p.fraction).toBeCloseTo(0.625, 9)
    t.onLine('4/4')
    expect(t.snapshot().phase).toBe('decoding')
    expect(t.snapshot().fraction).toBeCloseTo(0.98, 9)
    expect(t.snapshot().etaSeconds).toBeNull()
    // A later phase reusing the count does not roll the batch over.
    t.onLine('1/4')
    expect(t.snapshot().batchIndex).toBe(1)
    t.setPhase('saving')
    expect(t.snapshot().fraction).toBe(0.99)
  })

  it('reports no ETA before a second step has been measured, and never claims to be done while sampling', () => {
    const t = new ProgressTracker(2, 1, () => 0)
    expect(t.snapshot()).toEqual({
      phase: 'queued',
      step: 0,
      totalSteps: 2,
      fraction: 0,
      etaSeconds: null,
      batchIndex: 0,
      batchSize: 1,
      elapsedMs: 0,
    })
    t.onLine('1/2')
    expect(t.snapshot().etaSeconds).toBeNull()
    expect(t.snapshot().fraction).toBe(0.5)
    // Out-of-range pairs are not steps.
    t.onLine('0/2')
    t.onLine('3/2')
    expect(t.snapshot().step).toBe(1)

    const batch = new ProgressTracker(100, 2, () => 0)
    batch.onLine('100/100')
    batch.onLine('99/100')
    expect(batch.snapshot().phase).toBe('sampling')
    expect(batch.snapshot().fraction).toBe(0.97)
  })

  it('clamps a zero step count and batch to one', () => {
    const p = new ProgressTracker(0, 0, () => 0).snapshot()
    expect([p.totalSteps, p.batchSize]).toEqual([1, 1])
  })

  it('does not mistake a tiled VAE pass for sampling', () => {
    // Nine tiles, nine sampled steps: the worst case, a 2x Upscale of a 1024² image at strength 0.4.
    let t = new ProgressTracker(9, 1)
    t.setPhase('encoding')
    t.onLine('[VERBOSE] tiling.cpp:203  - processing 9 tiles')
    for (let tile = 1; tile <= 9; tile++) t.onLine(`|==>   | ${tile}/9 - 1.30s/it`)
    expect(t.snapshot().phase, 'encode tiles').toBe('encoding')
    expect(t.snapshot().step).toBe(0)

    t.onLine('[INFO   ] stable-diffusion.cpp:5705 - generating image: 1/1 - seed 1')
    t.onLine('|==>   | 1/9 - 12.0s/it')
    expect(t.snapshot().phase).toBe('sampling')
    expect(t.snapshot().step).toBe(1)
    for (let step = 2; step <= 9; step++) t.onLine(`|==>   | ${step}/9 - 12.0s/it`)
    expect(t.snapshot().phase).toBe('decoding')

    // Decode tiles after the last step change nothing either.
    t.onLine('[VERBOSE] tiling.cpp:203  - processing 9 tiles')
    t.onLine('|==>   | 1/9 - 1.41it/s')
    expect(t.snapshot().phase).toBe('decoding')
    expect(t.snapshot().step).toBe(9)

    // A lost last redraw does not swallow the sampling that follows.
    t = new ProgressTracker(9, 1)
    t.onLine('processing 9 tiles')
    t.onLine('|==>   | 8/9 - 1.30s/it')
    t.onLine('[INFO   ] stable-diffusion.cpp:5705 - generating image: 1/1 - seed 1')
    t.onLine('|==>   | 1/9 - 12.0s/it')
    expect(t.snapshot().step).toBe(1)
  })

  it('remembers what the server said, but not its redraws', () => {
    const t = new ProgressTracker(8, 1)
    t.onLine('|==>   | 1/8 - 12.0s/it')
    t.onLine('  |####  | 108/251 - 637.50MB/s')
    t.onLine(
      'ggml_backend_cuda_buffer_type_alloc_buffer: allocating 13576.00 MiB on device 0: cudaMalloc failed: out of memory'
    )
    // An error that happens to carry an `N/M` is still kept.
    t.onLine('[ERROR] stable-diffusion.cpp:5743 - sampling for image 1/1 failed after 0.31s')
    const log = t.logLines()
    expect(log).toHaveLength(2)
    expect(log[0]).toContain('cudaMalloc failed')
    expect(log[1]).toContain('sampling for image 1/1 failed')

    for (let i = 0; i < JOB_LOG_LINES + 5; i++) t.onLine(`line ${i}`)
    expect(t.logLines(), 'bounded').toHaveLength(JOB_LOG_LINES)
    expect(t.logLines().at(-1)).toBe(`line ${JOB_LOG_LINES + 4}`)
  })
})

describe('sampledSteps', () => {
  const upscale = (steps: number, strength?: number) =>
    sampledSteps(
      request({
        steps,
        workflow: 'upscale',
        initImage: { base64: 'AAAA' },
        ...(strength === undefined ? {} : { strength }),
      })
    )

  it('follows the steps sd.cpp actually samples for img2img', () => {
    // Observed on the pinned build: 4 steps at 0.5 print `k/3`.
    expect(upscale(4, 0.5)).toBe(3)
    // The Upscale default: 20 steps at 0.35 print `k/8` (in f64 the product is 6.99… and this is 7).
    expect(upscale(20)).toBe(8)
    expect(upscale(20, 0.0)).toBe(1)
    expect(upscale(20, 0.999)).toBe(20)
    // A full-strength repaint (Extend's default) walks the whole schedule.
    expect(upscale(20, 1.0)).toBe(20)
    expect(sampledSteps(request({ steps: 20, workflow: 'extend', initImage: { base64: 'AAAA' } }))).toBe(20)
  })

  it('takes no shortcut without an init image', () => {
    expect(sampledSteps(request({ steps: 20, strength: 0.35 }))).toBe(20)
    expect(sampledSteps(request({ steps: 20, strength: 0.35, workflow: 'edit' }))).toBe(20)
    expect(sampledSteps(request({ steps: 20, strength: 0.35, workflow: 'upscale' }))).toBe(20)
    expect(sampledSteps(request({ steps: 0 }))).toBe(1)
  })

  it('moves the bar on the lines that build really prints', () => {
    const t = new ProgressTracker(upscale(20), 1)
    t.onLine('|=====>    | 3/8 - 12.13s/it')
    expect([t.snapshot().step, t.snapshot().totalSteps]).toEqual([3, 8])
    expect(t.snapshot().phase).toBe('sampling')
  })
})
