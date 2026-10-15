/**
 * `scripts/lib/engine-pin.mjs` decides which llama.cpp release the candidate check compares against:
 * the one this core takes today. It re-implements the TypeScript catalog in plain JS for the
 * scripts, so it is held here to the same answers as `upstreamRemoteBackends` — on the bundled
 * baseline and on lists with a withdrawn release, a release for newer cores, and candidates only.
 */
import { describe, expect, it } from 'vitest'
import {
  PIN_PLATFORMS,
  parseUpstreamReleases as parseMjs,
  resolvePins,
  upstreamCatalogFromLegacyManifest as legacyMjs,
  upstreamRemoteBackends as remoteMjs,
} from '../../scripts/lib/engine-pin.mjs'
import {
  determineSupportedBackends,
  normalizeFeatures,
  parseUpstreamReleases,
  upstreamCatalogFromLegacyManifest,
  upstreamRemoteBackends,
} from '../../src/backend/index.js'
import baseline from '../../src/backend/catalog/upstream-releases-baseline.json' with { type: 'json' }

const sha = (n: number) => n.toString(16).padStart(64, '0')
const asset = (tag: string, infix: string, validation: 'approved' | 'candidate' = 'approved') => ({
  name: `llama-${tag}-bin-${infix}`,
  sha256: sha(infix.length + Number(tag.slice(1))),
  size: 1000,
  validation,
})
const ALL = [
  'macos-arm64.tar.gz',
  'ubuntu-x64.tar.gz',
  'ubuntu-arm64.tar.gz',
  'ubuntu-vulkan-x64.tar.gz',
  'ubuntu-cuda-13.4-arm64.tar.gz',
  'win-cpu-x64.zip',
  'win-cpu-arm64.zip',
  'win-cuda-13.4-x64.zip',
  'win-rocm-10.0-x64.zip',
  'win-vulkan-arm64.zip',
]
const release = (tag: string, extra: object = {}, validation: 'approved' | 'candidate' = 'approved') => ({
  tag,
  min_core_version: '0.0.0',
  assets: ALL.map((infix) => asset(tag, infix, validation)),
  ...extra,
})

const catalogs: Record<string, unknown> = {
  baseline,
  'a withdrawn newest release': {
    schema_version: 1,
    releases: [release('b11617', { withdrawn: { reason: 'crashes on load' } }), release('b11463')],
  },
  'the newest release needs a newer core': {
    schema_version: 1,
    releases: [release('b11617', { min_core_version: '99.0.0' }), release('b11463')],
  },
  'the newest release only a candidate': {
    schema_version: 1,
    releases: [release('b11617', {}, 'candidate'), release('b11463')],
  },
  'macOS only approved on the newest': {
    schema_version: 1,
    releases: [
      {
        tag: 'b11617',
        min_core_version: '0.0.0',
        assets: [asset('b11617', 'macos-arm64.tar.gz'), asset('b11617', 'ubuntu-x64.tar.gz', 'candidate')],
      },
      release('b11463'),
    ],
  },
  'a newer schema': { schema_version: 2, releases: [release('b11617')] },
  'malformed entries': {
    schema_version: 1,
    releases: [{ tag: 'latest', min_core_version: '0.0.0', assets: [] }, release('b11463'), 7],
  },
}

const HOSTS: Array<[string, 'x64' | 'arm64']> = [
  ['linux', 'x64'],
  ['linux', 'arm64'],
  ['macos', 'x64'],
  ['macos', 'arm64'],
  ['windows', 'x64'],
  ['windows', 'arm64'],
]

describe('engine-pin.mjs reads release lists as the core does', () => {
  for (const [name, raw] of Object.entries(catalogs)) {
    it(`${name}: same releases and the same backends on every host`, () => {
      const ts = parseUpstreamReleases(raw)
      expect(parseMjs(raw)).toEqual(ts)
      if (!ts) return
      for (const coreVersion of ['0.17.0', '99.0.0'])
        for (const allowCandidates of [false, true])
          for (const [os, arch] of HOSTS)
            expect(remoteMjs(ts, { coreVersion, allowCandidates }, os, arch), `${os}-${arch}`).toEqual(
              upstreamRemoteBackends(ts, { coreVersion, allowCandidates }, os, arch)
            )
    })
  }

  it('reads the legacy manifest as one release every core runs', () => {
    const manifest = {
      tag_name: 'b11463',
      download_base: 'https://example.invalid',
      assets: [{ name: 'llama-b11463-bin-ubuntu-x64.tar.gz', sha256: sha(1), size: 9 }, { name: 'x' }, 3],
    }
    expect(legacyMjs(manifest)).toEqual(upstreamCatalogFromLegacyManifest(manifest))
    expect(legacyMjs({ assets: [] })).toBeNull()
  })
})

describe('resolvePins', () => {
  it('names the CPU backend core installs on each platform', () => {
    for (const p of PIN_PLATFORMS) {
      const os = p.os
      const arch = p.arch === 'x64' ? 'x86_64' : 'aarch64'
      expect(determineSupportedBackends(os, arch, normalizeFeatures(null))[0]).toBe(p.backend)
    }
  })

  it('pins every platform to the baseline release, and reports the legacy tag beside it', () => {
    const pins = resolvePins({ releases: baseline, manifest: { tag_name: 'b11400' }, coreVersion: '0.17.0' })
    expect(pins.source).toBe('list')
    expect(Object.values(pins.per_platform).map((p) => p.tag)).toEqual(PIN_PLATFORMS.map(() => 'b11463'))
    expect(pins.legacy.tag).toBe('b11400')
  })

  it('skips what this core does not take, per platform', () => {
    const pins = resolvePins({
      releases: catalogs['macOS only approved on the newest'],
      manifest: undefined,
      coreVersion: '0.17.0',
    })
    expect(pins.per_platform['macos-arm64']?.tag).toBe('b11617')
    expect(pins.per_platform['linux-x64']?.tag).toBe('b11463')
    expect(
      resolvePins({
        releases: catalogs['a withdrawn newest release'],
        manifest: undefined,
        coreVersion: '0.17.0',
      }).per_platform['linux-x64']?.tag
    ).toBe('b11463')
    expect(
      resolvePins({
        releases: catalogs['the newest release needs a newer core'],
        manifest: undefined,
        coreVersion: '99.0.0',
      }).per_platform['linux-x64']?.tag
    ).toBe('b11617')
  })

  it('falls back to the legacy manifest when the list is not one this core reads', () => {
    const pins = resolvePins({
      releases: catalogs['a newer schema'],
      manifest: { tag_name: 'b11400', assets: [{ name: 'llama-b11400-bin-win-cpu-x64.zip' }] },
      coreVersion: '0.17.0',
    })
    expect(pins.source).toBe('legacy')
    expect(pins.list.readable).toBe(false)
    expect(pins.per_platform['windows-x64']?.tag).toBe('b11400')
    expect(pins.per_platform['linux-x64']?.tag).toBeNull()
  })
})
