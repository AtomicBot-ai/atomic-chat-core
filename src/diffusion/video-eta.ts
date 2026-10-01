/**
 * The live progress of a clip: how long the whole job has left (encoding, the remaining steps and
 * the VAE decode), a fraction that never goes back, the decode's tiles, and whether the steps or the
 * tiles slowed down sharply (the sign of swapping or a stalled engine). One per job, fed the
 * tracker's snapshot and the decode's tile pass at every emit; it keeps the step and tile marks, the
 * phase it saw last, the fraction it reported and the sticky slowdown flag. Pure over the times it
 * is given. The rules are the `video-generation/progress` spec of the `add-video-generation-estimate`
 * change, ADR 2026-09-29-report-the-tiled-decode-and-tile-it-by-memory for the decode, and ADR
 * 2026-09-30-keep-the-video-eta-past-its-forecast for a job that outruns its forecast.
 */

import type { ImageJobPhase, ImageJobProgress, VideoJobProgress } from '../contracts/index.js'
import type { DecodeTiles } from './tracker.js'
import type { VideoForecast } from './video-estimate.js'

/**
 * The step-time ratio (measured against forecast) the decode forecast is scaled by stays in here. Steps
 * faster than forecast never shrink the decode: its own error runs the other way (ADR
 * 2026-09-30-keep-the-video-eta-past-its-forecast), and a history multiplier raised by slow decodes
 * would otherwise be divided back out of it.
 */
export const STEP_RATIO_RANGE: readonly [number, number] = [1, 20]
/** Past its forecast, a stretch of the job is forecast at this many times as long, again and again. */
export const OVERRUN_GROWTH = 2
/** Slowdown: the running step (or decode tile) took this many medians of the completed ones… */
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

/**
 * Seconds left of a stretch forecast at `forecast` seconds that has run for `spent`: the forecast's
 * rest, and once that is spent, the rest of the forecast grown by `OVERRUN_GROWTH` until it is ahead
 * again, so the countdown starts over instead of going blank. Null without a forecast.
 */
export function leftOf(forecast: number, spent: number): number | null {
  if (!(forecast > 0)) return null
  let horizon = forecast
  while (horizon <= spent) horizon *= OVERRUN_GROWTH
  return horizon - spent
}

/** The duration (ms) of every unit completed after the first mark, one entry per unit. */
function completedAfter(marks: readonly Mark[]): number[] {
  const out: number[] = []
  for (let i = 1; i < marks.length; i++) {
    const prev = marks[i - 1] as Mark
    const mark = marks[i] as Mark
    const units = mark.step - prev.step
    for (let u = 0; u < units; u++) out.push((mark.at - prev.at) / units)
  }
  return out
}

export class VideoEta {
  private marks: Mark[] = []
  /** The decode's tile pass: its start (`step: 0`) and each tile finished (`step` = tiles done). */
  private tileMarks: Mark[] = []
  private tileTotal: number | undefined
  private phase: ImageJobPhase | undefined
  private phaseAt = 0
  private reported = 0
  private slow = false

  constructor(private readonly options: VideoEtaOptions) {}

  /** The wire progress for `snapshot` at `now` (ms), with the decode's tile pass when there is one. */
  progress(snapshot: ImageJobProgress, now: number, decodeTiles?: DecodeTiles): VideoJobProgress {
    this.observe(snapshot, now)
    this.observeTiles(decodeTiles, now)
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
      ...(decodeTiles ? { decodeTiles: { done: decodeTiles.done, total: decodeTiles.total } } : {}),
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

  /**
   * Record the decode's tile pass: its start the first time it is seen, then every tile finished. A
   * new pass (sd.cpp retrying a failed decode, or a later attempt's decode) starts over, and no pass
   * (another phase, a decode in one graph) forgets the last one.
   */
  private observeTiles(tiles: DecodeTiles | undefined, now: number): void {
    if (!tiles) {
      this.tileMarks = []
      this.tileTotal = undefined
      return
    }
    const last = this.tileMarks[this.tileMarks.length - 1]
    if (last === undefined || tiles.total !== this.tileTotal || tiles.done < last.step) {
      this.tileTotal = tiles.total
      this.tileMarks = [{ step: 0, at: now }]
    }
    const latest = this.tileMarks[this.tileMarks.length - 1] as Mark
    if (tiles.done > latest.step) this.tileMarks.push({ step: tiles.done, at: now })
  }

  /**
   * The rest of a tiled decode at the measured pace per tile: the running tile's remainder and the
   * tiles after it; a tile running past the pace stretches the pace, as a step does. Zero once every
   * tile is done (the clip is being assembled and encoded); undefined before a tile finished.
   */
  private tileEta(now: number): number | undefined {
    const first = this.tileMarks[0]
    const last = this.tileMarks[this.tileMarks.length - 1]
    const total = this.tileTotal
    if (first === undefined || last === undefined || total === undefined) return undefined
    if (last.step <= first.step || last.at <= first.at) return undefined
    if (last.step >= total) return 0
    const pace = (last.at - first.at) / 1000 / (last.step - first.step)
    const inTile = (now - last.at) / 1000
    const after = Math.max(total - last.step - 1, 0)
    if (inTile <= pace) return pace - inTile + after * pace
    return after * ((now - first.at) / 1000 / (last.step - first.step + 1))
  }

  /** Seconds per step since the first mark; undefined before two marks. */
  private measuredStep(): number | undefined {
    const first = this.marks[0]
    const last = this.marks[this.marks.length - 1]
    if (first === undefined || last === undefined || last.step <= first.step) return undefined
    return (last.at - first.at) / 1000 / (last.step - first.step)
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
        const tiles = this.tileEta(now)
        if (tiles !== undefined) return tiles > 0 ? tiles : null
        if (!forecast) return null
        return leftOf(forecast.decodeSeconds * this.ratio(measured), (now - this.phaseAt) / 1000)
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
    return leftOf(forecast.totalSeconds, elapsedMs / 1000)
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
    if (this.tileStalled(snapshot, now)) return true
    const completed = completedAfter(this.marks)
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

  /**
   * A tile of the decode running past three medians of the finished ones (at least two) and past the
   * floor. Tiles have no forecast of their own to hold them against.
   */
  private tileStalled(snapshot: ImageJobProgress, now: number): boolean {
    const last = this.tileMarks[this.tileMarks.length - 1]
    if (snapshot.phase !== 'decoding' || last === undefined || this.tileTotal === undefined) return false
    if (last.step >= this.tileTotal) return false
    const completed = completedAfter(this.tileMarks)
    const running = now - last.at
    return (
      completed.length >= 2 && running > SLOWDOWN_MEDIANS * median(completed) && running > SLOWDOWN_FLOOR_MS
    )
  }
}
