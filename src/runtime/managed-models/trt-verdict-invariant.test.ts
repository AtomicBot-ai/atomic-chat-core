/**
 * The shared quantization naming rule never changes a TensorRT-LLM verdict (change
 * `add-vllm-runtime`, design D6; spec `managed-model-store`, "Единое правило формата квантизации",
 * scenario "Вердикт TRT не изменился"). Every checkpoint shape the TensorRT-LLM `compatibility`,
 * `check` and `quant-format` tests exercise — plus every encoding the rule newly names for vLLM — is
 * checked against the published descriptor `tensorrt-llm-1.3.0rc29-r3` on one card of each compute
 * capability that descriptor's matrix distinguishes. `EXPECTED` was recorded from the code before
 * the rule was generalized and must never be edited to make this pass: only the reason text of a
 * refusal may change, never `ok` versus `MODEL_INCOMPATIBLE`.
 */
import { describe, expect, it } from 'vitest'
import type { GpuFacts } from '../../contracts/index.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseRuntimeDescriptor } from '../environment/index.js'
import { checkModelCompatibility, type CheckpointFile } from '../tensorrt-llm/compatibility.js'
import { TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION } from '../tensorrt-llm/kv-cache.js'

type Json = Record<string, unknown>

const DESCRIPTOR = parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm-1.3.0rc29-r3.json'))
const CAPABILITIES = ['8.0', '8.6', '8.9', '9.0', '10.0', '12.0'] as const
const GIB = 1024 ** 3

/** Llama 3 8B's KV-cache shape: every checkpoint below has a real shape for the memory line. */
const SHAPE = {
  num_hidden_layers: 32,
  num_attention_heads: 32,
  num_key_value_heads: 8,
  hidden_size: 4096,
  intermediate_size: 14336,
}
const llama = (extra: Json = {}): Json => ({ architectures: ['LlamaForCausalLM'], ...SHAPE, ...extra })
const modelopt = (algo: unknown, extra: Json = {}): Json => ({ quantization: { quant_algo: algo, ...extra } })
const mixed = (algos: string[]): Json =>
  modelopt('MIXED_PRECISION', {
    quantized_layers: Object.fromEntries(
      algos.map((algo, index) => [`model.layers.${index}.mlp`, { quant_algo: algo }])
    ),
  })
const group = (weights: Json, inputActivations: Json | null): Json => ({
  targets: ['Linear'],
  weights,
  input_activations: inputActivations,
})
const compressed = (groups: Json, extra: Json = {}): Json =>
  llama({ quantization_config: { quant_method: 'compressed-tensors', config_groups: groups, ...extra } })

interface Case {
  name: string
  config: Json
  hfQuant?: Json
  files?: CheckpointFile[]
}

