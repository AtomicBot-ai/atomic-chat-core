import { describe, expect, it } from 'vitest'
import type { ImageJobPhase, ImageJobProgress } from '../contracts/index.js'
import type { VideoForecast } from './video-estimate.js'
import { MAX_FRACTION, SLOWDOWN_FLOOR_MS, VideoEta } from './video-eta.js'

/** A forecast whose middle is 600 s: 10 s encoding, eight 60 s steps, 110 s decoding. */
const FORECAST: VideoForecast = {
  encodeSeconds: 10,
  stepSeconds: 60,
  stepSecondsHigh: 120,
  decodeSeconds: 110,
  totalSeconds: 600,
}

/** The tracker's snapshot at a phase and step; its own fraction is the phase-based one. */
function snap(phase: ImageJobPhase, step = 0, totalSteps = 8): ImageJobProgress {
  const fraction = {
    queued: 0,
    encoding: 0.02,
    sampling: step / totalSteps,
    decoding: 0.98,
    postprocessing: 0.98,
    saving: 0.99,
  }[phase]
  return { phase, step, totalSteps, fraction, etaSeconds: null, batchIndex: 0, batchSize: 1, elapsedMs: 0 }
}

const S = 1000

describe('the ETA before the first measured step', () => {
  it('is the estimate’s middle less the time spent', () => {
    const eta = new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true })
    const p = eta.progress(snap('encoding'), 30 * S)
    expect(p.etaSeconds).toBeCloseTo(570, 9)
    expect(p.elapsedMs).toBe(30 * S)
    // One step mark is not a measurement yet.
    expect(eta.progress(snap('sampling', 1), 100 * S).etaSeconds).toBeCloseTo(500, 9)
  })

  it('is null without seconds in the estimate, without an estimate, or past the estimate', () => {
    expect(
      new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: false }).progress(snap('encoding'), S)
        .etaSeconds
    ).toBeNull()
    expect(new VideoEta({ startedAt: 0, estimated: false }).progress(snap('queued'), S).etaSeconds).toBeNull()
    expect(
      new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true }).progress(snap('encoding'), 700 * S)
        .etaSeconds
    ).toBeNull()
  })
})

describe('the ETA while sampling', () => {
  it('counts the remaining steps at the measured pace and the decode scaled by it', () => {
    const eta = new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true })
    eta.progress(snap('sampling', 1), 70 * S)
    // Steps at 30 s, half the forecast: the decode shrinks by the same ratio.
    const p = eta.progress(snap('sampling', 2), 100 * S)
    expect(p.etaSeconds).toBeCloseTo(30 + 5 * 30 + 110 * 0.5, 9)
    // Ten seconds into the next step, the countdown moves on.
    expect(eta.progress(snap('sampling', 2), 110 * S).etaSeconds).toBeCloseTo(20 + 5 * 30 + 55, 9)
  })

  it('stretches the pace when a step runs past it, instead of freezing', () => {
    const eta = new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true })
    eta.progress(snap('sampling', 1), 70 * S)
    eta.progress(snap('sampling', 2), 100 * S)
    const late = eta.progress(snap('sampling', 2), 160 * S).etaSeconds as number
    const later = eta.progress(snap('sampling', 2), 220 * S).etaSeconds as number
    expect(later).toBeGreaterThan(late)
  })

  it('falls back to sampling alone without a forecast', () => {
    const eta = new VideoEta({ startedAt: 0, estimated: false })
    eta.progress(snap('sampling', 1), 10 * S)
    expect(eta.progress(snap('sampling', 2), 20 * S).etaSeconds).toBeCloseTo(10 + 5 * 10, 9)
  })

  it('starts over when a new attempt counts from the first step again', () => {
    const eta = new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true })
    eta.progress(snap('sampling', 1), 10 * S)
    eta.progress(snap('sampling', 2), 20 * S)
    eta.progress(snap('queued'), 30 * S)
    // The CPU retry: one mark again, so the estimate speaks until a second one.
    expect(eta.progress(snap('sampling', 1), 400 * S).etaSeconds).toBeCloseTo(200, 9)
  })
})

describe('the ETA while decoding and saving', () => {
  it('includes the decode, counts it down, and is null once the forecast is spent', () => {
    const eta = new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true })
    for (let step = 1; step <= 7; step++) eta.progress(snap('sampling', step), (10 + step * 60) * S)
    const start = eta.progress(snap('decoding', 8), 490 * S)
    expect(start.etaSeconds).toBeGreaterThan(0)
    expect(start.etaSeconds).toBeLessThanOrEqual(110)
    expect(eta.progress(snap('decoding', 8), 550 * S).etaSeconds).toBeCloseTo(50, 9)
    expect(eta.progress(snap('decoding', 8), 601 * S).etaSeconds).toBeNull()
    expect(eta.progress(snap('saving', 8), 602 * S).etaSeconds).toBeNull()
  })

  it('has no decode forecast without an estimate', () => {
    const eta = new VideoEta({ startedAt: 0, estimated: false })
    expect(eta.progress(snap('decoding', 8), S).etaSeconds).toBeNull()
  })
})

