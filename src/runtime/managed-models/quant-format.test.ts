import { describe, expect, it } from 'vitest'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseRuntimeDescriptor } from '../environment/index.js'
import {
  describeUnrecognizedQuantization,
  isGgufCheckpoint,
  kvCacheQuantAlgo,
  quantizationComponents,
  quantizationFormat,
  type JsonObject,
} from './quant-format.js'

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
      name: 'step 2: fp8 with any other block size is not recognised, never falls through to dtype',
      config: {
        quantization_config: { quant_method: 'fp8', weight_block_size: [64, 64] },
        dtype: 'bfloat16',
      },
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'step 2: fp8 with no weight_block_size at all is the Hugging Face encoding, hf_fp8',
      config: { quantization_config: { quant_method: 'fp8' }, dtype: 'bfloat16' },
      hfQuantConfig: null,
      expected: 'hf_fp8',
    },
    {
      name: 'step 2: mxfp4',
      config: { quantization_config: { quant_method: 'mxfp4' } },
      hfQuantConfig: null,
      expected: 'mxfp4',
    },
    {
      name: 'step 2: awq without a bit width is not recognised',
      config: { quantization_config: { quant_method: 'awq' }, dtype: 'bfloat16' },
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'step 2: gptq without a bit width is not recognised',
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
      name: 'hf_quant_config.json present but quant_algo missing is unrecognised, never falls through to config.json',
      config: { dtype: 'bfloat16' },
      hfQuantConfig: { quantization: {} },
      expected: null,
    },
    {
      name: 'hf_quant_config.json present but with no quantization block at all is unrecognised, never falls through',
      config: { quantization_config: { quant_method: 'modelopt', quant_algo: 'NVFP4' } },
      hfQuantConfig: {},
      expected: null,
    },
    {
      name: 'an MLX checkpoint (top-level quantization, no quantization_config) is unrecognised, never its dtype (Bonsai-27B-mlx-1bit)',
      config: { dtype: 'bfloat16', quantization: { group_size: 128, bits: 1 } },
      hfQuantConfig: null,
      expected: null,
    },
    {
      name: 'quantization_config still decides before an MLX-style quantization object',
      config: {
        quantization_config: { quant_method: 'modelopt', quant_algo: 'NVFP4' },
        quantization: { bits: 4 },
      },
      hfQuantConfig: null,
      expected: 'nvfp4',
    },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(quantizationFormat(testCase.config, testCase.hfQuantConfig)).toBe(testCase.expected)
    })
  }
})

/**
 * The names the shared rule adds for vLLM (change `add-vllm-runtime`, design D6; conf README
 * `quantization[].format` names, ruling conf 1.2): one case per new name and per boundary the rule
 * draws, plus GGUF. The names are a contract with conf: they are repeated here, never invented.
 */
