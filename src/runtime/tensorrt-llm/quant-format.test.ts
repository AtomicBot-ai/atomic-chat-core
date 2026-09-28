import { describe, expect, it } from 'vitest'
import { isGgufCheckpoint, quantizationFormat, type JsonObject } from './quant-format.js'

describe('quantizationFormat', () => {
  // Table-driven over the conf README naming rule, "Runtime descriptors" → `quantization[].format`
  // names. Each case names which step of the rule it exercises.
  const cases: {
    name: string
    config: JsonObject
    hfQuantConfig: JsonObject | null
    expected: string | null
  }[] = [
    {
      name: 'step 1: hf_quant_config.json quant_algo FP8, lower-cased',
      config: {},
      hfQuantConfig: { quantization: { quant_algo: 'FP8' } },
      expected: 'fp8',
    },
    {
      name: 'step 1: hf_quant_config.json quant_algo fp8_pb_wo renamed to fp8_block_scales',
      config: {},
      hfQuantConfig: { quantization: { quant_algo: 'FP8_PB_WO' } },
      expected: 'fp8_block_scales',
    },
    {
      name: 'step 1: hf_quant_config.json quant_algo NVFP4',
      config: {},
      hfQuantConfig: { quantization: { quant_algo: 'NVFP4' } },
      expected: 'nvfp4',
    },
    {
      name: 'step 1 wins over step 3: config.json has no quantization_config but hf_quant_config.json does (ModelOpt FP8)',
      config: { dtype: 'bfloat16' },
      hfQuantConfig: { quantization: { quant_algo: 'FP8' } },
      expected: 'fp8',
    },
    {
      name: 'step 2: config.json quantization_config.quant_method modelopt, quant_algo lower-cased',
      config: { quantization_config: { quant_method: 'modelopt', quant_algo: 'NVFP4' } },
      hfQuantConfig: null,
      expected: 'nvfp4',
    },
    {
      name: 'step 2: modelopt quant_algo fp8_pb_wo renamed to fp8_block_scales',
      config: { quantization_config: { quant_method: 'modelopt', quant_algo: 'fp8_pb_wo' } },
      hfQuantConfig: null,
      expected: 'fp8_block_scales',
    },
    {
      name: 'step 2: fp8 with weight_block_size [128,128] is fp8_block_scales',
      config: { quantization_config: { quant_method: 'fp8', weight_block_size: [128, 128] } },
      hfQuantConfig: null,
      expected: 'fp8_block_scales',
    },
    {
      name: 'step 2: fp8 without that block size is not loadable, never falls through to dtype',
      config: {
        quantization_config: { quant_method: 'fp8', weight_block_size: [64, 64] },
        dtype: 'bfloat16',
      },
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'step 2: fp8 with no weight_block_size at all is not loadable',
      config: { quantization_config: { quant_method: 'fp8' }, dtype: 'bfloat16' },
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'step 2: mxfp4',
      config: { quantization_config: { quant_method: 'mxfp4' } },
      hfQuantConfig: null,
      expected: 'mxfp4',
    },
    {
      name: 'step 2: awq is not loadable',
      config: { quantization_config: { quant_method: 'awq' }, dtype: 'bfloat16' },
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'step 2: gptq is not loadable',
      config: { quantization_config: { quant_method: 'gptq' }, dtype: 'bfloat16' },
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'step 3: unquantized bfloat16 dtype is bf16',
      config: { dtype: 'bfloat16' },
      hfQuantConfig: null,
      expected: 'bf16',
    },
    {
      name: 'step 3: unquantized float16 dtype is fp16',
      config: { dtype: 'float16' },
      hfQuantConfig: null,
      expected: 'fp16',
    },
    {
      name: 'step 3: falls back to legacy torch_dtype when dtype is absent',
      config: { torch_dtype: 'float16' },
      hfQuantConfig: null,
      expected: 'fp16',
    },
    {
      name: 'step 3: dtype takes precedence over torch_dtype when both are present',
      config: { dtype: 'bfloat16', torch_dtype: 'float16' },
      hfQuantConfig: null,
      expected: 'bf16',
    },
    {
      name: 'step 3: float32 is not loadable',
      config: { dtype: 'float32' },
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'step 3: no dtype at all is not loadable',
      config: {},
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'malformed hf_quant_config.json (no quant_algo) falls through to config.json',
      config: { dtype: 'bfloat16' },
      hfQuantConfig: { quantization: {} },
      expected: 'bf16',
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(quantizationFormat(testCase.config, testCase.hfQuantConfig)).toBe(testCase.expected)
    })
  }
})

describe('isGgufCheckpoint', () => {
  it('is false for an ordinary safetensors listing', () => {
    expect(isGgufCheckpoint([{ path: 'config.json' }, { path: 'model-00001-of-00002.safetensors' }])).toBe(
      false
    )
  })

  it('is true when any file is .gguf, even alongside other files', () => {
    expect(isGgufCheckpoint([{ path: 'config.json' }, { path: 'model.Q4_K_M.gguf' }])).toBe(true)
  })

  it('is true for a gguf-only listing', () => {
    expect(isGgufCheckpoint([{ path: 'model.gguf' }])).toBe(true)
  })

  it('matches the extension case-insensitively', () => {
    expect(isGgufCheckpoint([{ path: 'model.GGUF' }])).toBe(true)
  })
})
