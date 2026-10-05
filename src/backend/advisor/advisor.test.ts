import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { AtomicCoreError } from '../../contracts/index.js'
import type { CoreEvents, LlamacppProviderId, ProxyConfig } from '../../contracts/index.js'
import type { HardwareFacts } from '../../hardware/index.js'
import {
  BUNDLED_BASELINE_TAG,
  LLAMACPP_BACKEND_MANIFEST_URL,
  ManifestSessionCache,
  PRISM_MANIFEST_URL,
  TURBOQUANT_LATEST_RELEASE_URL,
  TURBOQUANT_LEGACY_MANIFEST_URL,
} from '../catalog/index.js'
import type { PrismManifest } from '../catalog/index.js'
import { OptimalBackendStore } from '../optimal/index.js'
import { TURBOQUANT_RELEASE_INDEX_URL } from '../turboquant.js'
import type { BackendVersion, GpuProbeInfo, OptimalBackendCacheRecord } from '../types.js'
import {
  BackendAdvisor,
  classifyCurrent,
  prismCatalogReleases,
  prismUpdateResponse,
  recommendationOf,
  refreshOutcome,
} from './advisor.js'
import type { BackendAdvisorDeps } from './advisor.js'

// ---------------------------------------------------------------------------------------------
// Fixtures: the release streams as the app's tests mirror them, and the canonical hosts.
// ---------------------------------------------------------------------------------------------

const UP = 'b10809'
const UPSTREAM_MANIFEST = {
  tag_name: UP,
  assets: [
    'win-cpu-x64.zip',
    'win-cuda-12.4-x64.zip',
    'win-cuda-13.3-x64.zip',
    'win-rocm-7.14-x64.zip',
    'win-vulkan-x64.zip',
    'ubuntu-x64.tar.gz',
    'ubuntu-vulkan-x64.tar.gz',
    'macos-arm64.tar.gz',
  ].map((suffix) => ({ name: `llama-${UP}-bin-${suffix}` })),
}
const TQ = 'b10269-1.4.0'
const TQ_OLD = 'b10018-1.3.0'
const variants = (ids: string[]) =>
  ids.map((id) => ({
    id,
    asset: `llama-turboquant-${id}.${id.startsWith('windows-') ? 'zip' : 'tar.gz'}`,
    size: 10,
  }))
const FORK_INDEX = {
  schema_version: 1,
  latest: TQ,
  releases: [
    {
      tag: TQ,
      prerelease: false,
      title: `TurboQuant ${TQ}`,
      highlights: ['DeepSeek V4 Flash support'],
      variants: variants([
        'windows-x64-cpu',
        'windows-x64-cuda-12.4',
        'windows-x64-cuda-13.3',
        'windows-x64-vulkan',
        'linux-x64-cpu',
        'linux-x64-cuda-12.4',
        'linux-x64-cuda-13.3',
        'linux-x64-rocm',
        'linux-x64-vulkan',
        'macos-arm64',
      ]),
    },
    {
      tag: TQ_OLD,
      prerelease: false,
      variants: variants(['linux-x64-vulkan', 'windows-x64-cpu', 'macos-arm64']),
    },
  ],
}

const rtx4090: GpuProbeInfo = {
  vendor: 'NVIDIA',
  driver_version: '581.42',
  total_memory: 24_576,
  nvidia_info: { compute_capability: '8.9' },
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x2684 },
}
const gtx1080: GpuProbeInfo = {
  vendor: 'NVIDIA',
  driver_version: '560.94',
  total_memory: 8_192,
  nvidia_info: { compute_capability: '6.1' },
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x1b80 },
}
const rx7900xtx: GpuProbeInfo = {
  vendor: 'AMD',
  driver_version: '32.0.12033.1030',
  total_memory: 24_576,
  nvidia_info: null,
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x744c },
}
const intelIgpu: GpuProbeInfo = {
  vendor: 'Intel',
  total_memory: 8_192,
  nvidia_info: null,
  vulkan_info: { device_type: 'IntegratedGpu', device_id: 0x46a6 },
}

const host = (osType: string, gpus: GpuProbeInfo[], arch = 'x86_64'): HardwareFacts => ({
  osType,
  arch,
  cpuExtensions: ['avx', 'avx2'],
  gpus,
  source: 'probe',
})

type Handler = (init?: RequestInit) => Response | Promise<Response>
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const offline = () => {
  throw new Error('offline')
}
const ONLINE: Record<string, Handler> = {
  [LLAMACPP_BACKEND_MANIFEST_URL]: () => json(UPSTREAM_MANIFEST),
  [TURBOQUANT_RELEASE_INDEX_URL]: () => json(FORK_INDEX),
}
const OFFLINE: Record<string, Handler> = {
  [LLAMACPP_BACKEND_MANIFEST_URL]: offline,
  [TURBOQUANT_RELEASE_INDEX_URL]: offline,
  [TURBOQUANT_LATEST_RELEASE_URL]: offline,
  [TURBOQUANT_LEGACY_MANIFEST_URL]: offline,
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-advisor-')
})
afterEach(() => data.cleanup())

interface Harness {
  advisor: BackendAdvisor
  store: OptimalBackendStore
  events: CoreEvents['backend:better-detected'][]
  fetches: string[]
  proxies: Array<ProxyConfig | null | undefined>
  log: ReturnType<typeof vi.fn<(level: 'info' | 'warn', message: string) => void>>
  clock: { now: number }
}

