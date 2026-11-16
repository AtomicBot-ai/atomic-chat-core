import { expect, it } from 'vitest'
import catalog from '../../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { parseStrataDescriptor } from '../../client/index.js'
import { strataPreparationPlan } from './strata-prepare-plan.js'
it('uses the full four-shard DeepSeek recipe with explicit Engram, DSpark and vision inputs', () => {
  const d = parseStrataDescriptor(Object.values(catalog.models)[2]!.definition)
  const plan = strataPreparationPlan(d, 'cuda', '/models/source', '/prepared/staging')
  expect(plan.steps).toHaveLength(1)
  expect(plan.steps[0]).toMatchObject({
    tool: 'tools/dsv41/pack_gguf.py',
    args: [
      '--model',
      '/models/source',
      '--shards',
      ...d.inputs.weights,
      '--engram',
      '/models/source/' + d.inputs.engram,
      '--engram-meta',
      '/models/source/' + d.inputs.engram_metadata,
      '--dspark-gguf',
      '/models/source/' + d.inputs.drafter,
      '--dspark-noise-token',
      '128799',
      '--dspark-markov-rank',
      '256',
      '--mmproj',
      '/models/source/' + d.inputs.vision,
      '--vision',
      '/prepared/staging/.tmp/unused-vision',
      '--out',
      '/prepared/staging/pack',
    ],
  })
  expect(d.inputs.experts_per_token).toBe(6)
  expect(() => strataPreparationPlan(d, 'sycl', '/models/source', '/prepared/staging')).toThrow()
})
