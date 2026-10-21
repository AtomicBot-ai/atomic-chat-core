/**
 * `scripts/lib/engine-pin.mjs` decides which llama.cpp release the candidate check compares against:
 * the one this core takes today. It re-implements the TypeScript catalog in plain JS for the
 * scripts, so it is held here to the same answers as `upstreamRemoteBackends` — on the bundled
 * baseline and on lists with a withdrawn release, a release for newer cores, and candidates only —
 * and, for PrismML, as `prismCatalogToBackends`; for sd.cpp, as `parseSdcppManifest` and the host
 * ladder of `sdcppHostChoice`.
 */
import { describe, expect, it } from 'vitest'
import {
  engineTagBuild,
  PIN_PLATFORMS,
  PRISM_PIN_PLATFORMS,
  parsePrismManifest as parsePrismMjs,
  parseSdcppPinManifest,
  parseUpstreamReleases as parseMjs,
  prismCatalogToBackends as prismBackendsMjs,
  resolvePins,
  resolvePrismPins,
  resolveSdcppPins,
  SDCPP_PIN_PLATFORMS,
  sdcppTagBuild,
  sdcppTagParts,
  upstreamCatalogFromLegacyManifest as legacyMjs,
  upstreamRemoteBackends as remoteMjs,
} from '../../scripts/lib/engine-pin.mjs'
import {
  determinePrismSupportedBackends,
  determineSupportedBackends,
  normalizeFeatures,
  parsePrismManifest,
  parseUpstreamReleases,
  prismCatalogToBackends,
  upstreamCatalogFromLegacyManifest,
  upstreamRemoteBackends,
} from '../../src/backend/index.js'
import { assetInstallable, parseSdcppManifest, sdcppHostChoice } from '../../src/engine-builds/index.js'
import baseline from '../../src/backend/catalog/upstream-releases-baseline.json' with { type: 'json' }
import sdcppLive from '../fixtures/sdcpp/conf/sdcpp-manifest.json' with { type: 'json' }
import sdcppStaging from '../fixtures/sdcpp/conf/sdcpp-manifest.staging.json' with { type: 'json' }
import prismBaseline from '../../src/backend/catalog/prism-manifest-baseline.json' with { type: 'json' }

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

const prismTag = (build: number) => `prism-b${build}-${(build % 0xfffffff).toString(16).padStart(7, '0')}`
const prismAsset = (
  tag: string,
  backend: string,
  validation: 'approved' | 'candidate' = 'approved',
  extra: object = {}
) => ({
  backend,
  name: `llama-${tag}-bin-${backend}.tar.gz`,
  size: 1000,
  sha256: sha(backend.length),
  validation,
  ...extra,
})
const prismRelease = (
  build: number,
  extra: object = {},
  validation: 'approved' | 'candidate' = 'approved'
) => {
  const tag = prismTag(build)
  return {
    tag,
    commit: `${tag.slice(-7)}${'0'.repeat(33)}`,
    published_at: '2026-10-19T00:00:00Z',
    min_core_version: '0.10.0',
    notes_url: `https://example.invalid/${tag}`,
    capabilities: ['pq2_0'],
    assets: [
      ...PRISM_PIN_PLATFORMS.map((p) => prismAsset(tag, p.backend, validation)),
      prismAsset(tag, 'win-cuda-12.4-x64', validation, { companion_backend: 'win-cudart-12.4-x64' }),
      prismAsset(tag, 'win-cudart-12.4-x64', 'candidate', { companion: true }),
    ],
    ...extra,
  }
}
const prismManifests: Record<string, unknown> = {
  'baseline': prismBaseline,
  'a withdrawn newest release': {
    schema_version: 1,
    releases: [prismRelease(10787, { withdrawn: { reason: 'crashes' } }), prismRelease(10754)],
  },
  'the newest release needs a newer core': {
    schema_version: 1,
    releases: [prismRelease(10787, { min_core_version: '99.0.0' }), prismRelease(10754)],
  },
  'the newest release only a candidate': {
    schema_version: 1,
    releases: [prismRelease(10787, {}, 'candidate'), prismRelease(10754)],
  },
  'a newer schema': { schema_version: 2, releases: [prismRelease(10787)] },
  'malformed entries': {
    schema_version: 1,
    releases: [{ tag: 'b11617', assets: [] }, prismRelease(10754), 7],
  },
}

