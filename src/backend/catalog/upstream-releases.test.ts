import { describe, expect, it } from 'vitest'
import {
  ANY_CORE_VERSION,
  parseUpstreamReleases,
  upstreamAssetOffered,
  upstreamCatalogFromLegacyManifest,
  upstreamManifestForTag,
  upstreamReleaseOffered,
  upstreamRemoteBackends,
  upstreamTagBuild,
} from './upstream-releases.js'
import type { UpstreamRelease, UpstreamReleaseAsset, UpstreamReleaseCatalog } from './upstream-releases.js'

const SHA = (c: string) => c.repeat(64)
const asset = (tag: string, suffix: string, validation: UpstreamReleaseAsset['validation'] = 'approved') => ({
  name: `llama-${tag}-bin-${suffix}`,
  sha256: SHA('a'),
  size: 10,
  validation,
})
const release = (tag: string, assets: UpstreamReleaseAsset[], extra: Partial<UpstreamRelease> = {}) => ({
  tag,
  min_core_version: ANY_CORE_VERSION,
  assets,
  ...extra,
})
const BASE = 'https://mirror.example/releases'
const catalog = (...releases: UpstreamRelease[]): UpstreamReleaseCatalog => ({
  schema_version: 1,
  download_base: BASE,
  releases,
})
const OFFER = { coreVersion: '0.15.0', allowCandidates: false }

describe('upstreamTagBuild', () => {
  it.each([
    ['b11463', 11463],
    ['b1', 1],
    ['v0.6.0', null],
    ['b11463-1.4.0', null],
    ['', null],
  ])('%j → %j', (tag, build) => {
    expect(upstreamTagBuild(tag)).toBe(build)
  })
})

describe('parseUpstreamReleases', () => {
  it('reads the conf document, dropping malformed releases and archives', () => {
    const doc = {
      $schema: './llamacpp-upstream-releases-schema.json',
      schema_version: 1,
      updated_at: '2026-10-13T00:00:00Z',
      upstream_repo: 'ggml-org/llama.cpp',
      download_base: BASE,
      releases: [
        {
          tag: 'b11500',
          commit: 'd'.repeat(40),
          published_at: '2026-10-10T00:00:00Z',
          min_core_version: '0.16.0',
          notes_url: 'https://github.com/ggml-org/llama.cpp/releases/tag/b11500',
          withdrawn: { reason: 'crashes on load' },
          assets: [
            asset('b11500', 'macos-arm64.tar.gz'),
            { ...asset('b11500', 'win-cpu-x64.zip'), sha256: 'nothex' },
            { ...asset('b11500', 'win-vulkan-x64.zip'), size: 0 },
            { ...asset('b11500', 'ubuntu-x64.tar.gz'), validation: 'maybe' },
            { name: '' },
            'garbage',
          ],
        },
        { tag: 'master-1', min_core_version: '0.0.0', assets: [] },
        { tag: 'b11400', assets: [] },
        { tag: 'b11300', min_core_version: '0.0.0', withdrawn: { reason: '' } },
        null,
      ],
    }
    expect(parseUpstreamReleases(doc)).toEqual({
      schema_version: 1,
      download_base: BASE,
      releases: [
        {
          tag: 'b11500',
          min_core_version: '0.16.0',
          withdrawn: { reason: 'crashes on load' },
          assets: [asset('b11500', 'macos-arm64.tar.gz')],
        },
        { tag: 'b11300', min_core_version: '0.0.0', assets: [] },
      ],
    })
  })

  it.each([
    ['a newer schema', { schema_version: 2, releases: [] }],
    ['no releases', { schema_version: 1 }],
    ['an array', []],
    ['null', null],
  ])('refuses %s', (_label, doc) => {
    expect(parseUpstreamReleases(doc)).toBeNull()
  })

  it('keeps a list without a download_base', () => {
    expect(parseUpstreamReleases({ schema_version: 1, releases: [] })).toEqual({
      schema_version: 1,
      releases: [],
    })
  })
})

