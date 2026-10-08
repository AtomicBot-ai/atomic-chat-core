import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import type {
  BackendCatalogResponse,
  BackendUpdateCheckResponse,
  EngineBuildCatalog,
  EngineBuildUpdateCheck,
  RuntimeDescriptor,
} from '../contracts/index.js'
import type { InstallationRecord } from '../runtime/environment/index.js'
import { collectEngineVersions, engineBuildVersions, llamacppVersions, managedVersions } from './versions.js'
import type { LlamacppVersionsDeps, ManagedVersionsDeps } from './versions.js'

function catalog(over: Partial<BackendCatalogResponse> = {}): BackendCatalogResponse {
  return {
    provider: 'llamacpp-upstream',
    os_type: 'windows',
    arch_suffix: 'x64',
    hardware_source: 'probe',
    features: {
      cuda11: false,
      cuda12: true,
      cuda13: false,
      vulkan: true,
      rocm: false,
      avx: true,
      avx2: true,
      avx512: false,
    },
    supported_backends: ['win-cuda12-x64', 'win-cpu-x64'],
    remote: [],
    installed: [],
    available: [
      { version: 'b11500', backend: 'win-cuda12-x64' },
      { version: 'b11500', backend: 'win-cpu-x64' },
      { version: 'b11443', backend: 'win-cuda12-x64' },
    ],
    recommended: 'b11500/win-cuda12-x64',
    recommended_installed: null,
    latest_by_type: {},
    static_variants: [],
    source: 'live',
    ...over,
  }
}

function updates(over: Partial<BackendUpdateCheckResponse> = {}): BackendUpdateCheckResponse {
  return {
    provider: 'llamacpp-upstream',
    current: 'b11443/win-cuda12-x64',
    current_kind: 'concrete',
    update_needed: true,
    new_version: 'b11500',
    target_backend: 'b11500/win-cuda12-x64',
    same_family: true,
    offer: 'b11500/win-cuda12-x64',
    ...over,
  }
}

function llama(over: Partial<LlamacppVersionsDeps> = {}): LlamacppVersionsDeps {
  return {
    engine: 'llamacpp-upstream',
    current: () => 'b11443/win-cuda12-x64',
    checkUpdates: async () => updates(),
    catalog: async () => catalog(),
    listInstalled: async (current) =>
      ['b11443/win-cuda12-x64', 'b11443/win-cpu-x64', 'b11400/win-vulkan-x64'].map((vb) => {
        const [version = '', backend = ''] = vb.split('/')
        return { version, backend, path: `/packs/${vb}`, active: vb === current }
      }),
    bundledPack: async () => ({ version: 'b11443', backend: 'win-cpu-x64' }),
    inUse: async () => false,
    ...over,
  }
}

