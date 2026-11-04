import { describe, expect, it } from 'vitest'
import { MODEL_YML_KEY_ORDER } from '../../contracts/index.js'
import { readLiteRtLmBlock } from './model-yml.js'

const BLOCK = {
  model_id: 'gemma-4-e2b',
  variant_id: 'gemma-4-e2b-gpu',
  backend: 'gpu',
  repo: 'litert-community/gemma-4-E2B-it-litert-lm',
  revision: 'a'.repeat(40),
  file: 'gemma-4-E2B-it.litertlm',
  context_length: 32003,
  tools: true,
  reasoning: true,
  vision: true,
  source: 'curated',
}

describe('readLiteRtLmBlock', () => {
  it('reads the block the clients write', () => {
    expect(readLiteRtLmBlock({ litert_lm: BLOCK })).toEqual(BLOCK)
    expect(
      readLiteRtLmBlock({ litert_lm: { ...BLOCK, backend: 'npu', npu: 'intel-lnl', source: 'huggingface' } })
    ).toMatchObject({
      backend: 'npu',
      npu: 'intel-lnl',
      source: 'huggingface',
    })
    const { context_length: _context, ...withoutContext } = BLOCK
    expect(readLiteRtLmBlock({ litert_lm: withoutContext })).toEqual(withoutContext)
    // `geniex` follows it since change add-geniex-runtime (task 6.2).
    expect(MODEL_YML_KEY_ORDER.slice(-2)).toEqual(['litert_lm', 'geniex'])
  })

  it('calls a backend or NPU this core does not know a variant it cannot run', () => {
    expect(() => readLiteRtLmBlock({ litert_lm: { ...BLOCK, backend: 'tpu' } })).toThrow(
      expect.objectContaining({
        code: 'LITERT_LM_VARIANT_UNSUPPORTED',
        message: expect.stringMatching(/"tpu"/),
      })
    )
    expect(() =>
      readLiteRtLmBlock({ litert_lm: { ...BLOCK, backend: 'npu', npu: 'qualcomm-sm8750' } })
    ).toThrow(
      expect.objectContaining({
        code: 'LITERT_LM_VARIANT_UNSUPPORTED',
        message: expect.stringMatching(/qualcomm-sm8750/),
      })
    )
  })

  it.each([
    [{}, /is missing/],
    [{ litert_lm: 'x' }, /is missing/],
    [{ litert_lm: { ...BLOCK, variant_id: '' } }, /variant_id/],
    [{ litert_lm: { ...BLOCK, backend: 'npu' } }, /npu/],
    [{ litert_lm: { ...BLOCK, npu: 'intel-lnl' } }, /npu/],
    [{ litert_lm: { ...BLOCK, context_length: 0 } }, /context_length/],
    [{ litert_lm: { ...BLOCK, tools: 'yes' } }, /tools/],
    [{ litert_lm: { ...BLOCK, source: 'mirror' } }, /source/],
    [{ litert_lm: { ...BLOCK, file: '../x.litertlm' } }, /file/],
  ])('refuses a broken block %j as MODEL_LOAD_FAILED', (doc, message) => {
    expect(() => readLiteRtLmBlock(doc)).toThrow(
      expect.objectContaining({ code: 'MODEL_LOAD_FAILED', message: expect.stringMatching(message) })
    )
  })
})
