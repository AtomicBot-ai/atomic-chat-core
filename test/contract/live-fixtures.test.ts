/**
 * The release-picking rules of `scripts/fetch-live-fixtures.mjs`, which decide what llama.cpp build
 * the live suites run: the platform's CPU asset, the newest release that has it (ggml-org's builds
 * are prereleases and its `latest` carries no binaries), and a digest check on the bytes; and for an
 * engine with several model files (sd.cpp), the live env its config describes and the models' cache key,
 * and for a model that is a folder of files (MLX), where each file lands and what pins the folder.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assetPatternFor,
  digestMatches,
  expandLiveEnv,
  liveModelDigest,
  liveModelsKey,
  pickRelease,
} from '../../scripts/lib/live-fixtures.mjs'
import { liveModelFiles, liveModelPath } from '../../scripts/lib/sdcpp-fixtures.mjs'

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

describe('a live model that is a folder of files', () => {
  const folder = {
    id: 'tiny',
    url: 'https://huggingface.co/org/tiny/resolve/0123456789abcdef0123456789abcdef01234567/',
    files: [
      { path: 'config.json', sha256: 'c'.repeat(64) },
      { path: 'model.safetensors', sha256: 'd'.repeat(64) },
    ],
  }

  it('is pinned by its files: their order does not matter, another file or other bytes do', () => {
    const [config, weights] = folder.files as [(typeof folder.files)[0], (typeof folder.files)[0]]
    const digest = liveModelDigest(folder)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
    expect(liveModelDigest({ ...folder, files: [weights, config] })).toBe(digest)
    expect(liveModelDigest({ ...folder, files: [config] })).not.toBe(digest)
    expect(liveModelDigest({ ...folder, files: [{ ...config, sha256: 'e'.repeat(64) }, weights] })).not.toBe(
      digest
    )
    // A single file is its own sha256, as before.
    expect(liveModelDigest({ sha256: 'a'.repeat(64) })).toBe('a'.repeat(64))
    expect(liveModelsKey([folder])).toMatch(/^[0-9a-f]{16}$/)
    expect(liveModelsKey([folder])).not.toBe(liveModelsKey([{ sha256: 'a'.repeat(64) }]))
  })

  it('lands in a folder of its own, each file under the revision it is pinned to', () => {
    const dir = join('/models', liveModelDigest(folder).slice(0, 16), 'tiny')
    expect(liveModelPath('/models', folder)).toBe(dir)
    expect(liveModelFiles('/models', folder)).toEqual([
      { url: `${folder.url}config.json`, path: join(dir, 'config.json'), sha256: 'c'.repeat(64) },
      { url: `${folder.url}model.safetensors`, path: join(dir, 'model.safetensors'), sha256: 'd'.repeat(64) },
    ])
  })

  it('refuses a file path that would leave the folder, and a base URL that is not a folder', () => {
    for (const path of ['../x', 'a/../../b', '/etc/passwd', './x'])
      expect(
        () => liveModelFiles('/models', { ...folder, files: [{ path, sha256: 'c'.repeat(64) }] }),
        path
      ).toThrow('bad file path')
    expect(() => liveModelFiles('/models', { ...folder, url: folder.url.slice(0, -1) })).toThrow(
      'ends with /'
    )
  })
})