const CORPUS: Case[] = [
  { name: 'bf16 dtype', config: llama({ dtype: 'bfloat16' }) },
  { name: 'fp16 dtype', config: llama({ dtype: 'float16' }) },
  { name: 'float32 dtype', config: llama({ dtype: 'float32' }) },
  { name: 'legacy torch_dtype', config: llama({ torch_dtype: 'float16' }) },
  { name: 'no dtype at all', config: llama() },
  {
    name: 'VLM text_config dtype',
    config: {
      architectures: ['Qwen3_5ForConditionalGeneration'],
      text_config: { dtype: 'bfloat16', ...SHAPE },
    },
  },
  { name: 'ModelOpt FP8', config: llama(), hfQuant: modelopt('FP8') },
  { name: 'ModelOpt FP8 + dtype', config: llama({ dtype: 'bfloat16' }), hfQuant: modelopt('FP8') },
  { name: 'ModelOpt FP8_PB_WO', config: llama(), hfQuant: modelopt('FP8_PB_WO') },
  { name: 'ModelOpt NVFP4', config: llama(), hfQuant: modelopt('NVFP4') },
  { name: 'ModelOpt W4A16_AWQ', config: llama(), hfQuant: modelopt('W4A16_AWQ') },
  { name: 'ModelOpt W4A8_AWQ', config: llama(), hfQuant: modelopt('W4A8_AWQ') },
  { name: 'ModelOpt W4A16_NVFP4', config: llama(), hfQuant: modelopt('W4A16_NVFP4') },
  { name: 'ModelOpt MXFP8', config: llama(), hfQuant: modelopt('MXFP8') },
  {
    name: 'ModelOpt FP8_PER_CHANNEL_PER_TOKEN',
    config: llama(),
    hfQuant: modelopt('FP8_PER_CHANNEL_PER_TOKEN'),
  },
  {
    name: 'ModelOpt FP8 with FP8 KV',
    config: llama(),
    hfQuant: modelopt('FP8', { kv_cache_quant_algo: 'FP8' }),
  },
  {
    name: 'hf_quant_config without quant_algo',
    config: llama({ dtype: 'bfloat16' }),
    hfQuant: modelopt(null),
  },
  {
    name: 'config modelopt NVFP4',
    config: llama({ quantization_config: { quant_method: 'modelopt', quant_algo: 'NVFP4' } }),
  },
  {
    name: 'config modelopt fp8_pb_wo',
    config: llama({ quantization_config: { quant_method: 'modelopt', quant_algo: 'fp8_pb_wo' } }),
  },
  {
    name: 'config modelopt without quant_algo',
    config: llama({ quantization_config: { quant_method: 'modelopt' } }),
  },
  {
    name: 'fp8 block 128x128',
    config: llama({ quantization_config: { quant_method: 'fp8', weight_block_size: [128, 128] } }),
  },
  {
    name: 'fp8 block 64x64',
    config: llama({
      dtype: 'bfloat16',
      quantization_config: { quant_method: 'fp8', weight_block_size: [64, 64] },
    }),
  },
  {
    name: 'HF fp8 without blocks',
    config: llama({ dtype: 'bfloat16', quantization_config: { quant_method: 'fp8' } }),
  },
  {
    name: 'HF fp8 null blocks',
    config: llama({ quantization_config: { quant_method: 'fp8', weight_block_size: null } }),
  },
  { name: 'mxfp4', config: llama({ quantization_config: { quant_method: 'mxfp4' } }) },
  { name: 'awq bare', config: llama({ dtype: 'bfloat16', quantization_config: { quant_method: 'awq' } }) },
  {
    name: 'AutoAWQ 4-bit gemm',
    config: llama({
      quantization_config: {
        quant_method: 'awq',
        bits: 4,
        group_size: 128,
        version: 'gemm',
        zero_point: true,
      },
    }),
  },
  {
    name: 'AutoAWQ w_bit 4 no version',
    config: llama({ quantization_config: { quant_method: 'awq', w_bit: 4 } }),
  },
  {
    name: 'AutoAWQ 4-bit gemv',
    config: llama({ quantization_config: { quant_method: 'awq', bits: 4, version: 'gemv' } }),
  },
  { name: 'AutoAWQ 8-bit', config: llama({ quantization_config: { quant_method: 'awq', bits: 8 } }) },
  { name: 'gptq bare', config: llama({ dtype: 'bfloat16', quantization_config: { quant_method: 'gptq' } }) },
  {
    name: 'GPTQ 4-bit sym',
    config: llama({ quantization_config: { quant_method: 'gptq', bits: 4, sym: true, group_size: 128 } }),
  },
  {
    name: 'GPTQ 8-bit sym',
    config: llama({ quantization_config: { quant_method: 'gptq', bits: 8, sym: true } }),
  },
  {
    name: 'GPTQ 4-bit asym',
    config: llama({ quantization_config: { quant_method: 'gptq', bits: 4, sym: false } }),
  },
  {
    name: 'GPTQ 3-bit',
    config: llama({ quantization_config: { quant_method: 'gptq', bits: 3, sym: true } }),
  },
  {
    name: 'GPTQ v2 format',
    config: llama({
      quantization_config: { quant_method: 'gptq', bits: 4, sym: true, checkpoint_format: 'gptq_v2' },
    }),
  },
  {
    name: 'compressed-tensors W4A16',
    config: compressed({ group_0: group({ type: 'int', num_bits: 4, group_size: 128 }, null) }),
  },
  {
    name: 'compressed-tensors W8A16',
    config: compressed({ group_0: group({ type: 'int', num_bits: 8 }, null) }),
  },
  {
    name: 'compressed-tensors W8A8 FP8',
    config: compressed({ group_0: group({ type: 'float', num_bits: 8 }, { type: 'float', num_bits: 8 }) }),
  },
  {
    name: 'compressed-tensors W8A8 INT8',
    config: compressed({ group_0: group({ type: 'int', num_bits: 8 }, { type: 'int', num_bits: 8 }) }),
  },
  {
    name: 'compressed-tensors NVFP4',
    config: compressed({
      group_0: group(
        { type: 'float', num_bits: 4, group_size: 16 },
        { type: 'float', num_bits: 4, group_size: 16 }
      ),
    }),
  },
  {
    name: 'compressed-tensors mixed groups',
    config: compressed({
      group_0: group({ type: 'int', num_bits: 4 }, null),
      group_1: group({ type: 'int', num_bits: 8 }, null),
    }),
  },
  {
    name: 'compressed-tensors sparse',
    config: compressed(
      { group_0: group({ type: 'int', num_bits: 4 }, null) },
      { sparsity_config: { format: 'sparse-24-bitmask' } }
    ),
  },
  { name: 'compressed-tensors no groups', config: compressed({}) },
  {
    name: 'bitsandbytes 4-bit',
    config: llama({
      dtype: 'bfloat16',
      quantization_config: { quant_method: 'bitsandbytes', load_in_4bit: true },
    }),
  },
  { name: 'MLX 1-bit', config: llama({ dtype: 'bfloat16', quantization: { group_size: 128, bits: 1 } }) },
  { name: 'mixed precision FP8 + NVFP4', config: llama(), hfQuant: mixed(['FP8', 'NVFP4']) },
  { name: 'mixed precision FP8 + W4A16_NVFP4', config: llama(), hfQuant: mixed(['FP8', 'W4A16_NVFP4']) },
  { name: 'mixed precision FP8_PB_WO + FP8', config: llama(), hfQuant: mixed(['FP8_PB_WO', 'FP8']) },
  { name: 'mixed precision without layers', config: llama(), hfQuant: mixed([]) },
  {
    name: 'GGUF listing',
    config: llama({ dtype: 'bfloat16' }),
    files: [{ path: 'model-Q4_K_M.gguf', size: 2 * GIB, sha256: 'aa' }],
  },
  {
    name: 'unsupported architecture',
    config: { architectures: ['GPT2LMHeadModel'], dtype: 'bfloat16', ...SHAPE },
  },
  { name: 'no architecture', config: { dtype: 'bfloat16', ...SHAPE } },
  {
    name: 'Nemotron-H with dense MLP layers',
    config: {
      architectures: ['NemotronHForCausalLM'],
      dtype: 'bfloat16',
      hybrid_override_pattern: 'M-M*',
      ...SHAPE,
    },
  },
  {
    name: 'Qwen3.5 MoE fp8 block',
    config: {
      architectures: ['Qwen3_5MoeForConditionalGeneration'],
      quantization_config: { quant_method: 'fp8', fmt: 'e4m3', weight_block_size: [128, 128] },
      text_config: SHAPE,
    },
  },
]

