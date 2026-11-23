import { describe, expect, it } from 'vitest'
import {
  CALIBRATION_MAX_RATIO,
  CALIBRATION_MIN_RATIO,
  MIN_CALIBRATION_ESTIMATE,
  PromptCalibration,
  UNCALIBRATED_MARGIN,
  calibrationKey,
  calibrationRatio,
} from './calibration.js'
import type { CompactionTarget } from './engine.js'

const mlx = (over: Partial<CompactionTarget> = {}): CompactionTarget => ({
  provider: 'mlx',
  modelId: 'm',
  port: 5000,
  apiKey: '',
  ...over,
})

describe('calibrationRatio', () => {
  it.each([
    [1000, 1200, 1.2],
    [1000, 100, CALIBRATION_MIN_RATIO],
    [1000, 9000, CALIBRATION_MAX_RATIO],
    // Too small to teach anything, or nothing reported (Foundation Models answers 0).
    [MIN_CALIBRATION_ESTIMATE - 1, 500, undefined],
    [1000, 0, undefined],
    [1000, Number.NaN, undefined],
  ])('estimate %i, observed %i → %s', (estimate, observed, expected) => {
    expect(calibrationRatio(estimate, observed)).toBe(expected)
  })
})

describe('calibrationKey', () => {
  it('tells a reloaded session from the one before it', () => {
    expect(calibrationKey(mlx())).not.toBe(calibrationKey(mlx({ generation: 'g2' })))
    expect(calibrationKey(mlx())).not.toBe(calibrationKey(mlx({ port: 5001 })))
    expect(calibrationKey(mlx())).toBe(calibrationKey(mlx()))
  })
})

describe('PromptCalibration', () => {
  it('scales by the last ratio learned, and by the margin before any', () => {
    const calibration = new PromptCalibration()
    expect(calibration.ratio(mlx())).toBeUndefined()
    expect(calibration.scale(mlx(), 1000)).toBe(Math.ceil(1000 * UNCALIBRATED_MARGIN))
    calibration.learn(mlx(), 1000, 1500)
    expect(calibration.scale(mlx(), 1000)).toBe(1500)
    calibration.learn(mlx(), 1000, 800)
    expect(calibration.ratio(mlx())).toBe(0.8)
    // A pair that teaches nothing leaves the ratio as it was.
    calibration.learn(mlx(), 10, 50)
    expect(calibration.ratio(mlx())).toBe(0.8)
  })

  it('forgets the session it heard from least recently once full', () => {
    const calibration = new PromptCalibration(2)
    calibration.learn(mlx({ port: 1 }), 1000, 1100)
    calibration.learn(mlx({ port: 2 }), 1000, 1200)
    calibration.learn(mlx({ port: 1 }), 1000, 1300)
    calibration.learn(mlx({ port: 3 }), 1000, 1400)
    expect(calibration.ratio(mlx({ port: 2 }))).toBeUndefined()
    expect(calibration.ratio(mlx({ port: 1 }))).toBe(1.3)
    expect(calibration.ratio(mlx({ port: 3 }))).toBe(1.4)
  })
})
