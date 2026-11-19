import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import catalog from '../../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { parseStrataDescriptor } from '../../client/index.js'
import { estimateStrata, strataResourceRefusal } from './strata-check.js'
import { strataLaunchConfig } from './strata-launch-settings.js'
const models = Object.values(catalog.models).map((row) => parseStrataDescriptor(row.definition))
const input = {
  bundle: resolve('bundle'),
  prepared: resolve('prepared'),
  source: resolve('source'),
  state: resolve('state'),
  modelId: 'sample',
  key: 'test-secret',
  port: 10200,
  backend: 'metal' as const,
  platform: process.platform,
  settings: { context_length: 4096, vision: 'off' },
  ramBytes: 128 * 2 ** 30,
}
it('uses the catalog default and accepts manual context up to the verified GGUF limit', () => {
  const descriptor = models[2]!
  const launch = (context_length: number) =>
    strataLaunchConfig(descriptor, { ...input, contextLimit: 1048576, settings: { context_length } }).args
  expect(launch(0)).toContain(String(descriptor.context_length))
  expect(launch(1048576)).toContain('1048576')
  expect(() => launch(1048577)).toThrow(/context/i)
})
it('pins DeepSeek to six experts and uses the Metal-specific drafter policy', () => {
  const config = strataLaunchConfig(models[2]!, input)
  expect(config.args).toEqual([
    '--pack',
    resolve('prepared/pack'),
    '--max-context',
    '4096',
    '--eos',
    '1',
    '--vision',
    'none',
    '--dspark',
    'none',
    '--experts',
    '6',
    '--profile-readonly',
  ])
  expect(config).toMatchObject({
    host: '127.0.0.1',
    api_key: 'test-secret',
    parallel: 1,
    offline: true,
    lazy_load: false,
    idle_unload_s: 0,
  })
})
it('maps Qwen3.6 to one card and embedded MTP, and rejects SSD, excessive context and unproved device mapping', () => {
  const cuda = { ...input, backend: 'cuda13' as const, gpuOrdinal: 2 }
  expect(strataLaunchConfig(models[1]!, cuda)).toMatchObject({
    gpu: 2,
    args: expect.arrayContaining(['--mtp', '2']),
  })
  expect(() => strataLaunchConfig(models[1]!, { ...cuda, settings: { memory_mode: 'ssd' } })).toThrow(
    /memory mode/i
  )
  expect(() => strataLaunchConfig(models[1]!, { ...cuda, settings: { context_length: 8193 } })).toThrow(
    /context/i
  )
  expect(() => strataLaunchConfig(models[1]!, { ...input, backend: 'cuda13' })).toThrow(/device/i)
})
it('refuses RAM mode when the source weights and runtime budget cannot fit', () => {
  expect(() =>
    strataLaunchConfig(models[0]!, { ...input, ramBytes: 32 * 2 ** 30, settings: { memory_mode: 'ram' } })
  ).toThrow(/RAM/)
})
it('limits SYCL to the mapped Level Zero GPU without configuring CUDA ordinal selection', () => {
  const config = strataLaunchConfig(models[0]!, { ...input, backend: 'sycl', gpuOrdinal: 2 })
  expect(config.env).toEqual({ ONEAPI_DEVICE_SELECTOR: 'level_zero:2' })
  expect(config).not.toHaveProperty('gpu')
})

it('uses NVFP4 pack paths and includes the PLE and experts in explicit RAM mode', () => {
  const GiB = 2 ** 30
  const base = models[0]!
  const descriptor: typeof base = {
    ...base,
    variant_id: 'nvfp4-qad',
    inputs: { ...base.inputs, drafting: 'none', ple: 'ple.gguf', embedding: 'embed.gguf' },
    files: [
      { ...base.files[0]!, role: 'ple', path: 'ple.gguf', size: 95 * GiB },
      { ...base.files[0]!, role: 'pack', path: 'pack/experts.bin', size: 63 * GiB },
    ],
  }
  const cuda = { ...input, backend: 'cuda13' as const, gpuOrdinal: 0, ramBytes: 64 * GiB }
  expect(strataLaunchConfig(descriptor, cuda)).toMatchObject({
    args: expect.arrayContaining(['--resident-budget-gib', '40', '--native-dense-gguf', '--ple-gguf']),
    tokenizer: resolve('source/pack/tokenizer'),
  })
  expect(() => strataLaunchConfig(descriptor, { ...cuda, settings: { memory_mode: 'ram' } })).toThrow(/RAM/)
  const estimate = estimateStrata(descriptor, {
    backend: 'cuda',
    unified: false,
    installed: false,
    prepared: false,
    previousBytes: 0,
    memoryMode: 'ram',
  })
  expect(strataResourceRefusal(estimate, { disk: undefined, ram: 64 * GiB, gpu: 12 * GiB })).toBe(
    'insufficient-memory'
  )
})