async function harness(
  provider: LlamacppProviderId,
  facts: HardwareFacts,
  options: {
    routes?: Record<string, Handler>
    /** `'scan'` leaves the seam out so the advisor scans the data folder itself. */
    installed?: BackendVersion[] | (() => Promise<BackendVersion[]>) | 'scan'
    current?: string
    deps?: Partial<BackendAdvisorDeps>
    store?: (real: OptimalBackendStore) => BackendAdvisorDeps['optimalStore']
  } = {}
): Promise<Harness> {
  const store = await OptimalBackendStore.open(data.layout.core.optimalBackend)
  const events: CoreEvents['backend:better-detected'][] = []
  const fetches: string[] = []
  const proxies: Array<ProxyConfig | null | undefined> = []
  const routes = options.routes ?? ONLINE
  const clock = { now: 1_700_000_000_000 }
  const log = vi.fn<(level: 'info' | 'warn', message: string) => void>()
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    fetches.push(url)
    const handler = routes[url]
    if (!handler) throw new Error(`unrouted ${url}`)
    return handler(init)
  }
  const installed = options.installed
  const advisor = new BackendAdvisor({
    provider,
    layout: data.layout,
    hardware: async () => facts,
    currentVersionBackend: () =>
      options.current ?? (provider === 'llamacpp' ? `${TQ_OLD}/windows-x64-cpu` : 'b10405/win-cpu-x64'),
    optimalStore: options.store ? options.store(store) : store,
    emit: (_name, payload) => {
      events.push(payload)
    },
    fetchFor: (proxy) => {
      proxies.push(proxy)
      return fetchImpl
    },
    ...(installed === 'scan'
      ? {}
      : { installed: typeof installed === 'function' ? installed : async () => installed ?? [] }),
    rocmProbe: async () => ({ gfxTargetVersions: [], hasRuntime: false }),
    now: () => (clock.now += 7),
    platform: 'linux',
    detectionTimeoutMs: 2_000,
    log,
    ...options.deps,
  })
  return { advisor, store, events, fetches, proxies, log, clock }
}

// ---------------------------------------------------------------------------------------------
// catalog
// ---------------------------------------------------------------------------------------------

