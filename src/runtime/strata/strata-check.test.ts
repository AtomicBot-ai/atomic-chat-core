import { describe, expect, it } from 'vitest'
import catalog from '../../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { parseStrataDescriptor } from '../../client/index.js'
import { parseStrataSettings } from '../../settings/index.js'
import {
  estimateStrata,
  planStrataMemory,
  strataPlannedContext,
  strataResourceRefusal,
} from './strata-check.js'
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

describe('the GGUF context plan of an automatic Strata window', () => {
  const MiB = 2 ** 20
  const GiB = 2 ** 30
  const qwen36 = parseStrataDescriptor(catalog.models['strata-qwen36-ud-q4-k-xl'].definition)
  // Qwen3.6 35B-A3B as its first shard describes it: a 256K window, 10 attention layers of 40 with
  // 2 KV heads of 256 — 20 KiB of KV a token.
  const GGUF = { contextLimit: 262_144, kvBytesPerToken: 20_480 }
  const auto = parseStrataSettings({})

  it('grows from the tested window by what the card holds above the floor, up to the GGUF limit', () => {
    // 12284 MiB less the 10 GiB floor and the 1 GiB reserve: 1020 MiB, 52224 tokens beyond 8192.
    expect(planStrataMemory(qwen36, 'cuda', 12_284 * MiB, auto, GGUF)).toMatchObject({
      settings: { context_length: 60_416, vision: 'auto' },
      minimumVramBytes: 10 * GiB,
    })
    expect(planStrataMemory(qwen36, 'cuda', 24_463 * MiB, auto, GGUF).settings.context_length).toBe(262_144)
    // Below 10 GiB the measured text profile stands; a window the user set stands everywhere.
    expect(planStrataMemory(qwen36, 'cuda', 8188 * MiB, auto, GGUF).settings.context_length).toBe(4096)
    expect(
      planStrataMemory(qwen36, 'cuda', 24_463 * MiB, parseStrataSettings({ context_length: 16_384 }), GGUF)
        .settings.context_length
    ).toBe(16_384)
  })

  it('grows the other profiles above their own VRAM floor on a discrete card, never on Metal', () => {
    const qwen38 = descriptor
    // Qwen3.8's 6 GiB floor on a 24 GiB card: 17 GiB of room at 20 KiB a token, past the limit.
    expect(planStrataMemory(qwen38, 'cuda', 24 * GiB, auto, GGUF).settings.context_length).toBe(262_144)
    expect(planStrataMemory(qwen38, 'cuda', 24 * GiB, auto, { contextLimit: 8192 }).settings).toEqual(auto)
    expect(planStrataMemory(qwen38, 'metal', 64 * GiB, auto, GGUF).settings).toEqual(auto)
    expect(planStrataMemory(qwen38, 'cuda', 24 * GiB, auto).settings).toEqual(auto)
    expect(
      planStrataMemory(qwen38, 'hip', 24 * GiB, parseStrataSettings({ context_length: 4096 }), GGUF).settings
        .context_length
    ).toBe(4096)
    // A card with no room above the floor keeps the tested window.
    expect(planStrataMemory(qwen38, 'cuda', 6 * GiB, auto, GGUF).settings).toEqual(auto)
  })

  it('strataPlannedContext keeps the tested window without a KV estimate or a longer limit', () => {
    const plan = (gguf: Parameters<typeof strataPlannedContext>[0]['gguf']) =>
      strataPlannedContext({ baseCtx: 8192, floorBytes: GiB, gpuBytes: 24 * GiB, gguf })
    expect(plan(undefined)).toBe(8192)
    expect(plan({ contextLimit: 262_144 })).toBe(8192)
    expect(plan({ contextLimit: 262_144, kvBytesPerToken: 0 })).toBe(8192)
    expect(plan({ contextLimit: 4096, kvBytesPerToken: 1024 })).toBe(8192)
    expect(plan({ contextLimit: 262_144, kvBytesPerToken: 1024 * 1024 })).toBe(8192 + 22 * 1024)
  })
})