const card = (computeCapability: string): GpuFacts => ({
  gpu_id: `GPU-${computeCapability}`,
  name: 'Test GPU',
  compute_capability: computeCapability,
  total_vram_bytes: 80 * GIB,
  free_vram_bytes: 79 * GIB,
  driver_version: '615.00',
})

const weights: CheckpointFile[] = [
  { path: 'model-00001-of-00002.safetensors', size: GIB, sha256: 'aa' },
  { path: 'model-00002-of-00002.safetensors', size: GIB, sha256: 'bb' },
  { path: 'config.json', size: 1_024, sha256: null },
]

/** `ok`, `no` (`MODEL_INCOMPATIBLE`) or another error code, per compute capability, in `CAPABILITIES` order. */
function verdicts(entry: Case): string {
  return CAPABILITIES.map((capability) => {
    const result = checkModelCompatibility(
      {
        repository: 'acme/corpus',
        revision: 'main',
        config_json: entry.config,
        hf_quant_config_json: entry.hfQuant ?? null,
        files: [
          ...(entry.files ?? weights),
          ...(entry.hfQuant === undefined ? [] : [{ path: 'hf_quant_config.json', size: 200, sha256: null }]),
        ],
      },
      DESCRIPTOR,
      [card(capability)],
      { availableBytes: 64 * GIB, totalBytes: 64 * GIB },
      { contextLength: 8192, kvCacheFreeGpuMemoryFraction: TENSORRT_LLM_DEFAULT_KV_CACHE_FREE_FRACTION }
    )
    if (!result.verdict.ok && result.verdict.error.code !== 'MODEL_INCOMPATIBLE')
      return `${capability}:${result.verdict.error.code}`
    return `${capability}:${result.verdict.ok ? 'ok' : 'no'}`
  }).join(' ')
}

