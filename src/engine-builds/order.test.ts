import { describe, expect, it } from 'vitest'
import { compareBuilds, isNewerBuild, sdcppBuildKey } from './order.js'

describe('sdcppBuildKey', () => {
  it.each([
    ['master-883-137f740', [883, 0]],
    ['master-883-137f740-a36f1b1a', [883, 1]],
    ['master-1000-abcdef0', [1000, 0]],
    ['latest', null],
    ['master-x-137f740', null],
    ['master-883', null],
  ] as const)('%s → %j', (tag, key) => {
    expect(sdcppBuildKey(tag)).toEqual(key)
  })
})

describe('compareBuilds for sd.cpp', () => {
  it.each([
    // [a, b, sign of compare(a, b)]
    ['master-900-aaaaaaa', 'master-883-137f740', 1],
    ['master-883-137f740', 'master-900-aaaaaaa', -1],
    ['master-1000-abcdef0', 'master-999-abcdef0', 1],
    ['master-883-137f740-a36f1b1a', 'master-883-137f740', 1],
    ['master-883-137f740', 'master-883-137f740-a36f1b1a', -1],
    ['master-883-137f740', 'master-883-137f740', 0],
    // Two Atomic rebuilds of one tag carry no order between them.
    ['master-883-137f740-a1111111', 'master-883-137f740-a2222222', 0],
    // An unknown order is older than any known one, and equal to another unknown.
    ['dev-build', 'master-1-abcdef0', -1],
    ['master-1-abcdef0', 'dev-build', 1],
    ['dev-build', 'other-dev', 0],
  ] as const)('%s vs %s → %i', (a, b, sign) => {
    expect(Math.sign(compareBuilds('sd-cpp', { tag: a }, { tag: b }))).toBe(sign)
  })
})

describe('compareBuilds for MLX', () => {
  const at = (published_at: string | null, tag = 'mlxvlm-macos-arm64-07ba5a1') => ({ tag, published_at })

  it.each([
    [at('2026-10-02T00:00:00Z'), at('2026-08-28T10:38:38Z'), 1],
    [at('2026-08-28T10:38:38Z'), at('2026-10-02T00:00:00Z'), -1],
    [at('2026-08-28T10:38:38Z', 'mlxvlm-macos-arm64-aaaaaaa'), at('2026-08-28T10:38:38Z'), 0],
    // The tag is a commit hash and says nothing about order.
    [
      at('2026-08-28T10:38:38Z', 'mlxvlm-macos-arm64-0000000'),
      at('2026-08-27T00:00:00Z', 'mlxvlm-macos-arm64-fffffff'),
      1,
    ],
    // A build without a date (a dev stub, an installer without metadata) is older than any dated one.
    [at(null), at('2000-01-01T00:00:00Z'), -1],
    [at('2000-01-01T00:00:00Z'), at(null), 1],
    [at('not a date'), at('2000-01-01T00:00:00Z'), -1],
    [at(null), at(null), 0],
  ] as const)('%j vs %j → %i', (a, b, sign) => {
    expect(Math.sign(compareBuilds('mlx', a, b))).toBe(sign)
  })
})

describe('isNewerBuild', () => {
  it('means strictly newer', () => {
    expect(isNewerBuild('sd-cpp', { tag: 'master-900-aaaaaaa' }, { tag: 'master-883-137f740' })).toBe(true)
    expect(isNewerBuild('sd-cpp', { tag: 'master-883-137f740' }, { tag: 'master-883-137f740' })).toBe(false)
    expect(isNewerBuild('sd-cpp', { tag: 'master-883-137f740' }, { tag: 'master-900-aaaaaaa' })).toBe(false)
    expect(
      isNewerBuild(
        'mlx',
        { tag: 'a', published_at: '2026-10-02T00:00:00Z' },
        { tag: 'b', published_at: null }
      )
    ).toBe(true)
  })
})
