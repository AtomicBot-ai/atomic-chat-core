import { describe, expect, it } from 'vitest'
import {
  compareSemver,
  DECISION_MIN_FORK_VERSION,
  formatSemver,
  meetsForkVersion,
  parseForkSemver,
} from './engine-version.js'

describe('parseForkSemver', () => {
  it.each([
    ['b10269-1.7.0', [1, 7, 0]],
    ['b10018-1.3.0', [1, 3, 0]],
    [' b10269-1.10.2 ', [1, 10, 2]],
    ['1.7.0', [1, 7, 0]],
    ['v2.0.1', [2, 0, 1]],
  ])('reads %j', (tag, expected) => {
    expect(parseForkSemver(tag)).toEqual(expected)
  })

  it.each(['b6325', 'turboquant-macos-arm64-abc123', '1.7', 'b10269-1.7', 'b10269-1.7.0-rc1', 'latest', ''])(
    'has no semver in %j',
    (tag) => {
      expect(parseForkSemver(tag)).toBeUndefined()
    }
  )
})

describe('compareSemver', () => {
  it.each([
    [[1, 7, 0], [1, 7, 0], 0],
    [[1, 10, 0], [1, 9, 9], 1],
    [[1, 6, 9], [1, 7, 0], -1],
    [[2, 0, 0], [1, 99, 99], 1],
    [[1, 7, 1], [1, 7, 0], 1],
  ] as const)('%j vs %j is %i', (a, b, expected) => {
    expect(compareSemver(a, b)).toBe(expected)
  })

  it('formats back to x.y.z', () => {
    expect(formatSemver([1, 7, 0])).toBe('1.7.0')
  })
})

describe('meetsForkVersion', () => {
  it('pins the decision floor at the first release with the decision role', () => {
    expect(DECISION_MIN_FORK_VERSION).toBe('1.7.0')
  })

  it.each([
    ['b10269-1.7.0', true],
    ['b10400-1.8.0', true],
    ['b10269-1.10.0', true],
    ['b10269-1.6.9', false],
    // A dev build keeps the branch's old number; only the probe can clear it.
    ['b10269-1.5.1', false],
    ['turboquant-macos-arm64-abc123', undefined],
    ['b6325', undefined],
  ])('%j → %j', (tag, expected) => {
    expect(meetsForkVersion(tag)).toBe(expected)
  })

  it('takes another floor, and an unreadable floor answers unknown', () => {
    expect(meetsForkVersion('b1-1.8.0', '1.8.0')).toBe(true)
    expect(meetsForkVersion('b1-1.7.9', '1.8.0')).toBe(false)
    expect(meetsForkVersion('b1-1.8.0', 'soon')).toBeUndefined()
  })
})