/** Recorded from the code before the shared rule (see the banner). Never edit to make this pass. */
const EXPECTED: Record<string, string> = {
  'bf16 dtype': '8.0:ok 8.6:ok 8.9:ok 9.0:ok 10.0:ok 12.0:ok',
  'fp16 dtype': '8.0:ok 8.6:ok 8.9:ok 9.0:ok 10.0:ok 12.0:ok',
  'float32 dtype': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'legacy torch_dtype': '8.0:ok 8.6:ok 8.9:ok 9.0:ok 10.0:ok 12.0:ok',
  'no dtype at all': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'VLM text_config dtype': '8.0:ok 8.6:ok 8.9:ok 9.0:ok 10.0:ok 12.0:ok',
  'ModelOpt FP8': '8.0:no 8.6:no 8.9:ok 9.0:ok 10.0:ok 12.0:ok',
  'ModelOpt FP8 + dtype': '8.0:no 8.6:no 8.9:ok 9.0:ok 10.0:ok 12.0:ok',
  'ModelOpt FP8_PB_WO': '8.0:no 8.6:no 8.9:no 9.0:ok 10.0:ok 12.0:no',
  'ModelOpt NVFP4': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:ok 12.0:ok',
  'ModelOpt W4A16_AWQ': '8.0:ok 8.6:ok 8.9:ok 9.0:ok 10.0:ok 12.0:no',
  'ModelOpt W4A8_AWQ': '8.0:no 8.6:no 8.9:ok 9.0:ok 10.0:ok 12.0:no',
  'ModelOpt W4A16_NVFP4': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:ok 12.0:ok',
  'ModelOpt MXFP8': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'ModelOpt FP8_PER_CHANNEL_PER_TOKEN': '8.0:no 8.6:no 8.9:no 9.0:ok 10.0:no 12.0:no',
  'ModelOpt FP8 with FP8 KV': '8.0:no 8.6:no 8.9:ok 9.0:ok 10.0:ok 12.0:ok',
  'hf_quant_config without quant_algo': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'config modelopt NVFP4': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:ok 12.0:ok',
  'config modelopt fp8_pb_wo': '8.0:no 8.6:no 8.9:no 9.0:ok 10.0:ok 12.0:no',
  'config modelopt without quant_algo': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'fp8 block 128x128': '8.0:no 8.6:no 8.9:no 9.0:ok 10.0:ok 12.0:no',
  'fp8 block 64x64': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'HF fp8 without blocks': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'HF fp8 null blocks': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'mxfp4': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:ok 12.0:ok',
  'awq bare': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'AutoAWQ 4-bit gemm': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'AutoAWQ w_bit 4 no version': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'AutoAWQ 4-bit gemv': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'AutoAWQ 8-bit': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'gptq bare': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'GPTQ 4-bit sym': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'GPTQ 8-bit sym': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'GPTQ 4-bit asym': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'GPTQ 3-bit': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'GPTQ v2 format': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'compressed-tensors W4A16': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'compressed-tensors W8A16': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'compressed-tensors W8A8 FP8': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'compressed-tensors W8A8 INT8': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'compressed-tensors NVFP4': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'compressed-tensors mixed groups': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'compressed-tensors sparse': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'compressed-tensors no groups': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'bitsandbytes 4-bit': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'MLX 1-bit': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'mixed precision FP8 + NVFP4': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:ok 12.0:ok',
  'mixed precision FP8 + W4A16_NVFP4': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:ok 12.0:ok',
  'mixed precision FP8_PB_WO + FP8': '8.0:no 8.6:no 8.9:no 9.0:ok 10.0:ok 12.0:no',
  'mixed precision without layers': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'GGUF listing': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'unsupported architecture': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'no architecture': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'Nemotron-H with dense MLP layers': '8.0:no 8.6:no 8.9:no 9.0:no 10.0:no 12.0:no',
  'Qwen3.5 MoE fp8 block': '8.0:no 8.6:no 8.9:no 9.0:ok 10.0:ok 12.0:no',
}

describe('TensorRT-LLM verdicts under the shared naming rule (tensorrt-llm-1.3.0rc29-r3)', () => {
  it('covers every case exactly once', () => {
    expect(new Set(CORPUS.map((entry) => entry.name)).size).toBe(CORPUS.length)
    expect(Object.keys(EXPECTED).sort()).toEqual(CORPUS.map((entry) => entry.name).sort())
  })

  it.each(CORPUS.map((entry) => [entry.name, entry] as const))('%s', (name, entry) => {
    expect(verdicts(entry)).toBe(EXPECTED[name])
  })
})
