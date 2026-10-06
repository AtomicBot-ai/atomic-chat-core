import { describe, expect, it } from 'vitest'
import type { InstallationRecord } from './installations.js'
import { otherEngines, storeModelsChange } from './store-models.js'

/** Change `add-vllm-runtime`, design D13: the store's models go only with the last managed engine. */
const record = (installationId: string, engineId: string): InstallationRecord =>
  ({ installation: { installation_id: installationId, engine_id: engineId } }) as InstallationRecord
const TARGET = { kind: 'runtime' as const, installation_id: 'trt-1', engine_id: 'tensorrt-llm' }

describe('otherEngines', () => {
  it('names every engine installed besides the one being removed, once each, sorted', async () => {
    const installations = {
      list: async () => [record('trt-1', 'tensorrt-llm'), record('vllm', 'vllm'), record('vllm-2', 'vllm')],
    }
    expect(await otherEngines(installations, TARGET)).toEqual(['vllm'])
    expect(await otherEngines({ list: async () => [record('trt-1', 'tensorrt-llm')] }, TARGET)).toEqual([])
  })
})

describe('storeModelsChange', () => {
  it('says nothing when the models are kept anyway, deletes them with the last engine, keeps them for another', () => {
    expect(storeModelsChange(true, ['vllm'])).toEqual([])
    expect(storeModelsChange(false, []).map((change) => change.code)).toEqual(['remove-models'])
    expect(storeModelsChange(false, ['vllm'])).toEqual([
      {
        code: 'keep-models',
        text: 'The downloaded models stay: vllm still uses them.',
        params: { engines: 'vllm' },
      },
    ])
  })
})
