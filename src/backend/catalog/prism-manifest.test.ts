import { describe, expect, it } from 'vitest'
import {
  findPrismRelease,
  parsePrismManifest,
  prismArchiveSources,
  prismAssetOffered,
  prismCatalogToBackends,
  prismReleaseOffered,
  prismTagBuild,
} from './prism-manifest.js'
import type { PrismAsset, PrismManifest, PrismRelease } from './prism-manifest.js'

const SHA = (c: string) => c.repeat(64)
const asset = (backend: string, over: Partial<PrismAsset> = {}): PrismAsset => ({
  backend,
  name: `llama-prism-${backend}.tar.gz`,
  size: 100,
  sha256: SHA('a'),
  validation: 'approved',
  ...over,
})
const release = (tag: string, over: Partial<PrismRelease> = {}): PrismRelease => ({
  tag,
  commit: 'b'.repeat(40),
  published_at: '2026-10-02T00:00:00Z',
  min_core_version: '0.10.0',
  notes_url: `https://github.com/PrismML-Eng/llama.cpp/releases/tag/${tag}`,
  capabilities: ['pq2_0'],
  assets: [asset('macos-arm64')],
  ...over,
})
const manifest = (releases: PrismRelease[], over: Partial<PrismManifest> = {}): PrismManifest => ({
  schema_version: 1,
  updated_at: '2026-10-05T00:00:00Z',
  upstream_repo: 'PrismML-Eng/llama.cpp',
  releases,
  ...over,
})
const OFFER = { coreVersion: '0.10.0', allowCandidates: false }

describe('prismTagBuild', () => {
  it.each([
    ['prism-b10754-2459f68', 10754],
    ['prism-b1-0000000', 1],
    ['b10754', null],
    ['prism-b10754-2459F68', null],
    ['prism-b10754-2459f6', null],
  ])('%s → %s', (tag, build) => {
    expect(prismTagBuild(tag)).toBe(build)
  })
})

describe('parsePrismManifest', () => {
  it('keeps a valid document and its optional fields', () => {
    const doc = manifest(
      [
        release('prism-b2-0000000', {
          notes: 'n',
          supersedes: ['prism-b1-0000000'],
          withdrawn: { reason: 'r' },
        }),
      ],
      {
        download_base: 'https://mirror.example/dl',
      }
    )
    expect(parsePrismManifest(JSON.parse(JSON.stringify(doc)))).toEqual(doc)
  })
  it.each([
    ['not an object', 'x'],
    ['a newer schema', { ...manifest([]), schema_version: 2 }],
    ['no releases array', { schema_version: 1 }],
  ])('refuses %s', (_label, raw) => {
    expect(parsePrismManifest(raw)).toBeNull()
  })
  it('drops malformed releases and assets, keeps the rest', () => {
    const raw = {
      schema_version: 1,
      releases: [
        { ...release('not-a-prism-tag') },
        { ...release('prism-b3-0000000'), commit: 'short' },
        {
          ...release('prism-b4-0000000'),
          capabilities: ['pq2_0', 'telepathy'],
          assets: [
            asset('ok'),
            { ...asset('bad-sha'), sha256: 'abc' },
            { ...asset('bad-size'), size: 0 },
            { ...asset('bad-validation'), validation: 'maybe' },
          ],
        },
      ],
    }
    const parsed = parsePrismManifest(raw)
    expect(parsed?.releases.map((r) => r.tag)).toEqual(['prism-b4-0000000'])
    expect(parsed?.releases[0]?.assets.map((a) => a.backend)).toEqual(['ok'])
    expect(parsed?.releases[0]?.capabilities).toEqual(['pq2_0'])
  })
})

describe('prismReleaseOffered', () => {
  it.each([
    ['runnable', release('prism-b1-0000000'), '0.10.0', true],
    ['newer core than required', release('prism-b1-0000000'), '0.11.2', true],
    ['needs a newer core', release('prism-b1-0000000', { min_core_version: '0.11.0' }), '0.10.0', false],
    ['withdrawn', release('prism-b1-0000000', { withdrawn: { reason: 'crash' } }), '0.10.0', false],
  ])('%s', (_label, r, coreVersion, expected) => {
    expect(prismReleaseOffered(r, { coreVersion })).toBe(expected)
  })
})

