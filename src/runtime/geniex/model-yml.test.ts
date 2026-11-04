import { describe, expect, it } from 'vitest'
import { MODEL_YML_KEY_ORDER } from '../../contracts/index.js'
import { readGeniexBlock } from './model-yml.js'

const GGUF = {
  model_id: 'qwen3-4b',
  variant_id: 'qwen3-4b',
  plugin: 'llama_cpp',
  backend: 'npu',
  repo: 'unsloth/Qwen3-4B-GGUF',
  revision: 'a'.repeat(40),
  file: 'Qwen3-4B-Q4_0.gguf',
  context_length: 40960,
  tools: true,
  reasoning: true,
  vision: false,
  source: 'curated',
}
const BUNDLE = {
  model_id: 'qwen3-4b',
  variant_id: 'qwen3-4b-x-elite',
  plugin: 'qairt',
  backend: 'npu',
  chip: 'x-elite',
  bundle_url: 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/qwen3-4b-x-elite.zip',
  precision: 'w4a16',
  context_length: 4096,
  tools: true,
  reasoning: false,
  vision: false,
  source: 'curated',
}

describe('readGeniexBlock (task 6.2)', () => {
  it('reads a GGUF record and a bundle variant as the clients write them, geniex last in the key order', () => {
    expect(readGeniexBlock({ geniex: GGUF })).toEqual(GGUF)
    expect(
      readGeniexBlock({
        geniex: { ...GGUF, mmproj: 'mmproj-F16.gguf', vision: true, source: 'huggingface', backend: 'gpu' },
      })
    ).toMatchObject({
      mmproj: 'mmproj-F16.gguf',
      vision: true,
      source: 'huggingface',
      backend: 'gpu',
    })
    expect(readGeniexBlock({ geniex: BUNDLE })).toEqual(BUNDLE)
    expect(MODEL_YML_KEY_ORDER.at(-1)).toBe('geniex')
  })

  it('calls a plugin, device or chip this core does not know, and a bundle off the NPU, a model it cannot run', () => {
    const unsupported = (doc: unknown, message: RegExp) =>
      expect(() => readGeniexBlock(doc as Record<string, unknown>)).toThrow(
        expect.objectContaining({
          code: 'GENIEX_VARIANT_UNSUPPORTED',
          message: expect.stringMatching(message),
        })
      )
    unsupported({ geniex: { ...GGUF, plugin: 'onnx' } }, /"onnx"/)
    unsupported({ geniex: { ...GGUF, backend: 'tpu' } }, /"tpu"/)
    unsupported({ geniex: { ...BUNDLE, chip: 'x3-elite' } }, /x3-elite/)
    unsupported({ geniex: { ...BUNDLE, backend: 'gpu' } }, /NPU only/)
  })

  it.each([
    [{}, /is missing/],
    [{ geniex: 'x' }, /is missing/],
    [{ geniex: { ...GGUF, variant_id: '' } }, /variant_id/],
    [{ geniex: { ...GGUF, chip: 'x-elite' } }, /chip/],
    [{ geniex: { ...BUNDLE, chip: undefined } }, /chip/],
    [{ geniex: { ...GGUF, context_length: 0 } }, /context_length/],
    [{ geniex: { ...GGUF, context_length: undefined } }, /context_length/],
    [{ geniex: { ...GGUF, tools: 'yes' } }, /tools/],
    [{ geniex: { ...GGUF, source: 'mirror' } }, /source/],
    [{ geniex: { ...GGUF, file: '../x.gguf' } }, /file/],
    [{ geniex: { ...GGUF, file: undefined } }, /file/],
    [{ geniex: { ...BUNDLE, bundle_url: 'ftp://x' } }, /bundle_url/],
  ])('refuses a broken block %j as MODEL_LOAD_FAILED', (doc, message) => {
    expect(() => readGeniexBlock(doc as Record<string, unknown>)).toThrow(
      expect.objectContaining({ code: 'MODEL_LOAD_FAILED', message: expect.stringMatching(message) })
    )
  })
})
