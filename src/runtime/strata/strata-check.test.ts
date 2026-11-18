import { expect, it } from 'vitest'
import catalog from '../../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { parseStrataDescriptor } from '../../client/index.js'
import { parseStrataSettings } from '../../settings/index.js'
import { estimateStrata, planStrataMemory, strataResourceRefusal } from './strata-check.js'
const descriptor = parseStrataDescriptor(Object.values(catalog.models)[0]!.definition)
it('accounts for unified memory once and keeps old installation space separate from new files', () => {
  const result = estimateStrata(descriptor, {
    backend: 'metal',
    unified: true,
    installed: false,
    prepared: false,
    previousBytes: 42,
  })
  expect(result.ram_bytes).toBe(0)
  expect(result.vram_bytes).toBe(0)
  expect(result.unified_memory_bytes).toBeGreaterThan(0)
  expect(result.previous_installation_bytes).toBe(42)
  expect(result.required_disk_bytes).toBe(
    result.download_bytes + result.derivative_bytes + result.temporary_bytes + 42
  )
})
it('does not reserve new disk space for ready derivatives of already installed sources', () => {
  const result = estimateStrata(descriptor, {
    backend: 'cuda',
    unified: false,
    installed: true,
    prepared: true,
    previousBytes: 0,
  })
  expect(result.required_disk_bytes).toBe(0)
  expect(result.unified_memory_bytes).toBe(0)
  expect(result.vram_bytes).toBeGreaterThan(0)
  expect(result.ram_bytes).toBeGreaterThan(0)
})

it('checks free space against additional bytes and does not charge existing files twice', () => {
  const e = estimateStrata(descriptor, {
    backend: 'metal',
    unified: true,
    installed: true,
    prepared: false,
    previousBytes: 200_000_000_000,
  })
  const additional = e.required_disk_bytes - e.previous_installation_bytes
  expect(strataResourceRefusal(e, { disk: additional - 1, ram: 128 * 2 ** 30, gpu: 128 * 2 ** 30 })).toBe(
    'insufficient-disk'
  )
  expect(strataResourceRefusal(e, { disk: additional, ram: 128 * 2 ** 30, gpu: 128 * 2 ** 30 })).toBeNull()
  expect(
    strataResourceRefusal(e, { disk: additional, ram: 128 * 2 ** 30, gpu: e.unified_memory_bytes - 1 })
  ).toBe('insufficient-memory')
})

it.each([
  { label: '8 GB Auto', memory: 8188, context: 0, effective: 4096, vision: 'off', fits: true },
  { label: '8 GB manual', memory: 8188, context: 8192, effective: 8192, vision: 'off', fits: false },
  { label: '6 GB Auto', memory: 6144, context: 0, effective: 4096, vision: 'off', fits: false },
  { label: '12 GB Auto', memory: 12284, context: 0, effective: 8192, vision: 'auto', fits: true },
])(
  'uses the effective context and vision for Qwen3.6 CUDA $label',
  ({ memory, context, effective, vision, fits }) => {
    const qwen36 = parseStrataDescriptor(catalog.models['strata-qwen36-ud-q4-k-xl'].definition)
    const gpu = memory * 2 ** 20
    const profile = planStrataMemory(qwen36, 'cuda', gpu, parseStrataSettings({ context_length: context }))
    expect(profile.settings).toMatchObject({ context_length: effective, vision })
    const estimate = estimateStrata(qwen36, {
      backend: 'cuda',
      unified: false,
      installed: true,
      prepared: true,
      previousBytes: 0,
      minimumVramBytes: profile.minimumVramBytes,
    })
    expect(strataResourceRefusal(estimate, { disk: 0, ram: 61 * 2 ** 30, gpu })).toBe(
      fits ? null : 'insufficient-memory'
    )
  }
)

it('keeps the Qwen3.8 CUDA and Qwen3.6 HIP Auto behavior', () => {
  const qwen36 = parseStrataDescriptor(catalog.models['strata-qwen36-ud-q4-k-xl'].definition)
  const defaults = parseStrataSettings({})
  expect(planStrataMemory(descriptor, 'cuda', 8188 * 2 ** 20, defaults).settings).toEqual(defaults)
  expect(planStrataMemory(qwen36, 'hip', 8 * 2 ** 30, defaults).settings).toEqual(defaults)
})

it('admits the CUDA Qwen3.6 Q4 profile on 32 GiB-class hosts that report less usable RAM', () => {
  const qwen36 = parseStrataDescriptor(catalog.models['strata-qwen36-ud-q4-k-xl'].definition)
  const gpu = 24463 * 2 ** 20
  const profile = planStrataMemory(qwen36, 'cuda', gpu, parseStrataSettings({}))
  const estimate = estimateStrata(qwen36, {
    backend: 'cuda',
    unified: false,
    installed: false,
    prepared: false,
    previousBytes: 0,
    minimumVramBytes: profile.minimumVramBytes,
  })
  expect(strataResourceRefusal(estimate, { disk: undefined, ram: 32170 * 2 ** 20, gpu })).toBeNull()
  expect(strataResourceRefusal(estimate, { disk: undefined, ram: 30 * 2 ** 30, gpu })).toBe(
    'insufficient-memory'
  )
})
