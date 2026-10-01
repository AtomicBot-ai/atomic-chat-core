import { describe, expect, it } from 'vitest'
import {
  MAX_RESTARTS,
  nextRestartCount,
  restartDelayMs,
  RESTART_MAX_DELAY_MS,
  shouldGiveUp,
  STABLE_RUN_MS,
} from './backoff.js'

describe('restartDelayMs', () => {
  it.each([
    [1, 1_000],
    [2, 2_000],
    [3, 4_000],
    [5, 16_000],
    [6, 30_000],
    [40, 30_000],
    [0, 1_000],
  ])('attempt %i waits %i ms', (attempt, delay) => {
    expect(restartDelayMs(attempt)).toBe(delay)
  })

  it('never exceeds the cap, whatever the base', () => {
    expect(restartDelayMs(3, 20_000)).toBe(RESTART_MAX_DELAY_MS)
    expect(restartDelayMs(2, 10, 15)).toBe(15)
  })
})

describe('nextRestartCount', () => {
  it('counts consecutive crashes', () => {
    expect(nextRestartCount(0, 100)).toBe(1)
    expect(nextRestartCount(3, 100)).toBe(4)
  })

  it('starts over after a process that ran long enough to count as healthy', () => {
    expect(nextRestartCount(4, STABLE_RUN_MS)).toBe(1)
    expect(nextRestartCount(4, STABLE_RUN_MS - 1)).toBe(5)
  })
})

describe('shouldGiveUp', () => {
  it('gives up only past MAX_RESTARTS', () => {
    expect(shouldGiveUp(MAX_RESTARTS)).toBe(false)
    expect(shouldGiveUp(MAX_RESTARTS + 1)).toBe(true)
    expect(shouldGiveUp(2, 1)).toBe(true)
  })
})