describe('the shared naming rule: encodings vLLM reads', () => {
  const qc = (quantizationConfig: JsonObject): JsonObject => ({
    dtype: 'bfloat16',
    quantization_config: quantizationConfig,
  })
  const group = (weights: JsonObject, inputActivations: JsonObject | null = null): JsonObject => ({
    targets: ['Linear'],
    weights,
    input_activations: inputActivations,
  })
  const ct = (groups: JsonObject, extra: JsonObject = {}): JsonObject =>
    qc({ quant_method: 'compressed-tensors', config_groups: groups, ...extra })

  it.each([
    ['HF fp8 without blocks', qc({ quant_method: 'fp8' }), 'hf_fp8'],
    ['HF fp8 with a null block size', qc({ quant_method: 'fp8', weight_block_size: null }), 'hf_fp8'],
    ['AutoAWQ 4-bit gemm', qc({ quant_method: 'awq', bits: 4, version: 'gemm' }), 'autoawq_w4a16'],
    ['AutoAWQ w_bit 4, no version', qc({ quant_method: 'AWQ', w_bit: 4 }), 'autoawq_w4a16'],
    ['GPTQ 4-bit symmetric', qc({ quant_method: 'gptq', bits: 4, sym: true }), 'gptq_w4a16'],
    [
      'GPTQ 8-bit symmetric, gptq format',
      qc({ quant_method: 'gptq', bits: 8, sym: true, checkpoint_format: 'gptq' }),
      'gptq_w8a16',
    ],
    ['compressed-tensors W4A16', ct({ g: group({ type: 'int', num_bits: 4, group_size: 128 }) }), 'ct_w4a16'],
    ['compressed-tensors W8A16', ct({ g: group({ type: 'int', num_bits: 8 }) }), 'ct_w8a16'],
    [
      'compressed-tensors W8A8 FP8',
      ct({ g: group({ type: 'float', num_bits: 8 }, { type: 'float', num_bits: 8 }) }),
      'ct_w8a8_fp8',
    ],
    [
      'compressed-tensors W8A8 INT8',
      ct({ g: group({ type: 'int', num_bits: 8 }, { type: 'int', num_bits: 8 }) }),
      'ct_w8a8_int8',
    ],
    [
      'compressed-tensors NVFP4',
      ct({
        g: group(
          { type: 'float', num_bits: 4, group_size: 16 },
          { type: 'float', num_bits: 4, group_size: 16 }
        ),
      }),
      'ct_nvfp4',
    ],
    [
      'compressed-tensors, two groups of one scheme, an empty sparsity_config',
      ct(
        { a: group({ type: 'int', num_bits: 4 }), b: group({ type: 'int', num_bits: 4 }) },
        { sparsity_config: {} }
      ),
      'ct_w4a16',
    ],
    [
      'compressed-tensors with a dense sparsity_config',
      ct({ g: group({ type: 'int', num_bits: 4 }) }, { sparsity_config: { format: 'dense' } }),
      'ct_w4a16',
    ],
  ] as const)('%s → %s', (_name, config, expected) => {
    expect(quantizationFormat(config, null)).toBe(expected)
  })

  it.each([
    ['AutoAWQ 8-bit', qc({ quant_method: 'awq', bits: 8 })],
    ['AutoAWQ gemv packing', qc({ quant_method: 'awq', bits: 4, version: 'gemv' })],
    ['GPTQ 3-bit', qc({ quant_method: 'gptq', bits: 3, sym: true })],
    ['GPTQ asymmetric', qc({ quant_method: 'gptq', bits: 4, sym: false })],
    [
      'GPTQ v2 checkpoint format',
      qc({ quant_method: 'gptq', bits: 4, sym: true, checkpoint_format: 'gptq_v2' }),
    ],
    ['compressed-tensors without groups', ct({})],
    ['compressed-tensors with an unknown scheme', ct({ g: group({ type: 'int', num_bits: 2 }) })],
    [
      'compressed-tensors NVFP4 without group size 16',
      ct({ g: group({ type: 'float', num_bits: 4 }, { type: 'float', num_bits: 4 }) }),
    ],
    [
      'compressed-tensors with groups of two schemes',
      ct({ a: group({ type: 'int', num_bits: 4 }), b: group({ type: 'int', num_bits: 8 }) }),
    ],
    [
      'compressed-tensors with 2:4 sparsity',
      ct({ g: group({ type: 'int', num_bits: 4 }) }, { sparsity_config: { format: 'sparse-24-bitmask' } }),
    ],
    ['bitsandbytes', qc({ quant_method: 'bitsandbytes', load_in_4bit: true })],
  ] as const)('%s is not recognised, never its dtype', (_name, config) => {
    expect(quantizationFormat(config, null)).toBeNull()
  })

  it('GGUF is its own always-reject gate, before any naming', () => {
    expect(isGgufCheckpoint([{ path: 'Qwen3-4B-Q4_K_M.gguf' }])).toBe(true)
    expect(isGgufCheckpoint([{ path: 'model.safetensors' }, { path: 'sub/MODEL.GGUF' }])).toBe(true)
    expect(isGgufCheckpoint([{ path: 'model.safetensors' }])).toBe(false)
  })

  it('names the quant_method it did not recognise', () => {
    expect(describeUnrecognizedQuantization(qc({ quant_method: 'bitsandbytes' }), null)).toBe(
      'config.json quantization_config.quant_method="bitsandbytes"'
    )
  })
})

describe('describeUnrecognizedQuantization', () => {
  it('names the hf_quant_config.json quant_algo it saw (including when absent)', () => {
    expect(describeUnrecognizedQuantization({}, { quantization: { quant_algo: null } })).toBe(
      'hf_quant_config.json quantization.quant_algo=null'
    )
    expect(describeUnrecognizedQuantization({}, { quantization: {} })).toBe(
      'hf_quant_config.json quantization.quant_algo=null'
    )
  })

  it('names the config.json quant_method for a modelopt checkpoint with no quant_algo', () => {
    expect(
      describeUnrecognizedQuantization({ quantization_config: { quant_method: 'modelopt' } }, null)
    ).toBe('config.json quantization_config.quant_method="modelopt" quant_algo=null')
  })

  it('names the weight_block_size for an fp8 checkpoint with the wrong block size', () => {
    expect(
      describeUnrecognizedQuantization(
        { quantization_config: { quant_method: 'fp8', weight_block_size: [64, 64] } },
        null
      )
    ).toBe('config.json quantization_config.quant_method="fp8" weight_block_size=[64,64]')
  })

  it('names an unsupported quant_method such as awq or gptq', () => {
    expect(describeUnrecognizedQuantization({ quantization_config: { quant_method: 'awq' } }, null)).toBe(
      'config.json quantization_config.quant_method="awq"'
    )
  })

  it('names an MLX quantization object, saying it is MLX', () => {
    expect(
      describeUnrecognizedQuantization(
        { dtype: 'bfloat16', quantization: { group_size: 128, bits: 1 } },
        null
      )
    ).toBe('config.json quantization={"group_size":128,"bits":1} (an MLX checkpoint)')
  })

  it('names the dtype it saw, including when absent', () => {
    expect(describeUnrecognizedQuantization({ dtype: 'float32' }, null)).toBe('config.json dtype="float32"')
    expect(describeUnrecognizedQuantization({}, null)).toBe('config.json dtype=null')
  })
})

