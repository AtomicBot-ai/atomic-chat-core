import { describe, expect, it, vi } from 'vitest'
import {
  BACKEND_DETECTION_FAILED,
  BETTER_BACKEND_RECOMMENDATION_KEY,
  buildOptimalBackendCacheRecord,
  OPTIMAL_BACKEND_CACHE_KEY,
  OPTIMAL_BACKEND_PROVIDER,
  parseOptimalBackendCache,
  recheckOptimalBackend,
  refreshOptimalBackendCache,
  resolveConcreteOptimalBackend,
} from './optimal-cache.js'
import type { BackendVersion, OptimalBackendCacheRecord } from './types.js'

const NOW = 1_700_000_000_000
const gpuRecord: OptimalBackendCacheRecord = {
  schemaVersion: 1,
  provider: 'llamacpp-upstream',
  detectedAt: NOW,
  detectionKind: 'gpu',
  currentBackend: 'b10405/win-cpu-x64',
  idealBackendId: 'win-cuda-13.3-x64',
  recommendedBackend: 'b10809/win-cuda-13.3-x64',
  recommendedCategory: 'CUDA 13',
}
const cpuRecord: OptimalBackendCacheRecord = {
  schemaVersion: 1,
  provider: 'llamacpp-upstream',
  detectedAt: NOW,
  detectionKind: 'cpu-optimal',
  currentBackend: 'b10405/win-cpu-x64',
  recommendedCategory: 'CPU',
}

describe('constants', () => {
  it('keeps the storage keys and sentinel the app matches on', () => {
    expect(OPTIMAL_BACKEND_CACHE_KEY).toBe('atomic_llamacpp_upstream_optimal_backend_v1')
    expect(BETTER_BACKEND_RECOMMENDATION_KEY).toBe('llama_cpp_better_backend_recommendation')
    expect(BACKEND_DETECTION_FAILED).toBe('BACKEND_DETECTION_FAILED')
    expect(OPTIMAL_BACKEND_PROVIDER).toBe('llamacpp-upstream')
  })
})

describe('parseOptimalBackendCache (getCachedOptimalBackend)', () => {
  it('accepts a valid gpu record, with or without recommendedBackend, and a valid cpu record', () => {
    expect(parseOptimalBackendCache(JSON.stringify(gpuRecord))).toEqual(gpuRecord)
    const { recommendedBackend: _r, ...noRecommendation } = gpuRecord
    expect(parseOptimalBackendCache(JSON.stringify(noRecommendation))).toEqual(noRecommendation)
    expect(parseOptimalBackendCache(JSON.stringify(cpuRecord))).toEqual(cpuRecord)
  })
  it.each([
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['not json', '{'],
    ['a number', '42'],
    ['null json', 'null'],
    ['wrong schema', JSON.stringify({ ...gpuRecord, schemaVersion: 2 })],
    ['wrong provider', JSON.stringify({ ...gpuRecord, provider: 'llamacpp' })],
    ['negative detectedAt', JSON.stringify({ ...gpuRecord, detectedAt: -1 })],
    ['non-numeric detectedAt', JSON.stringify({ ...gpuRecord, detectedAt: 'x' })],
    ['empty category', JSON.stringify({ ...gpuRecord, recommendedCategory: '' })],
    ['gpu without idealBackendId', JSON.stringify({ ...gpuRecord, idealBackendId: '' })],
    [
      'gpu with a sentinel recommendation',
      JSON.stringify({ ...gpuRecord, recommendedBackend: 'latest/win-cuda-13.3-x64' }),
    ],
    [
      'gpu whose recommendation is another type',
      JSON.stringify({ ...gpuRecord, recommendedBackend: 'b10809/win-vulkan-x64' }),
    ],
    ['gpu with a non-string recommendation', JSON.stringify({ ...gpuRecord, recommendedBackend: 5 })],
    ['cpu carrying gpu fields', JSON.stringify({ ...cpuRecord, idealBackendId: 'x' })],
    ['unknown kind', JSON.stringify({ ...cpuRecord, detectionKind: 'auto' })],
  ])('ignores %s', (_label, raw) => {
    expect(parseOptimalBackendCache(raw)).toBeNull()
  })
  it('tolerates a BOM inside the recommendation', () => {
    expect(
      parseOptimalBackendCache(
        JSON.stringify({ ...gpuRecord, recommendedBackend: '\uFEFFb10809/win-cuda-13.3-x64' })
      )
    ).not.toBeNull()
  })
})