describe('llamacppVersions', () => {
  it('describes every pack and offers a same-family update as a swap', async () => {
    const entry = await llamacppVersions(
      llama({ inUse: async (v, b) => `${v}/${b}` === 'b11400/win-vulkan-x64' }),
      {}
    )
    expect(entry).toMatchObject({
      engine: 'llamacpp-upstream',
      kind: 'llamacpp',
      active_choice: 'client',
      active: { version: 'b11443', variant: 'win-cuda12-x64' },
      latest: { version: 'b11500', variant: 'win-cuda12-x64' },
      update: { needed: true, target: { version: 'b11500', variant: 'win-cuda12-x64' }, apply: 'swap' },
      source: 'remote',
      source_error: null,
      error: null,
    })
    expect(entry.update.blocked_reason).toBeUndefined()
    expect(entry.builds).toEqual([
      {
        version: 'b11443',
        variant: 'win-cuda12-x64',
        origin: 'downloaded',
        active: true,
        in_use: false,
        removable: false,
        not_removable_reason: 'active',
      },
      {
        version: 'b11443',
        variant: 'win-cpu-x64',
        origin: 'bundled',
        active: false,
        in_use: false,
        removable: false,
        not_removable_reason: 'bundled',
      },
      {
        version: 'b11400',
        variant: 'win-vulkan-x64',
        origin: 'downloaded',
        active: false,
        in_use: true,
        removable: false,
        not_removable_reason: 'in-use',
      },
    ])
  })

  it('reads version_backend with a BOM as the active build', async () => {
    const entry = await llamacppVersions(llama({ current: () => '\uFEFFb11443/win-cuda12-x64' }), {})
    expect(entry.active).toEqual({ version: 'b11443', variant: 'win-cuda12-x64' })
    expect(entry.builds[0]?.active).toBe(true)
  })

  it('reports an active build that is also in use as active', async () => {
    const entry = await llamacppVersions(llama({ inUse: async () => true }), {})
    expect(entry.builds[0]).toMatchObject({ active: true, in_use: true, not_removable_reason: 'active' })
  })

  it('blocks a change of family', async () => {
    const entry = await llamacppVersions(
      llama({
        checkUpdates: async () =>
          updates({ target_backend: 'b11500/win-vulkan-x64', same_family: false, offer: null }),
      }),
      {}
    )
    expect(entry.update).toEqual({
      needed: false,
      target: null,
      apply: 'swap',
      blocked_reason: 'family-change',
    })
    expect(entry.latest).toEqual({ version: 'b11500', variant: 'win-cuda12-x64' })
  })

  it("blocks an unstable TurboQuant tag, with the size from the fork's release index", async () => {
    const entry = await llamacppVersions(
      llama({
        engine: 'llamacpp',
        current: () => 'b9000-1.6.0/win-cuda-12-x64',
        listInstalled: async () => [
          { version: 'b9000-1.6.0', backend: 'win-cuda-12-x64', path: '/p', active: true },
        ],
        bundledPack: async () => null,
        checkUpdates: async () =>
          updates({
            provider: 'llamacpp',
            target_backend: 'dev-latest/win-cuda-12-x64',
            same_family: true,
            offer: null,
          }),
        catalog: async () =>
          catalog({
            provider: 'llamacpp',
            source: 'index',
            available: [{ version: 'b9100-1.7.0', backend: 'win-cuda-12-x64' }],
            releases: [{ tag: 'b9100-1.7.0', variants: [{ id: 'win-cuda-12-x64', size: 300 }] }],
          }),
      }),
      {}
    )
    expect(entry.update).toMatchObject({ needed: false, target: null, blocked_reason: 'unstable' })
    expect(entry.latest).toEqual({ version: 'b9100-1.7.0', variant: 'win-cuda-12-x64', download_bytes: 300 })
  })

  it('offers no update without an active build', async () => {
    const entry = await llamacppVersions(
      llama({
        current: () => 'latest/win-cuda12-x64',
        checkUpdates: async () => updates({ current_kind: 'sentinel' }),
      }),
      {}
    )
    expect(entry.active).toBeNull()
    expect(entry.update).toEqual({ needed: false, target: null, apply: 'swap' })
  })

  it('answers from the cache without the network, and says so', async () => {
    const entry = await llamacppVersions(
      llama({ catalog: async () => catalog({ source: 'bundled-baseline' }) }),
      {
        force: true,
      }
    )
    expect(entry.source).toBe('cache')
    expect(entry.source_error).toMatch(/not reachable/)
    expect(entry.error).toBeNull()
    expect(entry.update.needed).toBe(true)
  })

  it('reads the catalog with force first, then asks the update check from that read', async () => {
    const seen: unknown[] = []
    await llamacppVersions(
      llama({
        checkUpdates: async (request) => {
          seen.push(['updates', request])
          return updates()
        },
        catalog: async (request) => {
          seen.push(['catalog', request])
          return catalog()
        },
      }),
      { force: true, app_version: '2.1.0' }
    )
    expect(seen).toEqual([
      [
        'catalog',
        { current_backend: 'b11443/win-cuda12-x64', force: true, app_version: '2.1.0', proxy: null },
      ],
      ['updates', { current: 'b11443/win-cuda12-x64', force: false, app_version: '2.1.0', proxy: null }],
    ])
  })

  it('says the source is unavailable when there is neither network nor cache', async () => {
    const entry = await llamacppVersions(
      llama({
        catalog: async () => catalog({ source: 'none', available: [] }),
        checkUpdates: async () => updates({ update_needed: false, target_backend: null, offer: null }),
      }),
      {}
    )
    expect(entry).toMatchObject({
      source: null,
      latest: null,
      update: { needed: false, target: null, blocked_reason: 'source-unavailable' },
      error: { code: 'UPSTREAM_ERROR' },
    })
  })
})

