import { expect, it } from 'vitest'
import catalog from '../../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { parseStrataDescriptor } from '../../client/index.js'
import { strataPreparationPlan } from './strata-prepare-plan.js'
const descriptors = Object.values(catalog.models).map((m) => parseStrataDescriptor(m.definition))
it.each(['cuda', 'hip', 'metal', 'sycl'] as const)(
  'prepares Qwen3.8 locally for %s with separate immutable inputs and staging outputs',
  (backend) => {
    const d = descriptors[0]!
    const plan = strataPreparationPlan(d, backend, '/models/source', '/prepared/staging')
    expect(plan.steps.map((s) => s.tool)).toEqual([
      'tools/strata_tokenizer.py',
      'tools/iq_pack.py',
      'tools/dflash2_pack.py',
    ])
    expect(plan.steps[1]!.args).toEqual([
      '--gguf',
      '/models/source/' + d.inputs.weights[0],
      '--out',
      '/prepared/staging/pack',
      ...(backend === 'metal' ? [] : ['--experts-bin']),
    ])
    expect(plan.steps[2]!.args).toEqual([
      '/models/source/' + d.inputs.drafter,
      '/models/source/' + d.inputs.drafter_config,
      '/prepared/staging/draft.pack',
      '--q4_0',
    ])
    expect(plan.steps[2]!.outputs).toEqual([
      {
        path: 'draft.pack',
        size: 522458112,
        sha256: 'cda40d62d0eb8f37ed6e272142641a1d2f0de4a32f9e14d0416e7a71534849f1',
      },
    ])
    expect(plan.gpuRequired).toBe(false)
  }
)
it('extracts only Qwen3.6 tokenizer; its GGUF already contains the embedded MTP head', () => {
  const d = descriptors[1]!
  expect(strataPreparationPlan(d, 'cuda', '/models/source', '/prepared/staging').steps).toMatchObject([
    {
      tool: 'tools/strata_tokenizer.py',
      args: ['--gguf', '/models/source/' + d.inputs.weights[0], '--out', '/prepared/staging/pack'],
    },
  ])
  expect(() => strataPreparationPlan(d, 'metal', '/models/source', '/prepared/staging')).toThrow()
})
it('refuses a missing shard and output within the source tree', () => {
  const d = structuredClone(descriptors[0]!)
  d.files = d.files.filter((f) => f.path !== d.inputs.weights[1])
  expect(() => strataPreparationPlan(d, 'cuda', '/models/source', '/prepared/staging')).toThrow()
  expect(() =>
    strataPreparationPlan(descriptors[0]!, 'cuda', '/models/source', '/models/source/cache')
  ).toThrow()
})
