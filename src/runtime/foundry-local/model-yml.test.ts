import { describe, expect, it } from 'vitest'
import { parseModelYml, serializeModelYml } from '../../models/index.js'
import { readFoundryLocalBlock } from './model-yml.js'

const BLOCK = {
  model_id: 'qwen2.5-1.5b-instruct',
  variant_id: 'qwen2.5-1.5b-instruct-openvino-npu',
  execution_provider: 'openvino',
  device: 'npu',
  asset_id: 'azureml://registries/azureml/models/qwen2.5-1.5b-instruct-openvino-npu/versions/5',
  asset_version: '5',
  context_length: 4096,
  tools: true,
  reasoning: false,
}

const doc = (block: unknown) =>
  parseModelYml(
    serializeModelYml({
      model_path: 'foundry-local/models/qwen2.5-1.5b-instruct-openvino-npu',
      name: 'Qwen2.5 1.5B Instruct (NPU)',
      foundry_local: block,
    })
  )

describe('readFoundryLocalBlock', () => {
  it('reads the block the installer writes', () => {
    expect(readFoundryLocalBlock(doc(BLOCK))).toEqual(BLOCK)
  })

  it('keeps the reasoning markers the host hands the library (operator decision Q1)', () => {
    const block = { ...BLOCK, reasoning: true, reasoning_start: '<think>', reasoning_end: '</think>' }
    expect(readFoundryLocalBlock(doc(block))).toEqual(block)
  })

  it('treats absent capabilities as no, and the asset and the context as optional', () => {
    const { tools: _t, reasoning: _r, asset_id: _a, asset_version: _v, context_length: _c, ...bare } = BLOCK
    expect(readFoundryLocalBlock(doc(bare))).toEqual({ ...bare, tools: false, reasoning: false })
  })

  it('refuses an accelerator or a device this core does not know, as a variant it cannot run', () => {
    for (const bad of [
      { ...BLOCK, execution_provider: 'nvtensorrtrtx' },
      { ...BLOCK, execution_provider: 'OpenVINOExecutionProvider' },
      { ...BLOCK, device: 'tpu' },
    ])
      expect(() => readFoundryLocalBlock(doc(bad))).toThrow(
        expect.objectContaining({ code: 'FOUNDRY_LOCAL_VARIANT_UNSUPPORTED' })
      )
  })

  it('refuses a model.yml without the block, or with a malformed one', () => {
    for (const bad of [
      undefined,
      'openvino',
      { ...BLOCK, variant_id: '' },
      { ...BLOCK, model_id: 3 },
      { ...BLOCK, context_length: 0 },
      { ...BLOCK, context_length: 4096.5 },
      { ...BLOCK, tools: 'yes' },
      { ...BLOCK, reasoning_start: 7 },
    ])
      expect(() => readFoundryLocalBlock(doc(bad))).toThrow(
        expect.objectContaining({ code: 'MODEL_LOAD_FAILED' })
      )
  })
})

describe('model.yml key order', () => {
  it('writes foundry_local after the keys the app already knew', () => {
    const text = serializeModelYml({
      model_path: 'p',
      name: 'n',
      foundry_local: BLOCK,
      capabilities: ['tools'],
    })
    expect(text.indexOf('capabilities:')).toBeLessThan(text.indexOf('foundry_local:'))
  })
})
