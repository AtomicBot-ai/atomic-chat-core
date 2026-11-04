import { describe, expect, it } from 'vitest'
import type { BackendVersion, GpuProbeInfo } from '../types.js'
import {
  BAD_BACKENDS_FILE,
  backendFallbackRank,
  gpuDriverKey,
  isBackendMarkedBad,
  isBadBackendEntryLive,
  TRANSIENT_BAD_BACKEND_TTL_MS,
  nextFallbackBackend,
  parseBadBackends,
  serializeBadBackends,
  withBadBackend,
} from './bad-backends.js'
import type { BadBackendEntry } from './bad-backends.js'

const nvidia = (driver: string): GpuProbeInfo => ({
  vendor: 'NVIDIA',
  driver_version: driver,
  nvidia_info: { compute_capability: '7.5' },
})
const entry = (over: Partial<BadBackendEntry> = {}): BadBackendEntry => ({
  provider: 'llamacpp-upstream',
  backend: 'win-cuda-13.3-x64',
  driver: '596.36',
  reason: 'GPU_BACKEND_INCOMPATIBLE',
  version: 'b12019',
  at: '2026-11-04T10:00:00.000Z',
  ...over,
})
const b = (version: string, backend: string): BackendVersion => ({ version, backend })

describe('gpuDriverKey', () => {
  it('keys by the NVIDIA driver when there is one, else by every GPU driver, else nothing', () => {
    expect(gpuDriverKey([nvidia('596.36')])).toBe('596.36')
    expect(gpuDriverKey([{ vendor: 'Intel', driver_version: '31.0' }, nvidia(' 616.07 ')])).toBe('616.07')
    expect(gpuDriverKey([{ vendor: 'NVIDIA', driver_version: '610.47' }, nvidia('610.47')])).toBe('610.47')
    expect(gpuDriverKey([{ vendor: 'AMD', driver_version: '24.9.1' }, { vendor: 'Intel' }])).toBe('24.9.1')
    expect(gpuDriverKey([])).toBe('')
  })
})

describe('the bad-backends document', () => {
  it('round-trips and drops what is malformed', () => {
    const text = serializeBadBackends([entry()])
    expect(BAD_BACKENDS_FILE).toBe('bad-backends.json')
    expect(JSON.parse(text)).toMatchObject({ schema_version: 1 })
    expect(parseBadBackends(JSON.parse(text))).toEqual([entry()])
    expect(
      parseBadBackends({
        entries: [
          null,
          'x',
          { provider: 'p' },
          { provider: 'p', backend: '﻿win-vulkan-x64', driver: '' },
          { provider: 'p', backend: 'b', driver: 1 },
        ],
      })
    ).toEqual([{ provider: 'p', backend: 'win-vulkan-x64', driver: '', reason: '', version: '', at: '' }])
    for (const raw of [null, [], 'x', {}, { entries: {} }]) expect(parseBadBackends(raw)).toEqual([])
  })

  it('matches provider, backend and driver; a new driver or another provider is not bad', () => {
    const entries = [entry()]
    expect(isBackendMarkedBad(entries, 'llamacpp-upstream', 'win-cuda-13.3-x64', '596.36')).toBe(true)
    expect(isBackendMarkedBad(entries, 'llamacpp-upstream', '﻿win-cuda-13.3-x64', '596.36')).toBe(true)
    expect(isBackendMarkedBad(entries, 'llamacpp-upstream', 'win-cuda-13.3-x64', '616.07')).toBe(false)
    expect(isBackendMarkedBad(entries, 'atomic-prism', 'win-cuda-13.3-x64', '596.36')).toBe(false)
    expect(isBackendMarkedBad(entries, 'llamacpp-upstream', 'win-cuda-12.4-x64', '596.36')).toBe(false)
  })

  it('replaces the record of the same pack, an older driver included, and keeps the others', () => {
    const other = entry({ backend: 'win-vulkan-x64' })
    const next = withBadBackend([entry(), other], entry({ driver: '610.47', at: 'later' }))
    expect(next).toEqual([other, entry({ driver: '610.47', at: 'later' })])
  })
})