describe('BackendAdvisor.catalog', () => {
  it('upstream Windows RTX 4090: gates the live manifest, recommends CUDA 13, lists the statics', async () => {
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]))
    const catalog = await h.advisor.catalog({ current_backend: 'b10405/win-cpu-x64' })
    expect(catalog).toMatchObject({
      provider: 'llamacpp-upstream',
      os_type: 'windows',
      arch_suffix: 'x64',
      hardware_source: 'probe',
      source: 'live',
      recommended: `${UP}/win-cuda-13.3-x64`,
      recommended_installed: null,
      installed: [],
    })
    expect(catalog.features).toMatchObject({
      avx2: true,
      cuda12: true,
      cuda13: true,
      vulkan: true,
      rocm: false,
    })
    expect(catalog.supported_backends).toEqual([
      'win-cpu-x64',
      'win-cuda-12.4-x64',
      'win-cuda-13-x64',
      'win-vulkan-x64',
    ])
    expect(catalog.remote.map((b) => b.backend)).toEqual([
      'win-cpu-x64',
      'win-cuda-12.4-x64',
      'win-cuda-13.3-x64',
      'win-rocm-7.14-x64',
      'win-vulkan-x64',
    ])
    // ROCm is gated out (no AMD GPU); the concrete CUDA 13.3 asset passes through its family id.
    expect(catalog.available.map((b) => b.backend)).toEqual([
      'win-cpu-x64',
      'win-cuda-12.4-x64',
      'win-cuda-13.3-x64',
      'win-vulkan-x64',
    ])
    expect(catalog.latest_by_type).toEqual({
      'win-cpu-x64': `${UP}/win-cpu-x64`,
      'win-cuda-12.4-x64': `${UP}/win-cuda-12.4-x64`,
      'win-cuda-13.3-x64': `${UP}/win-cuda-13.3-x64`,
      'win-vulkan-x64': `${UP}/win-vulkan-x64`,
    })
    expect(catalog.static_variants).toEqual([
      'win-cpu-x64',
      'win-cuda-12-x64',
      'win-cuda-13-x64',
      'win-rocm-x64',
      'win-vulkan-x64',
    ])
    expect(catalog.releases).toBeUndefined()

    // The manifest is cached for the session; `force` drops the cache.
    expect((await h.advisor.catalog()).source).toBe('session-cache')
    expect(h.fetches).toHaveLength(1)
    expect((await h.advisor.catalog({ force: true })).source).toBe('live')
    expect(h.fetches).toHaveLength(2)
  })

  it('upstream offline: the bundled baseline, never cached, never thrown', async () => {
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]), { routes: OFFLINE })
    const catalog = await h.advisor.catalog()
    expect(catalog.source).toBe('bundled-baseline')
    expect(catalog.remote.every((b) => b.version === BUNDLED_BASELINE_TAG)).toBe(true)
    expect(catalog.recommended).toMatch(/^b\d+\/win-cuda-13\.\d+-x64$/)
    expect((await h.advisor.catalog()).source).toBe('bundled-baseline')
    expect(h.fetches).toHaveLength(2)
  })

  it('fork Windows RTX 4090: the release index, gated by the fork matrix, with the release notes', async () => {
    const h = await harness('llamacpp', host('windows', [rtx4090]))
    const catalog = await h.advisor.catalog({ app_version: '2.0.47' })
    expect(catalog).toMatchObject({
      provider: 'llamacpp',
      source: 'index',
      recommended: `${TQ}/windows-x64-cuda-13.3`,
      static_variants: [],
    })
    expect(catalog.supported_backends).toEqual([
      'windows-x64-cpu',
      'windows-x64-cuda-12.4',
      'windows-x64-cuda-13.3',
      'windows-x64-vulkan',
    ])
    expect(catalog.available.map((b) => `${b.version}/${b.backend}`)).toEqual([
      `${TQ}/windows-x64-cpu`,
      `${TQ}/windows-x64-cuda-12.4`,
      `${TQ}/windows-x64-cuda-13.3`,
      `${TQ}/windows-x64-vulkan`,
      `${TQ_OLD}/windows-x64-cpu`,
    ])
    expect(catalog.latest_by_type['windows-x64-cpu']).toBe(`${TQ}/windows-x64-cpu`)
    expect(catalog.releases).toEqual([
      {
        tag: TQ,
        title: `TurboQuant ${TQ}`,
        highlights: ['DeepSeek V4 Flash support'],
        variants: FORK_INDEX.releases[0]?.variants,
      },
      { tag: TQ_OLD, variants: FORK_INDEX.releases[1]?.variants },
    ])
  })

  it('recommended_installed is the best build already on disk, and installed rows keep their order', async () => {
    const installed: BackendVersion[] = [
      { version: 'b10405', backend: 'win-cpu-x64', order: 1_700_000 },
      { version: 'b10405', backend: 'win-rocm-7.14-x64', order: 1_700_001 },
    ]
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]), { installed })
    const catalog = await h.advisor.catalog()
    expect(catalog.installed).toEqual(installed)
    expect(catalog.recommended).toBe(`${UP}/win-cuda-13.3-x64`)
    expect(catalog.recommended_installed).toBe('b10405/win-cpu-x64')
    expect(catalog.available).toContainEqual(installed[0])
    // The ROCm pack on disk is not something this host can run: gated out like a remote one.
    expect(catalog.available).not.toContainEqual(installed[1])
  })

  it('scans the data folder when no installed seam is given, and survives a failing one', async () => {
    await data.writeBackend('llamacpp-upstream', 'b10405', 'win-cpu-x64')
    // The pack on disk carries this host's executable name, so the scan looks for that one.
    const scanned = await harness('llamacpp-upstream', host('windows', []), {
      installed: 'scan',
      deps: { platform: process.platform },
    })
    const catalog = await scanned.advisor.catalog()
    expect(catalog.installed).toMatchObject([{ version: 'b10405', backend: 'win-cpu-x64' }])
    expect(catalog.recommended_installed).toBe('b10405/win-cpu-x64')

    const failing = await harness('llamacpp-upstream', host('windows', []), {
      installed: async () => {
        throw new Error('EACCES')
      },
    })
    expect((await failing.advisor.catalog()).installed).toEqual([])
    expect(failing.log).toHaveBeenCalledWith('warn', expect.stringContaining('EACCES'))
  })

  it('hands the proxy to fetchFor and never echoes it', async () => {
    const proxy: ProxyConfig = {
      url: 'http://user:secret@proxy.local:3128',
      username: 'user',
      password: 'secret',
    }
    const h = await harness('llamacpp', host('linux', [rtx4090]))
    const catalog = await h.advisor.catalog({ proxy })
    expect(h.proxies).toEqual([proxy])
    expect(JSON.stringify(catalog)).not.toContain('proxy.local')
  })

  it('throws INVALID_ARGUMENT for an OS the provider has no build for', async () => {
    const h = await harness('llamacpp-upstream', host('freebsd', []))
    await expect(h.advisor.catalog()).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(h.fetches).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// recommend
// ---------------------------------------------------------------------------------------------

describe('BackendAdvisor.recommend', () => {
  const hosts: Array<{
    label: string
    facts: HardwareFacts
    upstream: { outcome: string; ideal?: string; recommended: string }
    fork: { outcome: string; ideal?: string; recommended: string }
  }> = [
    {
      label: 'Windows RTX 4090 (driver 581.42, cc 8.9)',
      facts: host('windows', [rtx4090]),
      upstream: { outcome: 'recommend', ideal: 'win-cuda-13.3-x64', recommended: `${UP}/win-cuda-13.3-x64` },
      fork: {
        outcome: 'recommend',
        ideal: 'windows-x64-cuda-13.3',
        recommended: `${TQ}/windows-x64-cuda-13.3`,
      },
    },
    {
      label: 'Windows GTX 1080 (driver 560, cc 6.1)',
      facts: host('windows', [gtx1080]),
      upstream: { outcome: 'recommend', ideal: 'win-cuda-12.4-x64', recommended: `${UP}/win-cuda-12.4-x64` },
      fork: {
        outcome: 'recommend',
        ideal: 'windows-x64-cuda-12.4',
        recommended: `${TQ}/windows-x64-cuda-12.4`,
      },
    },
    {
      label: 'Windows Radeon RX 7900 XTX (PCI 0x744c, 24 GiB)',
      facts: host('windows', [rx7900xtx]),
      upstream: { outcome: 'recommend', ideal: 'win-rocm-7.14-x64', recommended: `${UP}/win-rocm-7.14-x64` },
      fork: { outcome: 'recommend', ideal: 'windows-x64-vulkan', recommended: `${TQ}/windows-x64-vulkan` },
    },
    {
      label: 'Windows Ryzen, no GPU',
      facts: host('windows', []),
      upstream: { outcome: 'cpu_optimal', recommended: `${UP}/win-cpu-x64` },
      fork: { outcome: 'cpu_optimal', recommended: `${TQ}/windows-x64-cpu` },
    },
    {
      label: 'Linux Ryzen, no GPU',
      facts: host('linux', []),
      upstream: { outcome: 'cpu_optimal', recommended: `${UP}/linux-cpu-x64` },
      fork: { outcome: 'cpu_optimal', recommended: `${TQ}/linux-x64-cpu` },
    },
    {
      label: 'Linux RTX 4090',
      facts: host('linux', [rtx4090]),
      upstream: { outcome: 'recommend', ideal: 'linux-vulkan-x64', recommended: `${UP}/linux-vulkan-x64` },
      fork: { outcome: 'recommend', ideal: 'linux-x64-cuda-13.3', recommended: `${TQ}/linux-x64-cuda-13.3` },
    },
    {
      // Detection says CPU (integrated-only hosts run Vulkan slower than the CPU build); the
      // dropdown mark keeps the app's VRAM-only gate and still points at Vulkan, as it always did.
      label: 'Windows Intel iGPU only',
      facts: host('windows', [intelIgpu]),
      upstream: { outcome: 'cpu_optimal', recommended: `${UP}/win-vulkan-x64` },
      fork: { outcome: 'cpu_optimal', recommended: `${TQ}/windows-x64-vulkan` },
    },
  ]

  for (const provider of ['llamacpp-upstream', 'llamacpp'] as const) {
    it.each(hosts)(`${provider}: $label`, async ({ facts, ...expected }) => {
      const want = provider === 'llamacpp' ? expected.fork : expected.upstream
      const current =
        facts.osType === 'linux'
          ? provider === 'llamacpp'
            ? `${TQ_OLD}/linux-x64-cpu`
            : 'b10405/linux-cpu-x64'
          : undefined
      const h = await harness(provider, facts, current ? { current } : {})
      const response = await h.advisor.recommend({ mode: 'recheck' })

      expect(response.provider).toBe(provider)
      expect(response.mode).toBe('recheck')
      expect(response.outcome).toBe(want.outcome)
      expect(response.elapsed_ms).toBeGreaterThan(0)
      expect(response.revision).toBe(1)
      expect(response.optimal).toEqual(response.record)
      expect(h.store.get(provider)).toEqual({ revision: 1, optimal: response.record })
      expect(response.record?.provider).toBe(provider)

      if (want.outcome === 'recommend') {
        expect(response.detection).toEqual({ kind: 'gpu', backend: want.ideal })
        expect(response.recommendation).toMatchObject({ provider, recommendedBackend: want.recommended })
        expect(response.record).toMatchObject({
          detectionKind: 'gpu',
          idealBackendId: want.ideal,
          recommendedBackend: want.recommended,
        })
        expect(h.events).toEqual([
          {
            provider,
            currentBackend: response.recommendation?.currentBackend,
            recommendedBackend: want.recommended,
            recommendedCategory: response.recommendation?.recommendedCategory,
            version: want.recommended.split('/')[0],
            backendId: want.ideal,
          },
        ])
      } else {
        expect(response.detection).toEqual({ kind: 'cpu-optimal' })
        expect(response.recommendation).toBeNull()
        expect(response.record).toMatchObject({ detectionKind: 'cpu-optimal', recommendedCategory: 'CPU' })
        expect(h.events).toEqual([])
      }
      // The catalog agrees with the detection on what this host should run.
      expect((await h.advisor.catalog()).recommended).toBe(want.recommended)
    })
  }

  it('macOS is `mac`: no detection, no fetch, no write', async () => {
    for (const provider of ['llamacpp-upstream', 'llamacpp'] as const) {
      const h = await harness(provider, host('macos', [], 'arm64'))
      const response = await h.advisor.recommend({ mode: 'recheck' })
      expect(response).toMatchObject({
        provider,
        outcome: 'mac',
        detection: null,
        record: null,
        revision: 0,
        optimal: null,
        recommendation: null,
      })
      expect(h.fetches).toEqual([])
      expect(h.store.get(provider).revision).toBe(0)
    }
  })

  it('refresh writes the record but never emits; recheck emits and forces the catalog', async () => {
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]))
    const refresh = await h.advisor.recommend({ mode: 'refresh' })
    expect(refresh.outcome).toBe('recommend')
    expect(refresh.recommendation?.recommendedBackend).toBe(`${UP}/win-cuda-13.3-x64`)
    expect(refresh.revision).toBe(1)
    expect(h.events).toEqual([])
    expect(h.fetches).toHaveLength(1)

    // A second refresh reuses the session manifest; a recheck refetches it (force defaults on).
    await h.advisor.recommend({ mode: 'refresh' })
    expect(h.fetches).toHaveLength(1)
    const recheck = await h.advisor.recommend({ mode: 'recheck' })
    expect(h.fetches).toHaveLength(2)
    expect(recheck.outcome).toBe('recommend')
    expect(recheck.revision).toBe(3)
    expect(h.events).toHaveLength(1)
    // ... unless the request says otherwise.
    await h.advisor.recommend({ mode: 'recheck', force: false })
    expect(h.fetches).toHaveLength(2)
    await h.advisor.recommend({ mode: 'refresh', force: true })
    expect(h.fetches).toHaveLength(3)
  })

  it('already_optimal: upstream needs the same type, the fork the same category', async () => {
    const up = await harness('llamacpp-upstream', host('windows', [rtx4090]), {
      current: `${UP}/win-cuda-13.3-x64`,
    })
    const same = await up.advisor.recommend({ mode: 'recheck' })
    expect(same.outcome).toBe('already_optimal')
    expect(same.record).toMatchObject({ recommendedBackend: `${UP}/win-cuda-13.3-x64` })
    expect(up.events).toEqual([])

    // An older tag of the same type is already optimal by type+category; a 13.1 install is an
    // in-family upgrade and gets a recommendation.
    const older = await harness('llamacpp-upstream', host('windows', [rtx4090]), {
      current: 'b10405/win-cuda-13.3-x64',
    })
    expect((await older.advisor.recommend({ mode: 'recheck' })).outcome).toBe('already_optimal')
    const minor = await harness('llamacpp-upstream', host('windows', [rtx4090]), {
      current: 'b10405/win-cuda-13.1-x64',
    })
    const upgrade = await minor.advisor.recommend({ mode: 'recheck' })
    expect(upgrade.outcome).toBe('recommend')
    expect(upgrade.recommendation?.recommendedBackend).toBe(`${UP}/win-cuda-13.3-x64`)

    // The fork: a legacy janhq CUDA 13 id is the same category, so already optimal, and the record
    // carries no recommendedBackend (the current build is not a `<tag>/<ideal id>`).
    const fork = await harness('llamacpp', host('windows', [rtx4090]), { current: 'b9000/win-cuda-13.3-x64' })
    const legacy = await fork.advisor.recommend({ mode: 'recheck' })
    expect(legacy.outcome).toBe('already_optimal')
    expect(legacy.record).not.toHaveProperty('recommendedBackend')
    expect(fork.store.get('llamacpp').optimal).toEqual(legacy.record)
    const forkCuda12 = await harness('llamacpp', host('windows', [rtx4090]), {
      current: `${TQ_OLD}/windows-x64-cuda-12.4`,
    })
    expect((await forkCuda12.advisor.recommend({ mode: 'recheck' })).outcome).toBe('recommend')
  })

  it("no_catalog_entry on a recheck clears the upstream store (the extension's rule)", async () => {
    // Linux detection does not consult the catalog, so a Vulkan host whose manifest carries no
    // Vulkan asset and whose current backend has no tag to borrow resolves to nothing.
    const h = await harness('llamacpp-upstream', host('linux', [rtx4090]), {
      current: '',
      routes: {
        [LLAMACPP_BACKEND_MANIFEST_URL]: () =>
          json({ tag_name: UP, assets: [{ name: `llama-${UP}-bin-ubuntu-x64.tar.gz` }] }),
      },
    })
    const seed: OptimalBackendCacheRecord = {
      schemaVersion: 1,
      provider: 'llamacpp-upstream',
      detectedAt: 1,
      detectionKind: 'cpu-optimal',
      currentBackend: 'b1/linux-cpu-x64',
      recommendedCategory: 'CPU',
    }
    await h.store.set('llamacpp-upstream', seed, 0)

    const response = await h.advisor.recommend({ mode: 'recheck' })
    expect(response.outcome).toBe('no_catalog_entry')
    expect(response.record).toMatchObject({ detectionKind: 'gpu', idealBackendId: 'linux-vulkan-x64' })
    expect(response.record).not.toHaveProperty('recommendedBackend')
    expect(response).toMatchObject({ revision: 2, optimal: null, recommendation: null })
    expect(h.store.get('llamacpp-upstream')).toEqual({ revision: 2, optimal: null })
    expect(h.events).toEqual([])

    // A refresh keeps caching the verdict without a target, as `refreshOptimalBackendCache` did.
    const refresh = await h.advisor.recommend({ mode: 'refresh' })
    expect(refresh.outcome).toBe('no_catalog_entry')
    expect(h.store.get('llamacpp-upstream').optimal).toEqual(refresh.record)
  })

  it('detection_failed leaves the store untouched: empty catalog and a timed-out detection', async () => {
    const seed: OptimalBackendCacheRecord = {
      schemaVersion: 1,
      provider: 'llamacpp-upstream',
      detectedAt: 1,
      detectionKind: 'gpu',
      currentBackend: 'b10405/win-cpu-x64',
      idealBackendId: 'win-cuda-13.3-x64',
      recommendedBackend: 'b10500/win-cuda-13.3-x64',
      recommendedCategory: 'CUDA 13',
    }
    const empty = await harness('llamacpp-upstream', host('windows', [rtx4090]), {
      routes: { [LLAMACPP_BACKEND_MANIFEST_URL]: () => json({ tag_name: 'b1', assets: [] }) },
    })
    await empty.store.set('llamacpp-upstream', seed, 0)
    const response = await empty.advisor.recommend({ mode: 'recheck' })
    expect(response).toMatchObject({
      outcome: 'detection_failed',
      detection: { kind: 'detection-failed' },
      record: null,
      revision: 1,
      optimal: seed,
      recommendation: null,
    })
    expect(empty.store.get('llamacpp-upstream')).toEqual({ revision: 1, optimal: seed })
    expect(empty.events).toEqual([])

    const hanging = await harness('llamacpp', host('windows', [rtx4090]), {
      routes: {
        [TURBOQUANT_RELEASE_INDEX_URL]: () => new Promise<Response>(() => {}),
        [TURBOQUANT_LATEST_RELEASE_URL]: () => new Promise<Response>(() => {}),
        [TURBOQUANT_LEGACY_MANIFEST_URL]: () => new Promise<Response>(() => {}),
      },
      deps: { detectionTimeoutMs: 30 },
    })
    const timedOut = await hanging.advisor.recommend({ mode: 'refresh' })
    expect(timedOut.outcome).toBe('detection_failed')
    expect(hanging.store.get('llamacpp').revision).toBe(0)
    expect(hanging.log).toHaveBeenCalledWith('warn', expect.stringMatching(/timed out after 30ms/))
  })

  it('assume_no_gpu records cpu-optimal without touching the network', async () => {
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]))
    const response = await h.advisor.recommend({ mode: 'refresh', assume_no_gpu: true })
    expect(response.outcome).toBe('cpu_optimal')
    expect(response.detection).toEqual({ kind: 'cpu-optimal' })
    expect(h.fetches).toEqual([])
    expect(h.store.get('llamacpp-upstream').optimal).toMatchObject({ detectionKind: 'cpu-optimal' })
  })

  it('retries once when the store moved underneath the pass', async () => {
    let bumped = false
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]), {
      store: (real) => ({
        get: (provider) => real.get(provider),
        set: async (provider, value, expected) => {
          if (!bumped) {
            bumped = true
            // Someone else (the app's PUT) writes first; our expected revision is now stale.
            await real.set(provider, null, real.get(provider).revision)
          }
          return real.set(provider, value, expected)
        },
      }),
    })
    const response = await h.advisor.recommend({ mode: 'recheck' })
    expect(response.outcome).toBe('recommend')
    expect(response.revision).toBe(2)
    expect(h.store.get('llamacpp-upstream')).toEqual({ revision: 2, optimal: response.record })
  })

  it('gives up after a second conflict and reports the store as it stands', async () => {
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]), {
      store: (real) => ({
        get: (provider) => real.get(provider),
        set: async (provider) => ({ status: 'conflict', current: real.get(provider) }),
      }),
    })
    const response = await h.advisor.recommend({ mode: 'recheck' })
    expect(response.outcome).toBe('recommend')
    expect(response.revision).toBe(0)
    expect(response.optimal).toBeNull()
    expect(h.log).toHaveBeenCalledWith('warn', expect.stringMatching(/moved twice/))
  })

  it('shares one in-flight pass between concurrent callers', async () => {
    let release!: (r: Response) => void
    const pending = new Promise<Response>((r) => (release = r))
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]), {
      routes: { [LLAMACPP_BACKEND_MANIFEST_URL]: () => pending },
    })
    const a = h.advisor.recommend({ mode: 'recheck' })
    const b = h.advisor.recommend({ mode: 'recheck' })
    release(json(UPSTREAM_MANIFEST))
    expect(await a).toBe(await b)
    expect(h.fetches).toHaveLength(1)
    expect(h.events).toHaveLength(1)
    expect(h.store.get('llamacpp-upstream').revision).toBe(1)
  })

  it('probes Windows tiers through listDevices and degrades a broken tier', async () => {
    const installed: BackendVersion[] = [{ version: 'b10405', backend: 'win-cuda-13.3-x64', order: 1 }]
    const listDevices = vi.fn(async () => [])
    // No GPU corroborates CUDA for a probe that lists nothing → the tier is broken → CUDA 12 next,
    // which is not installed and therefore unverified.
    const facts = host('windows', [{ ...rtx4090, vendor: 'Unknown (vendor_id: 0)' }])
    const h = await harness('llamacpp-upstream', facts, { installed, deps: { listDevices } })
    const response = await h.advisor.recommend({ mode: 'recheck' })
    expect(listDevices).toHaveBeenCalledWith(installed[0])
    expect(response.detection).toEqual({ kind: 'gpu', backend: 'win-cuda-12.4-x64' })

    // Without a listDevices seam every tier stays unverified and the top one wins.
    const blind = await harness('llamacpp-upstream', facts, { installed })
    expect((await blind.advisor.recommend({ mode: 'recheck' })).detection).toEqual({
      kind: 'gpu',
      backend: 'win-cuda-13.3-x64',
    })
  })

  it('uses the ROCm probe for the fork on Linux only', async () => {
    const rocmProbe = vi.fn(async () => ({ gfxTargetVersions: [110000], hasRuntime: true }))
    const fork = await harness('llamacpp', host('linux', [rx7900xtx]), {
      current: `${TQ_OLD}/linux-x64-cpu`,
      deps: { rocmProbe },
    })
    const response = await fork.advisor.recommend({ mode: 'recheck' })
    expect(response.detection).toEqual({ kind: 'gpu', backend: 'linux-x64-rocm' })
    expect(response.recommendation?.recommendedBackend).toBe(`${TQ}/linux-x64-rocm`)
    expect(rocmProbe).toHaveBeenCalled()

    const upstream = await harness('llamacpp-upstream', host('linux', [rx7900xtx]), {
      current: 'b1/linux-cpu-x64',
      deps: { rocmProbe },
    })
    rocmProbe.mockClear()
    expect((await upstream.advisor.recommend({ mode: 'recheck' })).detection).toEqual({
      kind: 'gpu',
      backend: 'linux-vulkan-x64',
    })
    expect(rocmProbe).not.toHaveBeenCalled()

    const failing = await harness('llamacpp', host('linux', [rx7900xtx]), {
      current: `${TQ_OLD}/linux-x64-cpu`,
      deps: {
        rocmProbe: async () => {
          throw new Error('sysfs')
        },
      },
    })
    expect((await failing.advisor.recommend({ mode: 'recheck' })).detection).toEqual({
      kind: 'gpu',
      backend: 'linux-x64-vulkan',
    })
    expect(failing.log).toHaveBeenCalledWith('warn', expect.stringContaining('sysfs'))
  })

  it('takes the proxy and the current backend from the request', async () => {
    const proxy: ProxyConfig = { url: 'socks5://proxy.local:1080' }
    const h = await harness('llamacpp', host('windows', [rtx4090]))
    const response = await h.advisor.recommend({
      mode: 'recheck',
      proxy,
      current_backend: `\uFEFF${TQ}/windows-x64-cuda-13.3`,
    })
    expect(h.proxies).toEqual([proxy])
    expect(response.outcome).toBe('already_optimal')
    expect(response.record?.currentBackend).toBe(`${TQ}/windows-x64-cuda-13.3`)
    expect(JSON.stringify(response)).not.toContain('proxy.local')
  })

  it('rejects a mode it does not know', async () => {
    const h = await harness('llamacpp-upstream', host('windows', []))
    await expect(h.advisor.recommend({ mode: 'now' as 'refresh' })).rejects.toBeInstanceOf(AtomicCoreError)
  })
})