describe('engineBuildVersions', () => {
  const build = (tag: string, origin: 'downloaded' | 'bundled', active: boolean, inUse = false) => ({
    tag,
    backend_id: 'macos-arm64',
    origin,
    installed_at_ms: 1,
    removable: origin === 'downloaded',
    in_use: inUse,
    active,
  })
  const sdCatalog = (over: Partial<EngineBuildCatalog> = {}): EngineBuildCatalog => ({
    engine: 'mlx',
    manifest: {
      tag: 'v2',
      published_at: '2026-10-01T00:00:00Z',
      source: 'remote',
      fetched_at: 1,
      error: null,
    },
    manifest_error: null,
    host_backend_id: 'macos-arm64',
    host_reason: null,
    installed: [build('v1', 'bundled', true)],
    active: build('v1', 'bundled', true),
    ...over,
  })
  const check = (over: Partial<EngineBuildUpdateCheck> = {}): EngineBuildUpdateCheck => ({
    update_needed: true,
    current: { tag: 'v1', backend_id: 'macos-arm64', origin: 'bundled' },
    target: {
      tag: 'v2',
      backend_id: 'macos-arm64',
      published_at: '2026-10-01T00:00:00Z',
      download_bytes: 42,
    },
    ...over,
  })

  it('maps the catalog and the update check; the core picks the active build', async () => {
    const entry = await engineBuildVersions(
      { engine: 'mlx', catalog: async () => sdCatalog(), checkUpdates: async () => check() },
      {}
    )
    expect(entry).toEqual({
      engine: 'mlx',
      kind: 'engine-build',
      active_choice: 'core',
      builds: [
        {
          version: 'v1',
          variant: 'macos-arm64',
          origin: 'bundled',
          active: true,
          in_use: false,
          removable: false,
          not_removable_reason: 'active',
        },
      ],
      active: { version: 'v1', variant: 'macos-arm64' },
      latest: {
        version: 'v2',
        variant: 'macos-arm64',
        published_at: '2026-10-01T00:00:00Z',
        download_bytes: 42,
      },
      update: {
        needed: true,
        target: {
          version: 'v2',
          variant: 'macos-arm64',
          published_at: '2026-10-01T00:00:00Z',
          download_bytes: 42,
        },
        apply: 'swap',
      },
      source: 'remote',
      source_error: null,
      error: null,
    })
  })

  it('offers nothing when the source rolled back, and marks a downloaded build in use', async () => {
    const entry = await engineBuildVersions(
      {
        engine: 'sd-cpp',
        catalog: async () =>
          sdCatalog({
            engine: 'sd-cpp',
            manifest: { tag: 'master-883-a', source: 'cache', fetched_at: 1, error: 'offline' },
            installed: [
              build('master-900-b', 'downloaded', true),
              build('master-883-a', 'downloaded', false, true),
            ],
          }),
        checkUpdates: async () => check({ update_needed: false, target: null }),
      },
      {}
    )
    expect(entry.update).toEqual({ needed: false, target: null, apply: 'swap' })
    expect(entry.source).toBe('cache')
    expect(entry.source_error).toBe('offline')
    expect(entry.builds[1]).toMatchObject({ in_use: true, removable: false, not_removable_reason: 'in-use' })
  })
})

const descriptor = (id: string, minimumApp = '0.0.0'): RuntimeDescriptor =>
  ({
    descriptor_id: id,
    engine_id: 'vllm',
    minimum_app_version: minimumApp,
    download_bytes: 60e9,
  }) as RuntimeDescriptor

function managed(over: Partial<ManagedVersionsDeps> = {}): ManagedVersionsDeps {
  return {
    engine: 'vllm',
    installation: async () =>
      ({
        installation: { engine_id: 'vllm', active_descriptor_id: 'vllm-0.31.0-r1', status: 'ready' },
        platform: 'linux/amd64',
      }) as InstallationRecord,
    latest: async () => ({ kind: 'available', descriptor: descriptor('vllm-0.32.0-r1'), source: 'remote' }),
    inUse: () => false,
    platform: 'linux/amd64',
    ...over,
  }
}

