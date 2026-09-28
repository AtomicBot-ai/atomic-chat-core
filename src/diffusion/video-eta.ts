/**
 * The live progress of a clip: how long the whole job has left (encoding, the remaining steps and
 * the VAE decode), a fraction that never goes back, and whether the steps slowed down sharply (the
 * sign of swapping). One per job, fed the tracker's snapshot at every emit; it keeps the step marks,
 * the phase it saw last, the fraction it reported and the sticky slowdown flag. Pure over the
 * times it is given. The rules are the `video-generation/progress` spec of the
 * `add-video-generation-estimate` change.
 */

import type { ImageJobPhase, ImageJobProgress, VideoJobProgress } from '../contracts/index.js'
import type { VideoForecast } from './video-estimate.js'

/** The step-time ratio (measured against forecast) the decode forecast is scaled by stays in here. */
export const STEP_RATIO_RANGE: readonly [number, number] = [0.25, 20]
/** Slowdown: the running step took this many medians of the completed ones… */
export const SLOWDOWN_MEDIANS = 3
/** …and at least this long, so a slow first step (graph build, weights paged in) never trips it. */
export const SLOWDOWN_FLOOR_MS = 20_000
/** Slowdown: a step past this many times the forecast's top of the range. */
export const SLOWDOWN_FORECAST_FACTOR = 3
/** The fraction stays below 1 until the job is over. */
export const MAX_FRACTION = 0.99

export interface VideoEtaOptions {
  /** When the runner started the job; `elapsedMs` counts from here. */
  startedAt: number
  /** The parts of the job's estimate; absent when there is none. */
  forecast?: VideoForecast
  /** Whether the job's estimate has a range of seconds (it has none when memory is exceeded). */
  estimated: boolean
}

interface Mark {
  step: number
  at: number
}

const clamp = (value: number, [min, max]: readonly [number, number]): number =>
  Math.min(Math.max(value, min), max)

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

export class VideoEta {
  private marks: Mark[] = []
  private phase: ImageJobPhase | undefined
  private phaseAt = 0
  private reported = 0
  private slow = false

  constructor(private readonly options: VideoEtaOptions) {}

  /** The wire progress for `snapshot` at `now` (ms). */
  progress(snapshot: ImageJobProgress, now: number): VideoJobProgress {
    this.observe(snapshot, now)
    const elapsedMs = Math.max(now - this.options.startedAt, 0)
    const etaSeconds = this.eta(snapshot, now, elapsedMs)
    this.slow ||= this.slowNow(snapshot, now)
    return {
      phase: snapshot.phase,
      step: snapshot.step,
      totalSteps: snapshot.totalSteps,
      fraction: this.fraction(snapshot, elapsedMs, etaSeconds),
      etaSeconds,
      elapsedMs,
      slowdown: this.slow,
    }
  }

  /** Record a phase change and a new step; a step count that went back is a new attempt. */
  private observe(snapshot: ImageJobProgress, now: number): void {
    if (snapshot.phase !== this.phase) {
      this.phase = snapshot.phase
      this.phaseAt = now
    }
    const last = this.marks[this.marks.length - 1]
    if (last !== undefined && snapshot.step < last.step) this.marks = []
    const latest = this.marks[this.marks.length - 1]
    if (snapshot.step > 0 && (latest === undefined || snapshot.step > latest.step))
      this.marks.push({ step: snapshot.step, at: now })
  }

  /** Seconds per step since the first mark; undefined before two marks. */
  private measuredStep(): number | undefined {
    const first = this.marks[0]
    const last = this.marks[this.marks.length - 1]
    if (first === undefined || last === undefined || last.step <= first.step) return undefined
    return (last.at - first.at) / 1000 / (last.step - first.step)
  }

  /** The duration (ms) of every completed step after the first mark, one entry per step. */
  private completedSteps(): number[] {
    const out: number[] = []
    for (let i = 1; i < this.marks.length; i++) {
      const prev = this.marks[i - 1] as Mark
      const mark = this.marks[i] as Mark
      const steps = mark.step - prev.step
      for (let s = 0; s < steps; s++) out.push((mark.at - prev.at) / steps)
    }
    return out
  }

  /** The measured step against the forecast one, for scaling the decode. */
  private ratio(measured: number | undefined): number {
    const forecast = this.options.forecast
    if (measured === undefined || forecast === undefined || forecast.stepSeconds <= 0) return 1
    return clamp(measured / forecast.stepSeconds, STEP_RATIO_RANGE)
  }

  private eta(snapshot: ImageJobProgress, now: number, elapsedMs: number): number | null {
    const { forecast, estimated } = this.options
    const measured = this.measuredStep()
    switch (snapshot.phase) {
      case 'saving':
        return null
      case 'decoding':
      case 'postprocessing': {
        if (!forecast) return null
        const left = forecast.decodeSeconds * this.ratio(measured) - (now - this.phaseAt) / 1000
        return left > 0 ? left : null
      }
      case 'sampling':
        if (measured !== undefined) return this.samplingEta(snapshot, now, measured)
        break
      case 'queued':
      case 'encoding':
        break
    }
    // Before the first measured step: the estimate's middle, less the time already spent.
    if (!forecast || !estimated) return null
    const left = forecast.totalSeconds - elapsedMs / 1000
    return left > 0 ? left : null
  }

  /**
   * The rest of the running step, the steps after it at the measured pace, and the decode forecast
   * scaled by how the steps compare with theirs. A step running past the pace stretches the pace
   * instead of freezing the countdown.
   */
  private samplingEta(snapshot: ImageJobProgress, now: number, measured: number): number {
    const first = this.marks[0] as Mark
    const last = this.marks[this.marks.length - 1] as Mark
    const inStep = (now - last.at) / 1000
    const after = Math.max(snapshot.totalSteps - last.step - 1, 0)
    let sampling: number
    if (inStep <= measured) sampling = measured - inStep + after * measured
    else sampling = after * ((now - first.at) / 1000 / (last.step - first.step + 1))
    const decode = this.options.forecast ? this.options.forecast.decodeSeconds * this.ratio(measured) : 0
    return sampling + decode
  }

  private fraction(snapshot: ImageJobProgress, elapsedMs: number, etaSeconds: number | null): number {
    const elapsed = elapsedMs / 1000
    const byTime =
      etaSeconds !== null && elapsed + etaSeconds > 0 ? elapsed / (elapsed + etaSeconds) : undefined
    const next = Math.min(Math.max(this.reported, byTime ?? snapshot.fraction), MAX_FRACTION)
    this.reported = next
    return next
  }

  private slowNow(snapshot: ImageJobProgress, now: number): boolean {
    const completed = this.completedSteps()
    const last = this.marks[this.marks.length - 1]
    const running =
      snapshot.phase === 'sampling' && last !== undefined && last.step < snapshot.totalSteps
        ? now - last.at
        : 0
    if (
      completed.length >= 2 &&
      running > SLOWDOWN_MEDIANS * median(completed) &&
      running > SLOWDOWN_FLOOR_MS
    )
      return true
    const forecast = this.options.forecast
    if (!forecast) return false
    const slowest = Math.max(running, ...completed)
    return slowest > SLOWDOWN_FORECAST_FACTOR * forecast.stepSecondsHigh * 1000
  }
}
