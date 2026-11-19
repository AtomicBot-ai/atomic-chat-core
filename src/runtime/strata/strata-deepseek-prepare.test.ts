import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import catalog from '../../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { parseStrataDescriptor } from '../../client/index.js'
import { strataPreparationPlan } from './strata-prepare-plan.js'
const sourceDir = resolve('models', 'source')
const stagingDir = resolve('prepared', 'staging')
it('uses the full four-shard DeepSeek recipe with explicit Engram, DSpark and vision inputs', () => {
  const d = parseStrataDescriptor(Object.values(catalog.models)[2]!.definition)
  const plan = strataPreparationPlan(d, 'cuda', sourceDir, stagingDir)
  expect(plan.steps).toHaveLength(1)
  expect(plan.steps[0]).toMatchObject({
    tool: 'tools/dsv41/pack_gguf.py',
    args: [
      '--model',
      sourceDir,
      '--shards',
      ...d.inputs.weights,
      '--engram',
      join(sourceDir, d.inputs.engram!),
      '--engram-meta',
      join(sourceDir, d.inputs.engram_metadata!),
      '--dspark-gguf',
      join(sourceDir, d.inputs.drafter!),
      '--dspark-noise-token',
      '128799',
      '--dspark-markov-rank',
      '256',
      '--mmproj',
      join(sourceDir, d.inputs.vision!),
      '--vision',
      join(stagingDir, '.tmp/unused-vision'),
      '--out',
      join(stagingDir, 'pack'),
    ],
  })
  expect(d.inputs.experts_per_token).toBe(6)
  expect(() => strataPreparationPlan(d, 'sycl', sourceDir, stagingDir)).toThrow()
})

it('prepares a catalog-defined installation with its explicit profile and enforces the profile backend', () => {
  const base = parseStrataDescriptor(Object.values(catalog.models)[2]!.definition)
  const d = { ...base, variant_id: 'another-publisher-flash', profile_id: base.variant_id }
  expect(strataPreparationPlan(d, 'metal', sourceDir, stagingDir)).toEqual(
    strataPreparationPlan(base, 'metal', sourceDir, stagingDir)
  )
  expect(parseStrataDescriptor(d).variant_id).toBe('another-publisher-flash')
  const cuda = { ...d, profile_id: 'ista-1-75bpw-dspark', compatible_variants: ['linux-x64-cuda13'] }
  expect(strataPreparationPlan(cuda, 'cuda', sourceDir, stagingDir).steps[0]?.id).toBe('deepseek-pack')
  expect(() => strataPreparationPlan(cuda, 'metal', sourceDir, stagingDir)).toThrow(/CUDA/)
  expect(() => parseStrataDescriptor({ ...d, profile_id: 'unknown' })).toThrow(/profile/)
  expect(() => parseStrataDescriptor({ ...d, profile_id: 'iq3-xxs-dflash2' })).toThrow(/profile/)
})

it('prepares pinned DeepSeek shards and external Engram for text-only Metal', () => {
  const base = parseStrataDescriptor(Object.values(catalog.models)[2]!.definition)
  const files = base.files.filter(({ role }) => role !== 'vision' && role !== 'drafter')
  const inputs = { ...base.inputs, drafting: 'none' as const }
  delete inputs.vision
  delete inputs.drafter
  const d = {
    ...base,
    variant_id: 'deepseek41-metal-text',
    profile_id: 'ista-2-00bpw-metal-text',
    compatible_variants: ['macos-arm64-metal'],
    capabilities: { ...base.capabilities, vision: false },
    files,
    sources: base.sources.filter(({ id }) => files.some(({ source }) => source === id)),
    requirements: {
      ...base.requirements,
      download_bytes: files.reduce((total, file) => total + file.size, 0),
    },
    inputs,
  }
  const args = strataPreparationPlan(d, 'metal', sourceDir, stagingDir).steps[0]!.args
  expect(args).toEqual(expect.arrayContaining(['--engram', join(sourceDir, inputs.engram!)]))
  expect(args).not.toContain('--dspark-gguf')
  expect(args).not.toContain('--mmproj')
  expect(() => strataPreparationPlan(d, 'cuda', sourceDir, stagingDir)).toThrow(/profile/)
  expect(() => parseStrataDescriptor({ ...d, capabilities: { ...d.capabilities, vision: true } })).toThrow(
    /vision/
  )
})