describe('prismAssetOffered', () => {
  const cuda = asset('win-cuda-12.4-x64', { companion_backend: 'win-cudart-12.4-x64' })
  const cudart = asset('win-cudart-12.4-x64', { companion: true })
  it.each([
    ['approved', release('t', { assets: [asset('a')] }), asset('a'), false, true],
    ['candidate without opt-in', release('t'), asset('a', { validation: 'candidate' }), false, false],
    ['candidate with opt-in', release('t'), asset('a', { validation: 'candidate' }), true, true],
    ['a companion on its own', release('t', { assets: [cudart] }), cudart, true, false],
    ['a pack with its companion', release('t', { assets: [cuda, cudart] }), cuda, false, true],
    ['a pack whose companion is missing', release('t', { assets: [cuda] }), cuda, true, false],
    [
      'a pack whose companion is still a candidate',
      release('t', { assets: [cuda, { ...cudart, validation: 'candidate' }] }),
      cuda,
      false,
      false,
    ],
  ])('%s', (_label, r, a, allowCandidates, expected) => {
    expect(prismAssetOffered(r, a, { allowCandidates })).toBe(expected)
  })
})

describe('prismCatalogToBackends', () => {
  it('lists offered packs newest build first and skips companions, candidates and unrunnable releases', () => {
    const doc = manifest([
      release('prism-b10-0000000', {
        assets: [asset('macos-arm64'), asset('linux-cpu-x64', { validation: 'candidate' })],
      }),
      release('prism-b30-0000000', { min_core_version: '9.0.0' }),
      release('prism-b20-0000000', {
        assets: [
          asset('win-cuda-12.4-x64', { companion_backend: 'win-cudart-12.4-x64' }),
          asset('win-cudart-12.4-x64', { companion: true }),
        ],
      }),
    ])
    expect(prismCatalogToBackends(doc, OFFER)).toEqual([
      { version: 'prism-b20-0000000', backend: 'win-cuda-12.4-x64' },
      { version: 'prism-b10-0000000', backend: 'macos-arm64' },
    ])
    expect(prismCatalogToBackends(doc, { ...OFFER, allowCandidates: true })).toContainEqual({
      version: 'prism-b10-0000000',
      backend: 'linux-cpu-x64',
    })
  })
})

describe('findPrismRelease / prismArchiveSources', () => {
  const doc = manifest([
    release('prism-b20-0000000', {
      assets: [
        asset('win-cuda-12.4-x64', { name: 'main.zip', size: 10, companion_backend: 'win-cudart-12.4-x64' }),
        asset('win-cudart-12.4-x64', { name: 'cudart.zip', size: 5, sha256: SHA('c'), companion: true }),
        asset('win-cuda-13.3-x64', { companion_backend: 'win-cudart-13.3-x64' }),
      ],
    }),
  ])
  it('finds a release by tag', () => {
    expect(findPrismRelease(doc, 'prism-b20-0000000')?.tag).toBe('prism-b20-0000000')
    expect(findPrismRelease(doc, 'prism-b21-0000000')).toBeUndefined()
  })
  it('returns the pack then its companion with pinned hashes', () => {
    expect(prismArchiveSources(doc, 'prism-b20-0000000', 'win-cuda-12.4-x64')).toEqual([
      {
        name: 'main.zip',
        url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b20-0000000/main.zip',
        sha256: SHA('a'),
        size: 10,
        companion: false,
      },
      {
        name: 'cudart.zip',
        url: 'https://github.com/PrismML-Eng/llama.cpp/releases/download/prism-b20-0000000/cudart.zip',
        sha256: SHA('c'),
        size: 5,
        companion: true,
      },
    ])
  })
  it('honours download_base', () => {
    const mirrored = { ...doc, download_base: 'https://mirror.example/dl/' }
    expect(prismArchiveSources(mirrored, 'prism-b20-0000000', 'win-cuda-12.4-x64')?.[0]?.url).toBe(
      'https://mirror.example/dl/prism-b20-0000000/main.zip'
    )
  })
  it.each([
    ['an unknown tag', 'prism-b99-0000000', 'win-cuda-12.4-x64'],
    ['an unknown backend', 'prism-b20-0000000', 'macos-arm64'],
    ['a companion asked for directly', 'prism-b20-0000000', 'win-cudart-12.4-x64'],
    ['a pack whose companion is missing', 'prism-b20-0000000', 'win-cuda-13.3-x64'],
  ])('is null for %s', (_label, tag, backend) => {
    expect(prismArchiveSources(doc, tag, backend)).toBeNull()
  })
})
