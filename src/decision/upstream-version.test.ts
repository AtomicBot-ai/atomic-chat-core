import { describe, expect, it } from 'vitest'
import {
  meetsUpstreamBuild,
  UPSTREAM_CLEF_MIN_BUILD,
  UPSTREAM_CLEF_VISION_MIN_BUILD,
  UPSTREAM_DECISION_MIN_BUILD,
  upstreamBuildOf,
  upstreamMinBuild,
} from './upstream-version.js'

describe('upstreamMinBuild', () => {
  it.each([
    ['laya', false, UPSTREAM_DECISION_MIN_BUILD],
    ['openjev', true, UPSTREAM_DECISION_MIN_BUILD],
    ['nimble', false, UPSTREAM_DECISION_MIN_BUILD],
    ['clef', false, UPSTREAM_CLEF_MIN_BUILD],
    ['clef', true, UPSTREAM_CLEF_VISION_MIN_BUILD],
    // A type a newer build added: the first build is the only floor the core knows.
    ['someday', false, UPSTREAM_DECISION_MIN_BUILD],
    [undefined, false, UPSTREAM_DECISION_MIN_BUILD],
  ])('%s (vision %s) → b%i', (type, vision, floor) => expect(upstreamMinBuild(type, vision)).toBe(floor))

  it('pins the floors to the upstream merges', () => {
    expect([UPSTREAM_DECISION_MIN_BUILD, UPSTREAM_CLEF_MIN_BUILD, UPSTREAM_CLEF_VISION_MIN_BUILD]).toEqual([
      11370, 11371, 11418,
    ])
  })
})

describe('upstreamBuildOf / meetsUpstreamBuild', () => {
  it('reads a plain release tag and nothing else', () => {
    expect(upstreamBuildOf('b11436')).toBe(11436)
    expect(upstreamBuildOf(' b11370 ')).toBe(11370)
    expect(upstreamBuildOf('b10269-1.7.0')).toBeUndefined()
    expect(upstreamBuildOf('prism-b10754-2459f68')).toBeUndefined()
    expect(upstreamBuildOf('latest')).toBeUndefined()
  })

  it('compares the build with the floor, unknown for a tag without one', () => {
    expect(meetsUpstreamBuild('b11370', 11370)).toBe(true)
    expect(meetsUpstreamBuild('b11436', 11418)).toBe(true)
    expect(meetsUpstreamBuild('b11344', 11370)).toBe(false)
    expect(meetsUpstreamBuild('b10269-1.7.0', 11370)).toBeUndefined()
  })
})