describe('engine-pin.mjs reads the PrismML manifest as the core does', () => {
  for (const [name, raw] of Object.entries(prismManifests)) {
    it(`${name}: same offered packs`, () => {
      const ts = parsePrismManifest(raw)
      const mjs = parsePrismMjs(raw)
      expect(mjs === null).toBe(ts === null)
      if (!ts || !mjs) return
      for (const coreVersion of ['0.17.0', '99.0.0'])
        for (const allowCandidates of [false, true])
          expect(prismBackendsMjs(mjs, { coreVersion, allowCandidates })).toEqual(
            prismCatalogToBackends(ts, { coreVersion, allowCandidates })
          )
    })
  }

  it('names the CPU pack core installs on each platform PrismML builds for', () => {
    for (const p of PRISM_PIN_PLATFORMS) {
      const arch = p.arch === 'x64' ? 'x86_64' : 'aarch64'
      expect(determinePrismSupportedBackends(p.os, arch, normalizeFeatures(null))[0]).toBe(p.backend)
    }
  })

  it('pins each platform to the newest release whose CPU pack is approved', () => {
    const pins = resolvePrismPins({
      manifest: {
        schema_version: 1,
        releases: [
          { ...prismRelease(10787), assets: [prismAsset(prismTag(10787), 'macos-arm64')] },
          prismRelease(10754),
        ],
      },
      coreVersion: '0.18.5',
    })
    expect(pins.source).toBe('prism-manifest')
    expect(pins.per_platform['macos-arm64']?.tag).toBe(prismTag(10787))
    expect(pins.per_platform['linux-x64']?.tag).toBe(prismTag(10754))
    expect(pins.legacy.tag).toBeNull()
    const none = resolvePrismPins({ manifest: undefined, coreVersion: '0.18.5' })
    expect(none.source).toBe('none')
    expect(Object.values(none.per_platform).every((p) => p.tag === null)).toBe(true)
  })

  it("reads the build of either engine's tags", () => {
    expect(engineTagBuild('b11617')).toBe(11617)
    expect(engineTagBuild('prism-b10787-73bfe6c')).toBe(10787)
    expect(engineTagBuild('b10018-1.3.0')).toBeNull()
    expect(engineTagBuild('prism-b10787')).toBeNull()
  })
})

describe('engine-pin.mjs reads the sd.cpp manifest as the core does', () => {
  const manifests: Record<string, unknown> = {
    'conf live (master-883-137f740-a36f1b1a)': sdcppLive,
    'conf staging (master-883-137f740)': sdcppStaging,
    'a rebuild tag with its own rev': { ...sdcppLive, tag_name: 'master-975-95b3090-a0123456' },
    'no sha256 on the CPU archives': {
      ...sdcppLive,
      assets: sdcppLive.assets.map(({ sha256: _sha256, ...a }) => a),
    },
    'an asset name with a path in it, and a backend listed twice': {
      tag_name: 'master-883-137f740',
      assets: [
        { backend: 'linux-cpu-x64', name: '../x.zip', sha256: sha(1), size: 1 },
        { backend: 'linux-cpu-x64', name: 'a.zip', sha256: sha(2), size: 2 },
        { backend: 'linux-cpu-x64', name: 'b.zip', sha256: sha(3), size: 3 },
      ],
    },
    'a tag without its upstream commit': { ...sdcppLive, tag_name: 'master-883' },
    'a rev of eight characters': { ...sdcppLive, tag_name: 'master-883-137f740-a36f1b1aa' },
    'no assets': { tag_name: 'master-883-137f740', assets: [] },
    'not an object': 'master-883-137f740',
  }
  const ts = (raw: unknown) => {
    try {
      return parseSdcppManifest(raw)
    } catch {
      return null
    }
  }

  for (const [name, raw] of Object.entries(manifests))
    it(`${name}: the same document, the pin the core would install on each platform`, () => {
      const core = ts(raw)
      const mjs = parseSdcppPinManifest(raw)
      expect(mjs).toEqual(core)
      const pins = resolveSdcppPins({ manifest: raw, coreVersion: '0.18.6' })
      expect(pins.source).toBe(core ? 'sdcpp-manifest' : 'none')
      for (const p of SDCPP_PIN_PLATFORMS) {
        // A CPU-only host: the bottom rung of the ladder, which is the archive the check runs.
        const choice = core
          ? sdcppHostChoice({ os: p.os, arch: p.arch, features: {}, gpus: [] }, core, new Set())
          : null
        const archive = core?.assets.find((a) => a.backend === choice?.backend_id)
        expect(pins.per_platform[p.platform], p.platform).toEqual({
          backend: p.backend,
          tag: archive && assetInstallable(archive) ? core?.tag_name : null,
        })
        if (archive) expect(choice?.backend_id).toBe(p.backend)
      }
    })

  it('splits a tag into its build, the upstream commit and tag, and the fork rev', () => {
    expect(sdcppTagParts('master-883-137f740-a36f1b1a')).toEqual({
      build: 883,
      sha7: '137f740',
      upstream_tag: 'master-883-137f740',
      atomic_rev: '36f1b1a',
    })
    expect(sdcppTagParts('master-975-95b3090')).toMatchObject({
      upstream_tag: 'master-975-95b3090',
      atomic_rev: null,
    })
    for (const tag of ['master-883', 'master-883-137F740', 'b11617', 'master-883-137f740-atomic'])
      expect(sdcppTagParts(tag), tag).toBeNull()
    expect(sdcppTagBuild('master-883-137f740-a36f1b1a')).toBe(883)
    expect(engineTagBuild('master-975-95b3090')).toBe(975)
  })
})