describe('the fraction', () => {
  it('follows the time when the ETA is known, so a long decode does not park the bar at 0.98', () => {
    // Sampling took five minutes; the decode forecast is five minutes at the measured pace.
    const forecast: VideoForecast = { ...FORECAST, encodeSeconds: 0, stepSeconds: 30, decodeSeconds: 300 }
    const eta = new VideoEta({ startedAt: 0, forecast, estimated: true })
    for (let step = 1; step <= 9; step++) eta.progress(snap('sampling', step, 10), step * 30 * S)
    const decoding = eta.progress(snap('decoding', 10, 10), 300 * S)
    expect(decoding.fraction).toBeCloseTo(0.5, 2)
  })

  it('never goes back, and stays below 1', () => {
    const eta = new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true })
    eta.progress(snap('sampling', 1), 70 * S)
    const before = eta.progress(snap('sampling', 2), 80 * S).fraction
    // A slow step makes the ETA grow; the fraction holds.
    const after = eta.progress(snap('sampling', 3), 400 * S).fraction
    expect(after).toBeGreaterThanOrEqual(before)
    const saving = eta.progress(snap('saving', 8), 900 * S)
    expect(saving.fraction).toBe(MAX_FRACTION)
    expect(saving.fraction).toBeLessThan(1)
  })

  it('uses the phases when the ETA is unknown', () => {
    const eta = new VideoEta({ startedAt: 0, estimated: false })
    expect(eta.progress(snap('queued'), S).fraction).toBe(0)
    expect(eta.progress(snap('encoding'), 2 * S).fraction).toBe(0.02)
  })
})

describe('slowdown', () => {
  it('is set when a step runs past three medians and twenty seconds, and stays set', () => {
    const eta = new VideoEta({ startedAt: 0, estimated: false })
    // Three steps ten seconds apart: two measured steps of 10 s.
    for (let step = 1; step <= 3; step++)
      expect(eta.progress(snap('sampling', step), step * 10 * S).slowdown).toBe(false)
    expect(eta.progress(snap('sampling', 3), 55 * S).slowdown, '25 s into the fourth: under 3 medians').toBe(
      false
    )
    expect(eta.progress(snap('sampling', 3), 70 * S).slowdown, '40 s into the fourth').toBe(true)
    // Once set it holds, even when the steps recover.
    expect(eta.progress(snap('sampling', 4), 75 * S).slowdown).toBe(true)
    expect(eta.progress(snap('decoding', 8), 200 * S).slowdown).toBe(true)
  })

  it('needs the twenty-second floor and two measured steps', () => {
    const fast = new VideoEta({ startedAt: 0, estimated: false })
    for (let step = 1; step <= 3; step++) fast.progress(snap('sampling', step), step * S)
    // Ten times the median, but only 10 s.
    expect(fast.progress(snap('sampling', 3), 13 * S).slowdown).toBe(false)
    expect(fast.progress(snap('sampling', 3), 3 * S + SLOWDOWN_FLOOR_MS + 1).slowdown).toBe(true)
    // A long first measured step alone is not enough: one completed step.
    const warm = new VideoEta({ startedAt: 0, estimated: false })
    warm.progress(snap('sampling', 1), 10 * S)
    warm.progress(snap('sampling', 2), 20 * S)
    expect(warm.progress(snap('sampling', 2), 200 * S).slowdown).toBe(false)
  })

  it('is set by a step past three times the forecast’s top', () => {
    const eta = new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true })
    eta.progress(snap('sampling', 1), 70 * S)
    expect(eta.progress(snap('sampling', 1), 70 * S + 360 * S).slowdown).toBe(false)
    expect(eta.progress(snap('sampling', 1), 70 * S + 361 * S).slowdown).toBe(true)
  })

  it('stays false at an even pace within the forecast', () => {
    const eta = new VideoEta({ startedAt: 0, forecast: FORECAST, estimated: true })
    for (let step = 1; step <= 8; step++) {
      expect(eta.progress(snap('sampling', step), (10 + step * 60) * S).slowdown).toBe(false)
      expect(eta.progress(snap('sampling', step), (40 + step * 60) * S).slowdown).toBe(false)
    }
  })
})
