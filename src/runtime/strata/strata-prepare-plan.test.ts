import { expect, it } from 'vitest'
import fixture from '../../../test/fixtures/strata/catalog.json' with { type: 'json' }
import { strataPreparationPlan } from './strata-prepare-plan.js'
it('refuses unknown conversion profiles and executable catalog fields before building commands', () => {
  const descriptor = Object.values(fixture.models)[0]!.definition
  for (const change of [
    { variant_id: 'unknown-quant' },
    { preparation_abi: 'strata-v2' },
    { before_load: 'run setup' },
  ])
    expect(() =>
      strataPreparationPlan({ ...descriptor, ...change }, 'cuda', '/sources', '/staging')
    ).toThrow()
  expect(() => strataPreparationPlan(descriptor, 'cuda', '/staging/sources', '/staging')).toThrow()
})

it.each([
  ['q2-0-dflash2', 'metal'],
  ['iq3-s-dflash2', 'metal'],
  ['iq2-xs-dflash2', 'cuda'],
] as const)('prepares new Qwen3.8 profile %s on %s', (variant_id, backend) => {
  const descriptor = { ...Object.values(fixture.models)[0]!.definition, variant_id }
  const plan = strataPreparationPlan(descriptor, backend, '/sources', '/staging')
  expect(plan.steps.map((step) => step.id)).toEqual(['tokenizer', 'model-pack', 'drafter'])
  expect(() => strataPreparationPlan(descriptor, 'hip', '/sources', '/staging')).toThrow(/profile/)
})