describe('buildOptimalBackendCacheRecord (persistOptimalBackendCache)', () => {
  it('builds cpu and gpu records, labelling the category from the ideal id', () => {
    expect(
      buildOptimalBackendCacheRecord({ kind: 'cpu-optimal' }, 'b10405/win-cpu-x64', 'ignored', NOW)
    ).toEqual(cpuRecord)
    expect(
      buildOptimalBackendCacheRecord(
        { kind: 'gpu', backend: 'win-cuda-13.3-x64' },
        'b10405/win-cpu-x64',
        'b10809/win-cuda-13.3-x64',
        NOW
      )
    ).toEqual(gpuRecord)
    const withoutTarget = buildOptimalBackendCacheRecord(
      { kind: 'gpu', backend: 'win-vulkan-x64' },
      'b1/win-cpu-x64',
      null,
      NOW
    )
    expect(withoutTarget).toEqual({
      ...gpuRecord,
      currentBackend: 'b1/win-cpu-x64',
      idealBackendId: 'win-vulkan-x64',
      recommendedCategory: 'Vulkan',
      recommendedBackend: undefined,
    })
    expect('recommendedBackend' in withoutTarget).toBe(false)
    expect(
      buildOptimalBackendCacheRecord({ kind: 'gpu', backend: 'win-rocm-10.0-x64' }, '', '', NOW)
        .recommendedCategory
    ).toBe('rocm')
  })
})

describe('resolveConcreteOptimalBackend', () => {
  const catalog: BackendVersion[] = [{ version: 'b10809', backend: 'win-cuda-13.3-x64' }]
  const remote: BackendVersion[] = [{ version: 'b10900', backend: 'win-cuda-13.4-x64' }]
  it('takes the newest catalog entry of the type first', async () => {
    const fetchRemote = vi.fn(async () => remote)
    expect(
      await resolveConcreteOptimalBackend('win-cuda-13.3-x64', 'b1/win-cpu-x64', {
        listSupportedBackends: async () => catalog,
        fetchRemoteBackends: fetchRemote,
      })
    ).toBe('b10809/win-cuda-13.3-x64')
    expect(fetchRemote).not.toHaveBeenCalled()
  })
  it('falls back to the remote catalog (exact or family), then to the current tag, then null', async () => {
    const deps = {
      listSupportedBackends: async () => [] as BackendVersion[],
      fetchRemoteBackends: async () => remote,
    }
    expect(await resolveConcreteOptimalBackend('win-cuda-13.4-x64', 'b1/win-cpu-x64', deps)).toBe(
      'b10900/win-cuda-13.4-x64'
    )
    expect(await resolveConcreteOptimalBackend('win-cuda-13-x64', 'b1/win-cpu-x64', deps)).toBe(
      'b10900/win-cuda-13.4-x64'
    )
    expect(await resolveConcreteOptimalBackend('win-vulkan-x64', 'b1/win-cpu-x64', deps)).toBe(
      'b1/win-vulkan-x64'
    )
    expect(await resolveConcreteOptimalBackend('win-vulkan-x64', '', deps)).toBeNull()
  })
  it('survives throwing dependencies and warns', async () => {
    const warn = vi.fn()
    const deps = {
      listSupportedBackends: async () => {
        throw new Error('ipc')
      },
      fetchRemoteBackends: async () => {
        throw new Error('offline')
      },
      onWarn: warn,
    }
    expect(await resolveConcreteOptimalBackend('win-vulkan-x64', 'b1/win-cpu-x64', deps, 'op')).toBe(
      'b1/win-vulkan-x64'
    )
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0]?.[0]).toContain('op: failed to resolve latest backend for win-vulkan-x64')
  })
})

