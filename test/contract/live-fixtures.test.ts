/**
 * The release-picking rules of `scripts/fetch-live-fixtures.mjs`, which decide what llama.cpp build
 * the live suites run: the platform's CPU asset, the newest release that has it (ggml-org's builds
 * are prereleases and its `latest` carries no binaries), and a digest check on the bytes; and for an
 * engine with several model files (sd.cpp), the live env its config describes and the models' cache key.
 */
import { describe, expect, it } from 'vitest'
import {
  assetPatternFor,
  digestMatches,
  expandLiveEnv,
  liveModelsKey,
  pickRelease,
} from '../../scripts/lib/live-fixtures.mjs'

const names = (tag: string) => [
  `llama-${tag}-bin-macos-arm64.tar.gz`,
  `llama-${tag}-bin-macos-x64.tar.gz`,
  `llama-${tag}-bin-ubuntu-x64.tar.gz`,
  `llama-${tag}-bin-ubuntu-arm64.tar.gz`,
  `llama-${tag}-bin-ubuntu-vulkan-x64.tar.gz`,
  `llama-${tag}-bin-win-cpu-x64.zip`,
  `llama-${tag}-bin-win-cpu-arm64.zip`,
  `llama-${tag}-bin-win-cuda-13.4-x64.zip`,
  `cudart-llama-bin-win-cuda-13.4-x64.zip`,
]

describe('assetPatternFor', () => {
  const cases: Array<[string, string, string]> = [
    ['darwin', 'arm64', 'llama-b11617-bin-macos-arm64.tar.gz'],
    ['darwin', 'x64', 'llama-b11617-bin-macos-x64.tar.gz'],
    ['linux', 'x64', 'llama-b11617-bin-ubuntu-x64.tar.gz'],
    ['linux', 'arm64', 'llama-b11617-bin-ubuntu-arm64.tar.gz'],
    ['win32', 'x64', 'llama-b11617-bin-win-cpu-x64.zip'],
    ['win32', 'arm64', 'llama-b11617-bin-win-cpu-arm64.zip'],
  ]
  it.each(cases)('%s-%s takes exactly its CPU build', (platform, arch, expected) => {
    const pattern = assetPatternFor(platform, arch)
    expect(names('b11617').filter((n) => pattern.test(n))).toEqual([expected])
  })

  it('names the tag when given one, so a fork with its own tags is fetched', () => {
    const tag = 'prism-b10787-73bfe6c'
    const prism = names(tag)
    expect(prism.filter((n) => assetPatternFor('linux', 'x64', undefined, tag).test(n))).toEqual([
      `llama-${tag}-bin-ubuntu-x64.tar.gz`,
    ])
    expect(prism.filter((n) => assetPatternFor('linux', 'x64').test(n))).toEqual([])
    expect(names('b11617').filter((n) => assetPatternFor('win32', 'x64', undefined, tag).test(n))).toEqual([])
  })

  it('takes an exact asset name literally', () => {
    const pattern = assetPatternFor('linux', 'x64', 'llama-b1-bin-ubuntu-x64.tar.gz')
    expect(pattern.test('llama-b1-bin-ubuntu-x64.tar.gz')).toBe(true)
    expect(pattern.test('llama-b1-bin-ubuntu-x64Xtar.gz')).toBe(false)
  })
})

describe('pickRelease', () => {
  const pattern = assetPatternFor('linux', 'x64')
  const release = (tag_name: string, extra: object = {}) => ({
    tag_name,
    prerelease: true,
    assets: names(tag_name).map((name) => ({ name })),
    ...extra,
  })

  it('takes the newest prerelease build, past an asset-less latest release', () => {
    const picked = pickRelease(
      [
        { tag_name: 'v0.6.0', prerelease: false, assets: [{ name: 'nightly-tag.txt' }] },
        release('b11617'),
        release('b11612'),
      ],
      pattern
    )
    expect(picked?.release.tag_name).toBe('b11617')
    expect(picked?.asset.name).toBe('llama-b11617-bin-ubuntu-x64.tar.gz')
  })

  it('skips a release whose platform asset is not uploaded yet', () => {
    const partial = { tag_name: 'b11618', assets: [{ name: 'llama-b11618-bin-macos-arm64.tar.gz' }] }
    expect(pickRelease([partial, release('b11617')], pattern)?.release.tag_name).toBe('b11617')
  })

  it('never takes a draft', () => {
    expect(
      pickRelease([release('b11618', { draft: true }), release('b11617')], pattern)?.release.tag_name
    ).toBe('b11617')
  })

  it('reports nothing when no release has the asset', () => {
    expect(pickRelease([{ tag_name: 'v0.6.0', assets: [] }], pattern)).toBeUndefined()
  })
})

describe('digestMatches', () => {
  const hex = 'bc9c8bd3488e5778137c2289d951af60a94077a6bea51b7e30461033b084e07f'
  it('compares against a sha256 digest, case-insensitively', () => {
    expect(digestMatches(`sha256:${hex}`, hex.toUpperCase())).toBe(true)
    expect(digestMatches(`sha256:${hex}`, '0'.repeat(64))).toBe(false)
  })
  it('is undefined when the release publishes no digest', () => {
    expect(digestMatches(null, hex)).toBeUndefined()
    expect(digestMatches(undefined, hex)).toBeUndefined()
    expect(digestMatches(`md5:${hex}`, hex)).toBeUndefined()
  })
})

describe('the live env of an engine with several files', () => {
  const values = { engine_dir: '/live/engine', tag: 'master-883-137f740', models: { llm: '/m/llm.gguf' } }

  it('fills the placeholders from what the fetch left, and keeps literal text', () => {
    expect(
      expandLiveEnv({ E: '{engine_dir}', T: 'tag={tag}', L: '{model:llm}', F: 'flux2', B: 'cpu' }, values)
    ).toEqual({ E: '/live/engine', T: 'tag=master-883-137f740', L: '/m/llm.gguf', F: 'flux2', B: 'cpu' })
  })

  it('throws on a placeholder the fetch did not fill rather than start a half-set-up run', () => {
    expect(() => expandLiveEnv({ M: '{model:vae}' }, values)).toThrow('{model:vae}')
    expect(() => expandLiveEnv({ M: '{manifest}' }, values)).toThrow('{manifest}')
  })

  it('keys the model cache by the models, whatever their order, and has no key without models', () => {
    const a = { sha256: 'a'.repeat(64) }
    const b = { sha256: 'b'.repeat(64) }
    expect(liveModelsKey([a, b])).toBe(liveModelsKey([b, a]))
    expect(liveModelsKey([a, b])).not.toBe(liveModelsKey([a]))
    expect(liveModelsKey([a])).toMatch(/^[0-9a-f]{16}$/)
    expect(liveModelsKey(undefined)).toBe('')
    expect(liveModelsKey([])).toBe('')
  })
})
