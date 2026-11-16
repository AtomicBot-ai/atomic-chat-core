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