describe('reachability: every format the real descriptor fixture lists is reachable from some checkpoint metadata', () => {
  const descriptor = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm.json'))

  it('lists at least the formats this naming rule is known to produce (sanity on the fixture itself)', () => {
    expect(descriptor.quantization.length).toBeGreaterThan(0)
  })

  for (const support of descriptor.quantization) {
    it(`"${support.format}" is reachable`, () => {
      if (support.format === 'bf16') {
        expect(quantizationFormat({ dtype: 'bfloat16' }, null)).toBe('bf16')
      } else if (support.format === 'fp16') {
        expect(quantizationFormat({ dtype: 'float16' }, null)).toBe('fp16')
      } else {
        // Every other format name in the descriptor is exactly a ModelOpt quant_algo, spelled
        // however the descriptor spells it (the naming rule only lower-cases and renames
        // fp8_pb_wo), so hf_quant_config.json's quant_algo reaches every one of them directly.
        expect(quantizationFormat({}, { quantization: { quant_algo: support.format } })).toBe(support.format)
      }
    })
  }
})

describe('kvCacheQuantAlgo', () => {
  it('reads hf_quant_config.json quantization.kv_cache_quant_algo when the repository carries the file', () => {
    expect(kvCacheQuantAlgo({}, { quantization: { quant_algo: 'FP8', kv_cache_quant_algo: 'FP8' } })).toBe(
      'FP8'
    )
  })

  it('is undefined when hf_quant_config.json carries no kv_cache_quant_algo', () => {
    expect(kvCacheQuantAlgo({}, { quantization: { quant_algo: 'FP8' } })).toBeUndefined()
  })

  it('reads config.json quantization_config.kv_cache_quant_algo when there is no hf_quant_config.json', () => {
    expect(
      kvCacheQuantAlgo(
        { quantization_config: { quant_method: 'modelopt', kv_cache_quant_algo: 'FP8' } },
        null
      )
    ).toBe('FP8')
  })

  it('is undefined for an unquantized checkpoint (neither object present)', () => {
    expect(kvCacheQuantAlgo({ dtype: 'bfloat16' }, null)).toBeUndefined()
  })

  it('never falls through to config.json when hf_quant_config.json is present but empty', () => {
    expect(kvCacheQuantAlgo({ quantization_config: { kv_cache_quant_algo: 'FP8' } }, {})).toBeUndefined()
  })
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

describe('quantizationComponents', () => {
  it('is the format itself for a single-format checkpoint', () => {
    expect(quantizationComponents('nvfp4', null)).toEqual(['nvfp4'])
  })

  it('lists every distinct per-layer format of a mixed-precision checkpoint, named by the same rule', () => {
    const hf = {
      quantization: {
        quant_algo: 'MIXED_PRECISION',
        quantized_layers: {
          a: { quant_algo: 'FP8' },
          b: { quant_algo: 'W4A16_NVFP4', group_size: 16 },
          c: { quant_algo: 'FP8_PB_WO' },
        },
      },
    }
    expect(quantizationComponents('mixed_precision', hf)).toEqual(['fp8', 'fp8_block_scales', 'w4a16_nvfp4'])
  })

  it('is empty when a mixed-precision checkpoint has no layers or a layer without quant_algo', () => {
    expect(
      quantizationComponents('mixed_precision', { quantization: { quant_algo: 'MIXED_PRECISION' } })
    ).toEqual([])
    expect(
      quantizationComponents('mixed_precision', {
        quantization: { quant_algo: 'MIXED_PRECISION', quantized_layers: { a: { group_size: 16 } } },
      })
    ).toEqual([])
  })
})

describe('dtype on text_config (VLM-style configs)', () => {
  it.each<[string, JsonObject, string | null]>([
    ['text_config.dtype', { text_config: { dtype: 'bfloat16' } }, 'bf16'],
    ['text_config.torch_dtype', { text_config: { torch_dtype: 'float16' } }, 'fp16'],
    [
      'a top-level dtype wins over text_config',
      { dtype: 'float16', text_config: { dtype: 'bfloat16' } },
      'fp16',
    ],
    ['text_config with no dtype at all', { text_config: {} }, null],
    ['a text_config that is not an object', { text_config: 'bfloat16' }, null],
  ])('%s', (_case, config, expected) => {
    expect(quantizationFormat(config, null)).toBe(expected)
  })

  it('names the text_config dtype it saw when it does not recognise it', () => {
    expect(describeUnrecognizedQuantization({ text_config: { dtype: 'float32' } }, null)).toBe(
      'config.json dtype="float32"'
    )
  })
})

describe('quantizationComponents edge cases', () => {
  it('is empty for a mixed-precision name with no hf_quant_config.json, or one without a quantization object', () => {
    expect(quantizationComponents('mixed_precision', null)).toEqual([])
    expect(quantizationComponents('mixed_precision', { quantization: 'MIXED_PRECISION' })).toEqual([])
  })

  it('is empty when a layer entry is not an object', () => {
    expect(
      quantizationComponents('mixed_precision', {
        quantization: { quant_algo: 'MIXED_PRECISION', quantized_layers: { a: 'FP8' } },
      })
    ).toEqual([])
  })
})