describe('refreshOptimalBackendCache', () => {
  it('maps detection outcomes to records, tolerating a failing resolver', async () => {
    const resolver = async () => 'b10809/win-cuda-13.3-x64'
    expect(await refreshOptimalBackendCache({ kind: 'detection-failed' }, 'x', resolver, NOW)).toEqual({
      outcome: 'detection_failed',
    })
    expect(
      await refreshOptimalBackendCache({ kind: 'cpu-optimal' }, '\uFEFFb10405/win-cpu-x64', resolver, NOW)
    ).toEqual({ outcome: 'cached', record: cpuRecord })
    expect(
      await refreshOptimalBackendCache(
        { kind: 'gpu', backend: 'win-cuda-13.3-x64' },
        'b10405/win-cpu-x64',
        resolver,
        NOW
      )
    ).toEqual({ outcome: 'cached', record: gpuRecord })
    const failing = async () => {
      throw new Error('x')
    }
    const r = await refreshOptimalBackendCache(
      { kind: 'gpu', backend: 'win-cuda-13.3-x64' },
      'b10405/win-cpu-x64',
      failing,
      NOW
    )
    expect(r.outcome).toBe('cached')
    expect(r.outcome === 'cached' && 'recommendedBackend' in r.record).toBe(false)
  })
})

describe('recheckOptimalBackend', () => {
  const resolver = vi.fn(async () => 'b10809/win-cuda-13.3-x64')
  it('short-circuits detection failure and cpu-optimal', async () => {
    expect(await recheckOptimalBackend({ kind: 'detection-failed' }, 'x', resolver, NOW)).toEqual({
      outcome: 'detection_failed',
    })
    expect(await recheckOptimalBackend({ kind: 'cpu-optimal' }, 'b10405/win-cpu-x64', resolver, NOW)).toEqual(
      { outcome: 'cpu_optimal', record: cpuRecord }
    )
    expect(resolver).not.toHaveBeenCalled()
  })
  it('is already_optimal on the exact same type without resolving', async () => {
    const r = await recheckOptimalBackend(
      { kind: 'gpu', backend: 'win-cuda-13.3-x64' },
      'b10405/win-cuda-13.3-x64',
      resolver,
      NOW
    )
    expect(r).toEqual({
      outcome: 'already_optimal',
      record: {
        ...gpuRecord,
        currentBackend: 'b10405/win-cuda-13.3-x64',
        recommendedBackend: 'b10405/win-cuda-13.3-x64',
      },
    })
    expect(resolver).not.toHaveBeenCalled()
  })
  it('recommends the resolved concrete backend with the event payload', async () => {
    const r = await recheckOptimalBackend(
      { kind: 'gpu', backend: 'win-cuda-13.3-x64' },
      'b10405/win-cpu-x64',
      resolver,
      NOW
    )
    expect(r).toEqual({
      outcome: 'recommend',
      record: gpuRecord,
      payload: {
        currentBackend: 'b10405/win-cpu-x64',
        recommendedBackend: 'b10809/win-cuda-13.3-x64',
        recommendedCategory: 'CUDA 13',
        provider: 'llamacpp-upstream',
        version: 'b10809',
        backendId: 'win-cuda-13.3-x64',
      },
    })
    expect(resolver).toHaveBeenCalledWith('win-cuda-13.3-x64', 'b10405/win-cpu-x64')
  })
  it('handles an in-family migration (13.1 → 13.3) as a recommendation', async () => {
    const r = await recheckOptimalBackend(
      { kind: 'gpu', backend: 'win-cuda-13.3-x64' },
      'b9900/win-cuda-13.1-x64',
      resolver,
      NOW
    )
    expect(r.outcome).toBe('recommend')
  })
  it('reports no_catalog_entry and already_optimal from the resolver', async () => {
    expect(
      (
        await recheckOptimalBackend(
          { kind: 'gpu', backend: 'win-vulkan-x64' },
          'b1/win-cpu-x64',
          async () => null,
          NOW
        )
      ).outcome
    ).toBe('no_catalog_entry')
    expect(
      (
        await recheckOptimalBackend(
          { kind: 'gpu', backend: 'win-vulkan-x64' },
          'b1/win-vulkan-arm64',
          async () => 'b1/win-vulkan-arm64',
          NOW
        )
      ).outcome
    ).toBe('already_optimal')
  })
})
