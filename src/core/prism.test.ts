import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { PRISM_MANIFEST_BASELINE } from '../backend/index.js'
import type { PrismManifest } from '../backend/index.js'
import { ModelCompatibilityService } from '../models/index.js'
import { currentPrismPack, installedPrism, wirePrismCompatibility } from './prism.js'
import type { PrismWiringDeps } from './prism.js'

const TAG = PRISM_MANIFEST_BASELINE.releases[0]!.tag
const LIVE: PrismManifest = {
  ...PRISM_MANIFEST_BASELINE,
  releases: [
    { ...PRISM_MANIFEST_BASELINE.releases[0]!, tag: 'prism-b20000-abcdef0', capabilities: ['pq2_0'] },
  ],
}

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-prism-')
})
afterEach(() => data.cleanup())

const deps = (versionBackend: string, over: Partial<PrismWiringDeps> = {}): PrismWiringDeps => ({
  layout: data.layout,
  settings: { get: () => ({ version_backend: versionBackend }) } as never,
  hardware: { facts: async () => ({ osType: 'macos', arch: 'aarch64', gpus: [], source: 'probe' }) } as never,
  prismCatalog: {
    catalog: vi.fn(async () => ({ manifest: LIVE, source: 'live' as const })),
    cachedManifest: vi.fn(async () => PRISM_MANIFEST_BASELINE),
  },
  fetch: (async () => new Response()) as typeof fetch,
  selectInstalled: async () => undefined,
  ...over,
})

describe('installedPrism', () => {
  it('is none without a Prism pack on disk', async () => {
    expect(await installedPrism(deps(''), { offline: true })).toEqual({ build: null })
    expect(await installedPrism(deps(`${TAG}/macos-arm64`), { offline: true })).toEqual({ build: null })
  })

  it('reads the configured pack and, offline, the cached manifest only', async () => {
    await data.writeBackend('atomic-prism', TAG, 'macos-arm64')
    const d = deps(`${TAG}/macos-arm64`)
    expect(await installedPrism(d, { offline: true })).toEqual({
      build: 10754,
      capabilities: PRISM_MANIFEST_BASELINE.releases[0]!.capabilities,
    })
    expect(d.prismCatalog.catalog).not.toHaveBeenCalled()
  })

  it('falls back to the best installed pack and to unknown capabilities for an unlisted release', async () => {
    const d = deps('', {
      selectInstalled: async () => ({
        path: '/x',
        version_backend: 'prism-b30000-1234567/macos-arm64',
        version: 'prism-b30000-1234567',
        backend: 'macos-arm64',
      }),
    })
    expect(await installedPrism(d, { offline: false })).toEqual({ build: 30000 })
    expect(d.prismCatalog.catalog).toHaveBeenCalled()
  })
})

describe('currentPrismPack', () => {
  it.each([
    ['nothing configured or installed', '', false, null],
    ['the configured pack is missing on disk', `${TAG}/macos-arm64`, false, null],
    ['the configured pack is on disk', `${TAG}/macos-arm64`, true, { version: TAG, backend: 'macos-arm64' }],
  ])('%s', async (_name, configured, onDisk, expected) => {
    if (onDisk) await data.writeBackend('atomic-prism', TAG, 'macos-arm64')
    expect(await currentPrismPack(deps(configured))).toEqual(expected)
  })

  it('falls back to the best installed pack', async () => {
    const d = deps('', {
      selectInstalled: async () => ({
        path: '/x',
        version_backend: `${TAG}/macos-arm64`,
        version: TAG,
        backend: 'macos-arm64',
      }),
    })
    expect(await currentPrismPack(d)).toEqual({ version: TAG, backend: 'macos-arm64' })
  })
})

describe('wirePrismCompatibility', () => {
  it('builds the shared service', () => {
    expect(wirePrismCompatibility(deps(''))).toBeInstanceOf(ModelCompatibilityService)
  })

  it('reads the model rules from the test hook URL when one is set', async () => {
    const seen: string[] = []
    const fetch = (async (url: string | URL) => {
      seen.push(String(url))
      return new Response('nope', { status: 404 })
    }) as typeof globalThis.fetch
    const service = wirePrismCompatibility(deps('', { fetch, rulesUrl: 'http://127.0.0.1:9/rules.json' }))
    await service.check({ repo: 'prism-ml/Ternary-Bonsai-8B-gguf', file: 'Ternary-Bonsai-8B-PQ2_0.gguf' })
    expect(seen).toEqual(['http://127.0.0.1:9/rules.json'])
  })
})
