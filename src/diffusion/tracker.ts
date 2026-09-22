/**
 * A job's progress, read from what the server prints. `sampled_steps` and `ProgressTracker` in
 * `jobs.rs` of `tauri-plugin-atomic-diffusion` (app commit `767ff6350`).
 */

import type { ImageGenerateRequest, ImageJobPhase, ImageJobProgress } from '../contracts/index.js'
import { isProgressRedraw, parseStepLine, parseTileAnnouncement } from './progress.js'
import { defaultStrength, usesInitImage, workflowOf } from './workflow.js'

/**
 * The step count sd.cpp's sampler reports for `request`. With an init image and a strength below 1
 * the sampler enters the schedule part-way: `t_enc = ⌊steps × strength⌋` (one fewer when that is all
 * of them), and it walks `t_enc + 1` sigmas. Twenty steps at 0.35 print `k/8`, which a tracker
 * waiting for `k/20` would never trust. The product is taken in f32, the way sd.cpp multiplies it:
 * in f64, 20 × 0.35 lands just under 7.
 */
export function sampledSteps(request: ImageGenerateRequest): number {
  const steps = Math.max(request.steps, 1)
  const workflow = workflowOf(request)
  if (!usesInitImage(workflow) || request.initImage === undefined) return steps
  const strength = request.strength ?? defaultStrength(workflow)
  if (strength >= 1.0) return steps
  let encoded = Math.max(Math.trunc(Math.fround(Math.fround(steps) * Math.fround(strength))), 0)
  if (encoded === steps) encoded -= 1
  return encoded + 1
}

/** Non-progress lines a job keeps for its own failure report. */
export const JOB_LOG_LINES = 60

export class ProgressTracker {
  private readonly steps: number
  private readonly batch: number
  private batchIndex = 0
  private step = 0
  private current: ImageJobPhase = 'queued'
  private readonly startedAt: number
  private firstStepAt: number | undefined
  private firstStepDone = 0
  private dirty = true
  /** Tiles left in an announced VAE pass; its bar is not the sampler's. */
  private tiles: number | undefined
  /** What the server said during this job, progress redraws aside. */
  private readonly log: string[] = []

  constructor(
    steps: number,
    batch: number,
    private readonly now: () => number = Date.now
  ) {
    this.steps = Math.max(steps, 1)
    this.batch = Math.max(batch, 1)
    this.startedAt = now()
  }

  get phase(): ImageJobPhase {
    return this.current
  }

  logLines(): string[] {
    return [...this.log]
  }

  setPhase(phase: ImageJobPhase): void {
    if (this.current === phase) return
    this.current = phase
    this.dirty = true
  }

  /**
   * Feed one output line. Only a denominator equal to the sampled step count is trusted, so a
   * loader's `1/100` cannot move the bar; and an announced tile pass is skipped whole, because nine
   * tiles at nine steps would otherwise finish the bar before sampling began.
   */
  onLine(line: string): void {
    const announced = parseTileAnnouncement(line)
    if (announced !== undefined) this.tiles = announced
    // The sampling banner ends a tile pass whose last redraw was lost.
    else if (line.includes('generating image:')) this.tiles = undefined
    if (!isProgressRedraw(line)) {
      if (this.log.length === JOB_LOG_LINES) this.log.shift()
      this.log.push(line)
    }
    const parsed = parseStepLine(line)
    if (!parsed) return
    const [step, total] = parsed
    if (this.tiles === total) {
      if (step >= total) this.tiles = undefined
      return
    }
    if (total !== this.steps || step === 0 || step > total) return
    if (step < this.step && this.batchIndex + 1 < this.batch) this.batchIndex += 1
    // A wrap past the last image: a later phase reusing the count.
    else if (step < this.step) return
    if (step === this.step && this.current === 'sampling') return
    this.step = step
    this.current = 'sampling'
    if (this.firstStepAt === undefined) {
      this.firstStepAt = this.now()
      this.firstStepDone = this.done()
    }
    if (this.step === this.steps && this.batchIndex + 1 === this.batch) this.current = 'decoding'
    this.dirty = true
  }

  private done(): number {
    return this.batchIndex * this.steps + this.step
  }

  snapshot(): ImageJobProgress {
    const total = this.batch * this.steps
    const done = this.done()
    const now = this.now()
    let etaSeconds: number | null = null
    if (this.firstStepAt !== undefined && this.current === 'sampling' && done > this.firstStepDone) {
      const perStep = (now - this.firstStepAt) / 1000 / (done - this.firstStepDone)
      etaSeconds = perStep * Math.max(total - done, 0)
    }
    return {
      phase: this.current,
      step: this.step,
      totalSteps: this.steps,
      fraction: this.fraction(done, total),
      etaSeconds,
      batchIndex: this.batchIndex,
      batchSize: this.batch,
      elapsedMs: Math.max(now - this.startedAt, 0),
    }
  }

  private fraction(done: number, total: number): number {
    switch (this.current) {
      case 'queued':
        return 0.0
      case 'encoding':
        return 0.02
      case 'sampling':
        return Math.min(Math.max(done / total, 0.0), 0.97)
      // `postprocessing` is never set here; the app's union has it for a pass after decoding.
      case 'decoding':
      case 'postprocessing':
        return 0.98
      case 'saving':
        return 0.99
    }
  }

  /** Whether anything changed since the last call; the runner emits progress only when it did. */
  takeDirty(): boolean {
    const was = this.dirty
    this.dirty = false
    return was
  }
}
