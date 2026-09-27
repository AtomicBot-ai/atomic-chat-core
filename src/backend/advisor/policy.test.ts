import { describe, expect, it, vi } from 'vitest'
import type { BackendVersion, GpuProbeInfo } from '../types.js'
import {
  isLlamacppProviderId,
  policyFor,
  recordPolicyOf,
  TURBOQUANT_POLICY,
  UPSTREAM_POLICY,
} from './policy.js'

const rtx4090: GpuProbeInfo = {
  vendor: 'NVIDIA',
  driver_version: '581.42',
  total_memory: 24_576,
  nvidia_info: { compute_capability: '8.9' },
  vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x2684 },
}
const UPSTREAM_REMOTE: BackendVersion[] = [
  { version: 'b10809', backend: 'win-cpu-x64', order: 0 },
  { version: 'b10809', backend: 'win-cuda-13.3-x64', order: 0 },
  { version: 'b10809', backend: 'win-vulkan-x64', order: 0 },
]
const FORK_REMOTE: BackendVersion[] = [
  { version: 'b10018-1.3.0', backend: 'linux-x64-vulkan', order: 0 },
  { version: 'b10269-1.4.0', backend: 'linux-x64-vulkan', order: 0 },
  { version: 'b10269-1.4.0', backend: 'linux-x64-cuda-13.3', order: 0 },
]

describe('policyFor / isLlamacppProviderId / recordPolicyOf', () => {
  it('maps the two provider ids onto their tables and nothing else', () => {
    expect(policyFor('llamacpp-upstream')).toBe(UPSTREAM_POLICY)
    expect(policyFor('llamacpp')).toBe(TURBOQUANT_POLICY)
    expect(isLlamacppProviderId('llamacpp')).toBe(true)
    expect(isLlamacppProviderId('llamacpp-upstream')).toBe(true)
    expect(isLlamacppProviderId('mlx')).toBe(false)
    expect(isLlamacppProviderId(undefined)).toBe(false)
  })
  it('exposes the record policy optimal-cache.ts consumes', () => {
    const upstream = recordPolicyOf(UPSTREAM_POLICY)
    expect(upstream.provider).toBe('llamacpp-upstream')
    expect(upstream.alreadyOptimalRule).toBe('type-and-category')
    expect(upstream.getCategory?.('win-cpu-x64')).toBe('cpu')
    const fork = recordPolicyOf(TURBOQUANT_POLICY)
    expect(fork.provider).toBe('llamacpp')
    expect(fork.alreadyOptimalRule).toBe('category')
    expect(fork.getCategory?.('windows-x64-cpu')).toBe('common_cpus')
  })
})