describe('managedVersions', () => {
  it('offers a newer descriptor as a reinstall', async () => {
    const entry = await managedVersions(managed({ inUse: () => true }), { app_version: '2.1.0' })
    expect(entry).toEqual({
      engine: 'vllm',
      kind: 'managed',
      active_choice: 'core',
      builds: [
        {
          version: 'vllm-0.31.0-r1',
          variant: 'linux/amd64',
          origin: 'managed',
          active: true,
          in_use: true,
          removable: true,
        },
      ],
      active: { version: 'vllm-0.31.0-r1', variant: 'linux/amd64' },
      latest: { version: 'vllm-0.32.0-r1', variant: 'linux/amd64', download_bytes: 60e9 },
      update: {
        needed: true,
        target: { version: 'vllm-0.32.0-r1', variant: 'linux/amd64', download_bytes: 60e9 },
        apply: 'reinstall',
      },
      source: 'remote',
      source_error: null,
      error: null,
    })
  })

  it('blocks a descriptor that needs a newer app', async () => {
    const entry = await managedVersions(
      managed({
        latest: async () => ({
          kind: 'available',
          descriptor: descriptor('vllm-0.32.0-r1', '2.5.0'),
          source: 'remote',
        }),
      }),
      { app_version: '2.1.0' }
    )
    expect(entry.update).toEqual({
      needed: false,
      target: null,
      apply: 'reinstall',
      blocked_reason: 'requires-newer-app',
    })
    expect(entry.latest?.version).toBe('vllm-0.32.0-r1')
  })

  it('never offers an older, equal or unparsable descriptor', async () => {
    for (const id of ['vllm-0.30.0-r9', 'vllm-0.31.0-r1', 'vllm-nightly']) {
      const entry = await managedVersions(
        managed({ latest: async () => ({ kind: 'available', descriptor: descriptor(id), source: 'cache' }) }),
        {}
      )
      expect(entry.update.needed, id).toBe(false)
      expect(entry.source).toBe('cache')
    }
  })

  it("names the offer by the installation's platform, which the host decided, not this process's arch", async () => {
    const entry = await managedVersions(managed({ platform: 'linux/arm64' }), {})
    expect(entry.latest?.variant).toBe('linux/amd64')
    expect(entry.update.target?.variant).toBe('linux/amd64')
  })

  it('has no builds and offers nothing while the engine is not installed', async () => {
    const entry = await managedVersions(managed({ installation: async () => null }), {})
    expect(entry).toMatchObject({ builds: [], active: null, update: { needed: false, target: null } })
    expect(entry.latest?.version).toBe('vllm-0.32.0-r1')
  })

  it('says the source is unavailable when no descriptor was ever accepted', async () => {
    const entry = await managedVersions(
      managed({
        latest: async () => ({
          kind: 'unavailable',
          error: new AtomicCoreError('MANAGED_METADATA_INVALID', 'No vLLM runtime descriptor is available.'),
        }),
      }),
      {}
    )
    expect(entry).toMatchObject({
      latest: null,
      source: null,
      source_error: 'No vLLM runtime descriptor is available.',
      update: { needed: false, blocked_reason: 'source-unavailable' },
      error: { code: 'MANAGED_METADATA_INVALID' },
    })
  })
})

describe('collectEngineVersions', () => {
  it('answers the engines in parallel and turns one failure into that engine’s error', async () => {
    let running = 0
    let peak = 0
    const slow = (engine: 'llamacpp-upstream' | 'sd-cpp') => async () => {
      running++
      peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 10))
      running--
      return engineBuildVersions(
        {
          engine: 'mlx',
          catalog: async () => ({
            engine: 'mlx',
            manifest: null,
            manifest_error: 'x',
            host_backend_id: null,
            host_reason: null,
            installed: [],
            active: null,
          }),
          checkUpdates: async () => ({ update_needed: false, current: null, target: null }),
        },
        {}
      ).then((entry) => ({ ...entry, engine }))
    }
    const response = await collectEngineVersions([
      { engine: 'llamacpp-upstream', kind: 'llamacpp', read: slow('llamacpp-upstream') },
      {
        engine: 'llamacpp',
        kind: 'llamacpp',
        read: async () => {
          throw new AtomicCoreError('UPSTREAM_ERROR', 'The TurboQuant release index is unavailable.')
        },
      },
      { engine: 'sd-cpp', kind: 'engine-build', read: slow('sd-cpp') },
    ])
    expect(peak).toBe(2)
    expect(response.engines.map((entry) => entry.engine)).toEqual(['llamacpp-upstream', 'llamacpp', 'sd-cpp'])
    expect(response.engines[1]).toEqual({
      engine: 'llamacpp',
      kind: 'llamacpp',
      active_choice: 'client',
      builds: [],
      active: null,
      latest: null,
      update: { needed: false, target: null, apply: 'swap' },
      source: null,
      source_error: null,
      error: { code: 'UPSTREAM_ERROR', message: 'The TurboQuant release index is unavailable.' },
    })
  })

  it('wraps a plain exception as INTERNAL_ERROR', async () => {
    const response = await collectEngineVersions([
      { engine: 'vllm', kind: 'managed', read: async () => Promise.reject(new Error('disk gone')) },
    ])
    expect(response.engines[0]).toMatchObject({
      active_choice: 'core',
      update: { apply: 'reinstall' },
      error: { code: 'INTERNAL_ERROR', message: 'disk gone' },
    })
  })
})