describe('upstreamCatalogFromLegacyManifest', () => {
  it('reads the legacy manifest as one release every core runs', () => {
    expect(
      upstreamCatalogFromLegacyManifest({
        tag_name: 'b11463',
        download_base: BASE,
        assets: [
          { name: 'llama-b11463-bin-macos-arm64.tar.gz', sha256: SHA('a'), size: 10 },
          { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip' },
          { sha256: SHA('b') },
        ],
      })
    ).toEqual({
      schema_version: 1,
      download_base: BASE,
      releases: [
        {
          tag: 'b11463',
          min_core_version: ANY_CORE_VERSION,
          assets: [
            {
              name: 'llama-b11463-bin-macos-arm64.tar.gz',
              sha256: SHA('a'),
              size: 10,
              validation: 'approved',
            },
            { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip', validation: 'approved' },
          ],
        },
      ],
    })
  })

  it('keeps an unmirrored tag on the CDN and refuses a manifest without a tag', () => {
    expect(upstreamCatalogFromLegacyManifest({ tag_name: 'b1' })).toEqual({
      schema_version: 1,
      releases: [{ tag: 'b1', min_core_version: ANY_CORE_VERSION, assets: [] }],
    })
    expect(upstreamCatalogFromLegacyManifest({ assets: [] })).toBeNull()
    expect(upstreamCatalogFromLegacyManifest('b1')).toBeNull()
  })
})

describe('offers', () => {
  it.each([
    ['every core', { min_core_version: '0.0.0' }, '0.15.0', true],
    ['this core', { min_core_version: '0.15.0' }, '0.15.0', true],
    ['an older core', { min_core_version: '0.14.2' }, '0.15.0', true],
    ['a newer core', { min_core_version: '0.16.0' }, '0.15.0', false],
    ['a withdrawn release', { withdrawn: { reason: 'x' } }, '0.15.0', false],
  ])('a release for %s is offered: %s', (_label, extra, coreVersion, offered) => {
    expect(upstreamReleaseOffered(release('b1', [], extra), { coreVersion })).toBe(offered)
  })

  it('offers candidates only on opt-in', () => {
    expect(upstreamAssetOffered(asset('b1', 'x.zip'), { allowCandidates: false })).toBe(true)
    expect(upstreamAssetOffered(asset('b1', 'x.zip', 'candidate'), { allowCandidates: false })).toBe(false)
    expect(upstreamAssetOffered(asset('b1', 'x.zip', 'candidate'), { allowCandidates: true })).toBe(true)
  })
})

describe('upstreamRemoteBackends', () => {
  const list = catalog(
    release('b11400', [asset('b11400', 'win-cpu-x64.zip'), asset('b11400', 'win-vulkan-x64.zip')]),
    release('b11600', [asset('b11600', 'win-cpu-x64.zip')], { min_core_version: '0.16.0' }),
    release('b11500', [
      asset('b11500', 'win-cpu-x64.zip'),
      asset('b11500', 'win-vulkan-x64.zip', 'candidate'),
      asset('b11500', 'macos-arm64.tar.gz'),
    ]),
    release('b11550', [asset('b11550', 'win-cpu-x64.zip')], { withdrawn: { reason: 'bad' } })
  )

  it('takes each backend from the newest offered release, newest build first', () => {
    expect(upstreamRemoteBackends(list, OFFER, 'windows', 'x64')).toEqual([
      { version: 'b11500', backend: 'win-cpu-x64', order: 0 },
      { version: 'b11400', backend: 'win-vulkan-x64', order: 0 },
    ])
  })

  it('moves a backend to a candidate on opt-in, and to a release for a newer core on that core', () => {
    expect(upstreamRemoteBackends(list, { ...OFFER, allowCandidates: true }, 'windows', 'x64')).toEqual([
      { version: 'b11500', backend: 'win-cpu-x64', order: 0 },
      { version: 'b11500', backend: 'win-vulkan-x64', order: 0 },
    ])
    expect(upstreamRemoteBackends(list, { ...OFFER, coreVersion: '0.16.0' }, 'windows', 'x64')[0]).toEqual({
      version: 'b11600',
      backend: 'win-cpu-x64',
      order: 0,
    })
  })

  it('applies the platform filter of the legacy parser', () => {
    expect(upstreamRemoteBackends(list, OFFER, 'macos', 'arm64')).toEqual([
      { version: 'b11500', backend: 'macos-arm64', order: 0 },
    ])
    expect(upstreamRemoteBackends(list, OFFER, 'macos', 'x64')).toEqual([])
    expect(upstreamRemoteBackends(list, OFFER, 'android', 'arm64')).toEqual([])
  })
})

describe('upstreamManifestForTag', () => {
  const list = catalog(
    release('b11500', [asset('b11500', 'macos-arm64.tar.gz', 'candidate')], { withdrawn: { reason: 'x' } })
  )

  it('gives any listed tag its mirror and hashes, offered or not', () => {
    expect(upstreamManifestForTag(list, 'b11500')).toEqual({
      tag_name: 'b11500',
      download_base: BASE,
      assets: [{ name: 'llama-b11500-bin-macos-arm64.tar.gz', sha256: SHA('a'), size: 10 }],
    })
  })

  it('is null for an unlisted tag and keeps an unmirrored legacy tag on the CDN', () => {
    expect(upstreamManifestForTag(list, 'b1')).toBeNull()
    const legacy = upstreamCatalogFromLegacyManifest({
      tag_name: 'b1',
      assets: [{ name: 'llama-b1-bin-win-cpu-x64.zip' }],
    })!
    expect(upstreamManifestForTag(legacy, 'b1')).toEqual({
      tag_name: 'b1',
      assets: [{ name: 'llama-b1-bin-win-cpu-x64.zip' }],
    })
  })
})