describe('the rules that differ between the providers', () => {
  it('records what a no_catalog_entry recheck writes and what "Latest" variants exist', () => {
    expect(UPSTREAM_POLICY.noCatalogEntryWrites).toBe('null')
    expect(TURBOQUANT_POLICY.noCatalogEntryWrites).toBe('record')
    expect(UPSTREAM_POLICY.staticVariants('windows', 'b1/win-cpu-x64')).toEqual([
      'win-cpu-x64',
      'win-cuda-12-x64',
      'win-cuda-13-x64',
      'win-rocm-x64',
      'win-vulkan-x64',
    ])
    expect(UPSTREAM_POLICY.staticVariants('macos', 'b1/macos-arm64')).toEqual(['macos-arm64'])
    expect(TURBOQUANT_POLICY.staticVariants('windows', 'x')).toEqual([])
  })

  it.each([
    ['same id', 'win-cuda-13.3-x64', 'win-cuda-13.3-x64', true],
    ['CUDA minor bump inside the major', 'win-cuda-13.1-x64', 'win-cuda-13.3-x64', true],
    ['family id to its concrete', 'win-cuda-13-x64', 'win-cuda-13.3-x64', true],
    ['ROCm family to its concrete', 'win-rocm-x64', 'win-rocm-7.14-x64', true],
    ['legacy CPU id to its migrated form', 'win-noavx-x64', 'win-cpu-x64', true],
    ['CPU to CUDA', 'win-cpu-x64', 'win-cuda-13.3-x64', false],
    ['Vulkan to CUDA', 'win-vulkan-x64', 'win-cuda-13.3-x64', false],
    ['CUDA 12 to CUDA 13', 'win-cuda-12.4-x64', 'win-cuda-13.3-x64', false],
  ])('upstream sameFamily: %s', (_label, current, target, expected) => {
    expect(UPSTREAM_POLICY.sameFamily(current, target)).toBe(expected)
  })

  it.each([
    ['same id', 'linux-x64-vulkan', 'linux-x64-vulkan', true],
    ['legacy id to its migrated form', 'linux-avx2', 'linux-x64-vulkan', true],
    ['legacy janhq CUDA 13 to the clean id', 'win-cuda-13.3-x64', 'windows-x64-cuda-13.3', true],
    ['CUDA 12 to CUDA 13 (no family rule in the fork)', 'linux-x64-cuda-12.4', 'linux-x64-cuda-13.3', false],
    ['CPU to Vulkan', 'linux-x64-cpu', 'linux-x64-vulkan', false],
  ])('fork sameFamily: %s', (_label, current, target, expected) => {
    expect(TURBOQUANT_POLICY.sameFamily(current, target)).toBe(expected)
  })

  it('offers any upstream target but only stable fork tags', () => {
    expect(UPSTREAM_POLICY.acceptsUpdateTarget('b10809/win-cpu-x64')).toBe(true)
    expect(TURBOQUANT_POLICY.acceptsUpdateTarget('b10269-1.4.0/linux-x64-vulkan')).toBe(true)
    expect(TURBOQUANT_POLICY.acceptsUpdateTarget('turboquant-linux-x64-vulkan-d86eb0b/linux')).toBe(false)
    expect(TURBOQUANT_POLICY.acceptsUpdateTarget('dev-latest/linux-x64-vulkan')).toBe(false)
  })

  it('resolves a Latest sentinel through the family (upstream) or the fork mapping', () => {
    expect(UPSTREAM_POLICY.resolveSentinel('win-cuda-13-x64', UPSTREAM_REMOTE)).toBe(
      'b10809/win-cuda-13.3-x64'
    )
    expect(UPSTREAM_POLICY.resolveSentinel('win-cpu-x64', UPSTREAM_REMOTE)).toBe('b10809/win-cpu-x64')
    expect(UPSTREAM_POLICY.resolveSentinel('win-rocm-x64', UPSTREAM_REMOTE)).toBeNull()
    expect(TURBOQUANT_POLICY.resolveSentinel('linux-avx2', FORK_REMOTE)).toBe('b10269-1.4.0/linux-x64-vulkan')
    expect(TURBOQUANT_POLICY.resolveSentinel('linux-x64-rocm', FORK_REMOTE)).toBeNull()
  })

  it('resolves a concrete target: upstream may borrow the current tag, the fork never does', async () => {
    const deps = {
      listSupportedBackends: async () => [] as BackendVersion[],
      fetchRemoteBackends: async () => [] as BackendVersion[],
    }
    expect(await UPSTREAM_POLICY.resolveConcrete('win-vulkan-x64', 'b10405/win-cpu-x64', deps)).toBe(
      'b10405/win-vulkan-x64'
    )
    expect(
      await TURBOQUANT_POLICY.resolveConcrete('linux-x64-vulkan', 'b10018-1.3.0/linux-x64-cpu', deps)
    ).toBeNull()
    expect(
      await TURBOQUANT_POLICY.resolveConcrete('linux-x64-vulkan', 'x', {
        ...deps,
        listSupportedBackends: async () => [
          { version: '\uFEFFb10269-1.4.0', backend: '\uFEFFlinux-x64-vulkan', order: 0 },
          { version: 'b10018-1.3.0', backend: 'linux-x64-vulkan', order: 0 },
        ],
      })
    ).toBe('b10269-1.4.0/linux-x64-vulkan')
    const warn = vi.fn()
    expect(
      await TURBOQUANT_POLICY.resolveConcrete('linux-x64-vulkan', 'x', {
        ...deps,
        listSupportedBackends: async () => {
          throw new Error('offline')
        },
        onWarn: warn,
      })
    ).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'))
  })

  it('merges with the provider comparator and gates with the provider filter', () => {
    const legacy: BackendVersion = {
      version: 'turboquant-linux-x64-vulkan-d86eb0b',
      backend: 'linux-avx2',
      order: 99,
    }
    const merged = TURBOQUANT_POLICY.merge(FORK_REMOTE, [legacy])
    expect(merged.map((b) => b.version)).toEqual([
      'b10269-1.4.0',
      'b10269-1.4.0',
      'b10018-1.3.0',
      'turboquant-linux-x64-vulkan-d86eb0b',
    ])
    // The fork gates on every OS; upstream only on Windows.
    expect(
      TURBOQUANT_POLICY.filterBySupport(merged, ['linux-x64-vulkan'], 'linux').map((b) => b.backend)
    ).toEqual(['linux-x64-vulkan', 'linux-x64-vulkan', 'linux-avx2'])
    expect(UPSTREAM_POLICY.filterBySupport(UPSTREAM_REMOTE, ['win-cpu-x64'], 'linux')).toEqual(
      UPSTREAM_REMOTE
    )
    expect(
      UPSTREAM_POLICY.filterBySupport(UPSTREAM_REMOTE, ['win-cpu-x64', 'win-cuda-13-x64'], 'windows')
    ).toEqual(UPSTREAM_REMOTE.slice(0, 2))
  })

  it("keeps each provider's features, matrix, category, priority and update check", () => {
    const upstream = UPSTREAM_POLICY.features('windows', ['avx2'], [rtx4090])
    expect(upstream).toMatchObject({ avx2: true, cuda12: true, cuda13: true, vulkan: true, rocm: false })
    expect(UPSTREAM_POLICY.supportedBackends('windows', 'x86_64', upstream)).toEqual([
      'win-cpu-x64',
      'win-cuda-12.4-x64',
      'win-cuda-13-x64',
      'win-vulkan-x64',
    ])
    const fork = TURBOQUANT_POLICY.features('linux', ['avx2'], [rtx4090], {
      gfxTargetVersions: [],
      hasRuntime: false,
    })
    expect(TURBOQUANT_POLICY.supportedBackends('linux', 'x86_64', fork)).toEqual([
      'linux-x64-cpu',
      'linux-x64-cuda-12.4',
      'linux-x64-cuda-13.3',
      'linux-x64-vulkan',
    ])
    expect(UPSTREAM_POLICY.determineBest(UPSTREAM_REMOTE, [rtx4090])).toBe('b10809/win-cuda-13.3-x64')
    expect(TURBOQUANT_POLICY.determineBest(FORK_REMOTE, [rtx4090])).toBe('b10269-1.4.0/linux-x64-cuda-13.3')
    expect(
      TURBOQUANT_POLICY.determineBest(FORK_REMOTE, [{ ...rtx4090, nvidia_info: null, total_memory: 4096 }])
    ).toBe('b10269-1.4.0/linux-x64-cuda-13.3')
    expect(UPSTREAM_POLICY.findLatest(UPSTREAM_REMOTE, 'win-vulkan-x64')).toBe('b10809/win-vulkan-x64')
    expect(TURBOQUANT_POLICY.findLatest(FORK_REMOTE, 'linux-x64-vulkan')).toBe(
      'b10269-1.4.0/linux-x64-vulkan'
    )
    expect(UPSTREAM_POLICY.normalizeId('win-noavx-x64')).toBe('win-cpu-x64')
    expect(TURBOQUANT_POLICY.normalizeId('linux-avx2')).toBe('linux-x64-vulkan')
    expect(UPSTREAM_POLICY.getCategory('win-cuda-13.3-x64')).toBe('cuda-cu13')
    expect(TURBOQUANT_POLICY.getCategory('windows-x64-cuda-13.3')).toBe('cuda-cu13.0')
    expect(UPSTREAM_POLICY.checkUpdates('b10405/win-cpu-x64', UPSTREAM_REMOTE).target_backend).toBe(
      'b10809/win-cpu-x64'
    )
    expect(TURBOQUANT_POLICY.checkUpdates('b10018-1.3.0/linux-x64-vulkan', FORK_REMOTE).target_backend).toBe(
      'b10269-1.4.0/linux-x64-vulkan'
    )
  })

  it('routes detect to the provider detector, with the probe only used upstream', async () => {
    const probeTier = vi.fn(async () => 'works' as const)
    const input = {
      osType: 'windows',
      arch: 'x86_64',
      cpuExtensions: ['avx2'],
      gpus: [rtx4090],
      listAvailableBackends: async () => UPSTREAM_REMOTE,
      probeTier,
    }
    expect(await UPSTREAM_POLICY.detect(input)).toEqual({ kind: 'gpu', backend: 'win-cuda-13.3-x64' })
    expect(probeTier).toHaveBeenCalledWith('win-cuda-13.3-x64')
    probeTier.mockClear()
    expect(
      await TURBOQUANT_POLICY.detect({
        ...input,
        listAvailableBackends: async () => [{ version: 'b10269-1.4.0', backend: 'windows-x64-cuda-13.3' }],
      })
    ).toEqual({ kind: 'gpu', backend: 'windows-x64-cuda-13.3' })
    expect(probeTier).not.toHaveBeenCalled()
    const warn = vi.fn()
    expect(
      await TURBOQUANT_POLICY.detect({
        ...input,
        osType: 'linux',
        gpus: [
          {
            ...rtx4090,
            nvidia_info: null,
            vendor: 'AMD',
            vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x744c },
          },
        ],
        rocm: { gfxTargetVersions: [110000], hasRuntime: true },
        listAvailableBackends: async () => [{ version: 'b10269-1.4.0', backend: 'linux-x64-rocm' }],
        onWarn: warn,
      })
    ).toEqual({ kind: 'gpu', backend: 'linux-x64-rocm' })
  })
})