// ---------------------------------------------------------------------------------------------
// checkUpdates
// ---------------------------------------------------------------------------------------------

describe('BackendAdvisor.checkUpdates', () => {
  it('a missing version_backend is no update, not an error', async () => {
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]), { current: '' })
    for (const current of ['', 'none', 'b10405', '\uFEFFnone']) {
      expect(await h.advisor.checkUpdates({ current })).toEqual({
        provider: 'llamacpp-upstream',
        current: current.replace(/\uFEFF/g, ''),
        current_kind: 'missing',
        update_needed: false,
        new_version: '0',
        target_backend: null,
        same_family: false,
        offer: null,
      })
    }
    expect(await h.advisor.checkUpdates()).toMatchObject({ current: '', current_kind: 'missing' })
  })

  it('a parked latest/<id> sentinel resolves to its concrete target in the same family', async () => {
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]))
    expect(await h.advisor.checkUpdates({ current: 'latest/win-cuda-13-x64' })).toEqual({
      provider: 'llamacpp-upstream',
      current: 'latest/win-cuda-13-x64',
      current_kind: 'sentinel',
      update_needed: true,
      new_version: UP,
      target_backend: `${UP}/win-cuda-13.3-x64`,
      same_family: true,
      offer: `${UP}/win-cuda-13.3-x64`,
    })
    // A sentinel this host cannot run (ROCm on an NVIDIA box) resolves to nothing.
    expect(await h.advisor.checkUpdates({ current: 'latest/win-rocm-x64' })).toMatchObject({
      current_kind: 'sentinel',
      update_needed: false,
      target_backend: null,
      same_family: true,
      offer: null,
    })
  })

  it('offers the newest same-type build, and nothing when already on it', async () => {
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]))
    expect(await h.advisor.checkUpdates({ current: 'b10405/win-cuda-13.3-x64' })).toEqual({
      provider: 'llamacpp-upstream',
      current: 'b10405/win-cuda-13.3-x64',
      current_kind: 'concrete',
      update_needed: true,
      new_version: UP,
      target_backend: `${UP}/win-cuda-13.3-x64`,
      same_family: true,
      offer: `${UP}/win-cuda-13.3-x64`,
    })
    expect(await h.advisor.checkUpdates({ current: `${UP}/win-cuda-13.3-x64` })).toMatchObject({
      update_needed: false,
      new_version: '0',
      target_backend: null,
      same_family: false,
      offer: null,
    })
    // A legacy CPU id lands on its migrated form: same family.
    expect(await h.advisor.checkUpdates({ current: 'b9000/win-noavx-x64' })).toMatchObject({
      target_backend: `${UP}/win-cpu-x64`,
      same_family: true,
      offer: `${UP}/win-cpu-x64`,
    })
  })

  it('fork: same-type tag bumps are offered, and force refetches the index', async () => {
    const h = await harness('llamacpp', host('linux', [rtx4090]))
    expect(await h.advisor.checkUpdates({ current: `${TQ_OLD}/linux-x64-vulkan` })).toEqual({
      provider: 'llamacpp',
      current: `${TQ_OLD}/linux-x64-vulkan`,
      current_kind: 'concrete',
      update_needed: true,
      new_version: TQ,
      target_backend: `${TQ}/linux-x64-vulkan`,
      same_family: true,
      offer: `${TQ}/linux-x64-vulkan`,
    })
    expect(h.fetches).toHaveLength(1)
    await h.advisor.checkUpdates({ current: `${TQ}/linux-x64-vulkan` })
    expect(h.fetches).toHaveLength(1)
    await h.advisor.checkUpdates({ current: `${TQ}/linux-x64-vulkan`, force: true })
    expect(h.fetches).toHaveLength(2)
  })

  it('is quiet offline with an empty catalog and forwards the proxy', async () => {
    const proxy: ProxyConfig = { url: 'http://proxy.local:3128' }
    const h = await harness('llamacpp', host('linux', [rtx4090]), { routes: OFFLINE })
    const response = await h.advisor.checkUpdates({ current: `${TQ_OLD}/linux-x64-vulkan`, proxy })
    expect(response).toMatchObject({
      update_needed: false,
      new_version: '0',
      target_backend: null,
      offer: null,
    })
    expect(h.proxies).toEqual([proxy])
  })

  it('reuses the session cache between checks, and the manifest cache is the one it was given', async () => {
    const manifestCache = new ManifestSessionCache()
    manifestCache.set(UPSTREAM_MANIFEST)
    const h = await harness('llamacpp-upstream', host('windows', [rtx4090]), {
      routes: OFFLINE,
      deps: { manifestCache },
    })
    const response = await h.advisor.checkUpdates({ current: 'b10405/win-cpu-x64' })
    expect(response.target_backend).toBe(`${UP}/win-cpu-x64`)
    expect(h.fetches).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

describe('classifyCurrent / refreshOutcome / recommendationOf', () => {
  it.each([
    ['', 'missing'],
    ['none', 'missing'],
    ['b10405', 'missing'],
    ['latest/win-cpu-x64', 'sentinel'],
    ['\uFEFFb10405/win-cpu-x64', 'concrete'],
  ])('classifyCurrent(%j) = %s', (current, expected) => {
    expect(classifyCurrent(current)).toBe(expected)
  })

  const gpu: OptimalBackendCacheRecord = {
    schemaVersion: 1,
    provider: 'llamacpp-upstream',
    detectedAt: 1,
    detectionKind: 'gpu',
    currentBackend: 'b10405/win-cpu-x64',
    idealBackendId: 'win-cuda-13.3-x64',
    recommendedBackend: `${UP}/win-cuda-13.3-x64`,
    recommendedCategory: 'CUDA 13',
  }
  it('names a refresh outcome and its payload from the record alone', () => {
    expect(refreshOutcome(null, 'x')).toBe('cpu_optimal')
    expect(refreshOutcome({ ...gpu, detectionKind: 'cpu-optimal' } as OptimalBackendCacheRecord, 'x')).toBe(
      'cpu_optimal'
    )
    const { recommendedBackend: _r, ...noTarget } = gpu
    expect(refreshOutcome(noTarget as OptimalBackendCacheRecord, 'x')).toBe('no_catalog_entry')
    expect(refreshOutcome(gpu, `${UP}/win-cuda-13.3-x64`)).toBe('already_optimal')
    expect(refreshOutcome(gpu, 'b10405/win-cpu-x64')).toBe('recommend')

    expect(recommendationOf(gpu, 'llamacpp-upstream')).toEqual({
      currentBackend: 'b10405/win-cpu-x64',
      recommendedBackend: `${UP}/win-cuda-13.3-x64`,
      recommendedCategory: 'CUDA 13',
      provider: 'llamacpp-upstream',
      version: UP,
      backendId: 'win-cuda-13.3-x64',
    })
    expect(recommendationOf(null, 'llamacpp')).toBeNull()
    expect(recommendationOf(noTarget as OptimalBackendCacheRecord, 'llamacpp')).toBeNull()
    expect(
      recommendationOf({ ...gpu, currentBackend: gpu.recommendedBackend as string }, 'llamacpp')
    ).toBeNull()
  })
})

// ---------------------------------------------------------------------------------------------
// atomic-prism
// ---------------------------------------------------------------------------------------------

const P1 = 'prism-b10754-2459f68'
const P2 = 'prism-b10800-aaaaaaa'
const prismAsset = (backend: string, validation: 'approved' | 'candidate' = 'approved', extra = {}) => ({
  backend,
  name: `${backend}.zip`,
  size: 100,
  sha256: 'a'.repeat(64),
  validation,
  ...extra,
})
const prismRelease = (tag: string, assets: ReturnType<typeof prismAsset>[], extra = {}) => ({
  tag,
  commit: 'b'.repeat(40),
  published_at: '2026-10-02T00:00:00Z',
  min_core_version: '0.10.0',
  notes_url: `https://example.test/${tag}`,
  capabilities: ['pq2_0'],
  assets,
  ...extra,
})
const prismManifest = (releases: ReturnType<typeof prismRelease>[]): PrismManifest => ({
  schema_version: 1,
  updated_at: '2026-10-05T00:00:00Z',
  upstream_repo: 'PrismML-Eng/llama.cpp',
  releases: releases as PrismManifest['releases'],
})
const PRISM_DOC = prismManifest([
  prismRelease(
    P2,
    [
      prismAsset('win-cuda-13.3-x64', 'approved', { companion_backend: 'win-cudart-13.3-x64' }),
      prismAsset('win-cudart-13.3-x64', 'approved', { companion: true, size: 50 }),
      prismAsset('win-cpu-x64', 'candidate'),
    ],
    { notes: 'Faster PQ2_0' }
  ),
  prismRelease(P1, [
    prismAsset('win-cuda-13.3-x64', 'approved', { companion_backend: 'win-cudart-13.3-x64' }),
    prismAsset('win-cudart-13.3-x64', 'approved', { companion: true }),
    prismAsset('win-cpu-x64'),
  ]),
])

describe('BackendAdvisor — atomic-prism', () => {
  const prismHarness = (doc: PrismManifest, deps: Partial<BackendAdvisorDeps> = {}) =>
    harness('atomic-prism', host('windows', [rtx4090]), {
      routes: { [PRISM_MANIFEST_URL]: () => json(doc) },
      current: `${P1}/win-cuda-13.3-x64`,
      deps: { coreVersion: '0.10.0', ...deps },
    })

  it('serves the conf manifest gated by approval and hardware, with release notes', async () => {
    const h = await prismHarness(PRISM_DOC)
    const catalog = await h.advisor.catalog()
    expect(catalog.source).toBe('live')
    expect(catalog.available).toEqual([
      { version: P2, backend: 'win-cuda-13.3-x64' },
      { version: P1, backend: 'win-cuda-13.3-x64' },
      { version: P1, backend: 'win-cpu-x64' },
    ])
    expect(catalog.recommended).toBe(`${P2}/win-cuda-13.3-x64`)
    expect(catalog.releases?.[0]).toMatchObject({
      tag: P2,
      notes: 'Faster PQ2_0',
      notes_url: `https://example.test/${P2}`,
    })
  })

  it('offers candidates only on opt-in', async () => {
    const h = await prismHarness(PRISM_DOC, { allowCandidateBuilds: () => true })
    expect((await h.advisor.catalog()).available).toContainEqual({ version: P2, backend: 'win-cpu-x64' })
  })

  it('keeps candidates hidden when the opt-in cannot be read', async () => {
    const h = await prismHarness(PRISM_DOC, {
      allowCandidateBuilds: () => {
        throw new Error('settings gone')
      },
    })
    expect((await h.advisor.catalog()).available).not.toContainEqual({ version: P2, backend: 'win-cpu-x64' })
    expect(h.log).toHaveBeenCalledWith('warn', 'catalog: allow_candidate_builds unreadable: settings gone')
  })

  it('rechecks the hardware against the PrismML matrix', async () => {
    const onCuda = await prismHarness(PRISM_DOC)
    const same = await onCuda.advisor.recommend({ mode: 'recheck' })
    expect(same).toMatchObject({ provider: 'atomic-prism', outcome: 'already_optimal' })
    expect(same.detection).toEqual({ kind: 'gpu', backend: 'win-cuda-13.3-x64' })

    const onCpu = await harness('atomic-prism', host('windows', [rtx4090]), {
      routes: { [PRISM_MANIFEST_URL]: () => json(PRISM_DOC) },
      current: `${P1}/win-cpu-x64`,
      deps: { coreVersion: '0.10.0' },
    })
    const upgrade = await onCpu.advisor.recommend({ mode: 'recheck' })
    expect(upgrade).toMatchObject({ provider: 'atomic-prism', outcome: 'recommend' })
    expect(upgrade.recommendation?.recommendedBackend).toBe(`${P2}/win-cuda-13.3-x64`)
  })

  it('reports a newer approved build with its notes and download size', async () => {
    const h = await prismHarness(PRISM_DOC)
    const response = await h.advisor.checkUpdates()
    expect(response).toMatchObject({
      update_needed: true,
      offer: `${P2}/win-cuda-13.3-x64`,
      reason: 'newer',
      notes: 'Faster PQ2_0',
      notes_url: `https://example.test/${P2}`,
      download_size: 150,
    })
  })

  it('says model_requires when the caller needs the newer build', async () => {
    const h = await prismHarness(PRISM_DOC)
    expect((await h.advisor.checkUpdates({ requires_build: 10800 })).reason).toBe('model_requires')
  })

  it('moves a user off a withdrawn release, even to an older build', async () => {
    const doc = prismManifest([
      prismRelease(P2, [prismAsset('win-cpu-x64')], { withdrawn: { reason: 'crashes on load' } }),
      prismRelease(P1, [prismAsset('win-cpu-x64')]),
    ])
    const h = await prismHarness(doc)
    const response = await h.advisor.checkUpdates({ current: `${P2}/win-cpu-x64` })
    expect(response).toMatchObject({
      current_withdrawn: { reason: 'crashes on load' },
      offer: `${P1}/win-cpu-x64`,
      reason: 'withdrawn',
    })
    expect((await h.advisor.catalog()).releases?.[0]).toMatchObject({
      tag: P2,
      variants: [],
      withdrawn: { reason: 'crashes on load' },
    })
  })

  it('ignores releases that need a newer core', async () => {
    const doc = prismManifest([
      prismRelease(P2, [prismAsset('win-cpu-x64')], { min_core_version: '9.0.0' }),
      prismRelease(P1, [prismAsset('win-cpu-x64')]),
    ])
    const h = await prismHarness(doc)
    const response = await h.advisor.checkUpdates({ current: `${P1}/win-cpu-x64` })
    expect(response.update_needed).toBe(false)
    expect((await h.advisor.catalog()).releases?.map((r) => r.tag)).toEqual([P1])
  })
})

describe('prismCatalogReleases / prismUpdateResponse', () => {
  const offer = { coreVersion: '0.10.0', allowCandidates: false }
  it('lists runnable releases newest first with only offered variants', () => {
    expect(prismCatalogReleases(PRISM_DOC, offer).map((r) => [r.tag, r.variants.map((v) => v.id)])).toEqual([
      [P2, ['win-cuda-13.3-x64']],
      [P1, ['win-cuda-13.3-x64', 'win-cpu-x64']],
    ])
  })
  it('leaves an answer without an offer untouched', () => {
    const base = {
      provider: 'atomic-prism' as const,
      current: `${P2}/win-cuda-13.3-x64`,
      current_kind: 'concrete' as const,
      update_needed: false,
      new_version: '0',
      target_backend: null,
      same_family: false,
      offer: null,
    }
    expect(prismUpdateResponse(base, PRISM_DOC, offer)).toEqual(base)
  })
})