describe('how long a record counts', () => {
  const at = Date.parse('2026-11-04T10:00:00.000Z')
  const day = 24 * 60 * 60 * 1000

  it('keeps a card-cannot-run record until the driver changes, however old', () => {
    const ptx = entry({ reason: 'GPU_BACKEND_INCOMPATIBLE' })
    expect(isBadBackendEntryLive(ptx, at + 365 * day)).toBe(true)
    expect(isBackendMarkedBad([ptx], ptx.provider, ptx.backend, ptx.driver, at + 365 * day)).toBe(true)
  })

  it('lets a record whose cause can go away lapse after a week', () => {
    for (const reason of ['ENGINE_BINARY_BROKEN', 'EMPTY_STDERR_CRASH', 'CPU_INSTRUCTION_UNSUPPORTED']) {
      const record = entry({ reason })
      expect(isBadBackendEntryLive(record, at + 6 * day)).toBe(true)
      expect(isBadBackendEntryLive(record, at + TRANSIENT_BAD_BACKEND_TTL_MS)).toBe(false)
      expect(isBackendMarkedBad([record], record.provider, record.backend, record.driver, at + 8 * day)).toBe(
        false
      )
    }
  })

  it('keeps a record whose time cannot be read', () => {
    expect(isBadBackendEntryLive(entry({ reason: 'ENGINE_BINARY_BROKEN', at: '' }), at + 30 * day)).toBe(true)
  })
})

describe('the fallback order', () => {
  it.each([
    ['win-cuda-13.3-x64', 0],
    ['windows-x64-cuda-13.3', 0],
    ['win-cuda-12.4-x64', 1],
    ['linux-x64-cuda-12.4', 1],
    ['win-hip-radeon-x64', 1],
    ['win-rocm-7.1-x64', 1],
    ['win-vulkan-x64', 2],
    ['win-opencl-adreno-arm64', 2],
    ['win-cpu-x64', 3],
    ['windows-x64-cpu', 3],
    ['win-avx2-x64', 3],
    ['win-x64', 3],
    ['macos-arm64', undefined],
    ['my-build', undefined],
  ])('%s ranks %s', (backend, rank) => {
    expect(backendFallbackRank(backend)).toBe(rank)
  })

  it('walks CUDA 13 → CUDA 12.4 → Vulkan → CPU, same tag first, never the failed or a skipped pack', () => {
    const installed = [
      b('b12100', 'win-cpu-x64'),
      b('b12019', 'win-cpu-x64'),
      b('b12019', 'win-vulkan-x64'),
      b('b12019', 'win-cuda-12.4-x64'),
      b('b12019', 'win-cuda-13.1-x64'),
      b('b12019', 'win-cuda-13.3-x64'),
    ]
    const cuda13 = { version: 'b12019', backend: 'win-cuda-13.3-x64' }
    expect(nextFallbackBackend(cuda13, installed)).toEqual(b('b12019', 'win-cuda-12.4-x64'))
    expect(nextFallbackBackend(cuda13, installed, (id) => id.includes('cuda-12'))).toEqual(
      b('b12019', 'win-vulkan-x64')
    )
    expect(nextFallbackBackend({ version: 'b12019', backend: 'win-vulkan-x64' }, installed)).toEqual(
      b('b12019', 'win-cpu-x64')
    )
    expect(nextFallbackBackend({ version: 'b12200', backend: 'win-vulkan-x64' }, installed)).toEqual(
      b('b12100', 'win-cpu-x64')
    )
    expect(nextFallbackBackend({ version: 'b12019', backend: 'win-cpu-x64' }, installed)).toBeUndefined()
    expect(nextFallbackBackend({ version: 'b1', backend: 'my-build' }, installed)).toBeUndefined()
    expect(nextFallbackBackend(cuda13, [b('b12019', 'win-cuda-13.3-x64'), b('x', 'odd')])).toBeUndefined()
  })
})
