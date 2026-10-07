import { describe, expect, it } from 'vitest'
import type { GpuFacts, RuntimeDescriptor } from '../../contracts/index.js'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseRuntimeDescriptor } from '../environment/index.js'
import { checkCheckpoint, type CheckpointFile, type ManagedCheckEngine } from './compatibility.js'

/**
 * The check skeleton every managed engine shares (change `add-vllm-runtime`, design D7): the static
 * gates are the same for all, the memory rule and the loader's checkpoint quirks are the engine's.
 * A test engine with its own hooks stands in for the second engine here.
 */
const GIB = 1024 ** 3
const DESCRIPTOR: RuntimeDescriptor = {
  ...parseRuntimeDescriptor(readRuntimeFixture('tensorrt-llm-1.3.0rc29-r3.json')),
  engine_id: 'test-engine',
  descriptor_id: 'test-engine-1-r1',
  quantization: [
    { format: 'bf16', min_compute_capability: '8.0', excluded_compute_capabilities: [] },
    { format: 'gptq_w4a16', min_compute_capability: '8.0', excluded_compute_capabilities: [] },
    { format: 'ct_w8a8_int8', min_compute_capability: '8.0', excluded_compute_capabilities: ['12.0'] },
  ],
  curated_models: [],
}
const card = (over: Partial<GpuFacts> = {}): GpuFacts => ({
  gpu_id: 'GPU-a',
  name: 'RTX 4070 Laptop',
  compute_capability: '8.9',
  total_vram_bytes: 8 * GIB,
  free_vram_bytes: 7 * GIB,
  driver_version: '580.95.05',
  ...over,
})
const files = (weightBytes: number): CheckpointFile[] => [
  { path: 'model.safetensors', size: weightBytes, sha256: 'aa' },
  { path: 'config.json', size: 1_000, sha256: null },
]
const HOST = { availableBytes: 32 * GIB, totalBytes: 32 * GIB }

/** Needs twice the weights plus 1 GiB, and refuses any architecture named `Quirky*`. */
const testEngine: ManagedCheckEngine = {
  engineId: 'test-engine',
  checkpointProblems: (architecture) =>
    architecture.startsWith('Quirky')
      ? { message: 'This loader cannot read Quirky checkpoints.', details: `architecture=${architecture}` }
      : null,
  memoryNeed: (_gpu, checkpoint) => {
    const neededBytes = 2 * checkpoint.weightBytesTotal + GIB
    return { neededBytes, details: `weight_bytes=${checkpoint.weightBytesTotal} needed_bytes=${neededBytes}` }
  },
}

const check = (config: Record<string, unknown>, weightBytes = 2 * GIB, gpus = [card()]) =>
  checkCheckpoint(
    {
      repository: 'acme/model',
      revision: 'main',
      config_json: config,
      hf_quant_config_json: null,
      files: files(weightBytes),
    },
    DESCRIPTOR,
    gpus,
    HOST,
    testEngine
  )

const llama = (extra: Record<string, unknown>) => ({ architectures: ['LlamaForCausalLM'], ...extra })

describe('checkCheckpoint (the shared skeleton)', () => {
  it('passes a format in this engine’s matrix, reporting the shared format name', () => {
    const verdict = check(llama({ quantization_config: { quant_method: 'gptq', bits: 4, sym: true } }))
    expect(verdict.verdict).toEqual({ ok: true })
    expect(verdict.quantization_format).toBe('gptq_w4a16')
  })

  it('the engine’s memoryNeed decides the memory line, with its numbers and the free bytes', () => {
    // 3 GiB of weights: the test rule needs 7 GiB, the card has 7 GiB free → fits; 3.5 GiB → does not.
    expect(check(llama({ dtype: 'bfloat16' }), 3 * GIB).verdict).toEqual({ ok: true })
    const refused = check(llama({ dtype: 'bfloat16' }), 3.5 * GIB)
    expect(refused.verdict).toMatchObject({
      ok: false,
      error: {
        code: 'MODEL_INCOMPATIBLE',
        details: `weight_bytes=${3.5 * GIB} needed_bytes=${8 * GIB} free_bytes=${7 * GIB}`,
      },
    })
    // The person reads how far off it is, so they know whether a setting change can close the gap.
    expect(refused.verdict.ok === false && refused.verdict.error.message).toMatch(
      /need 8\.0 GiB.*7\.0 GiB is free/
    )
  })

  it('the memory line reports the other cards the engine’s rule would fit', () => {
    const big = card({ gpu_id: 'GPU-b', total_vram_bytes: 24 * GIB, free_vram_bytes: 1 * GIB })
    const verdict = checkCheckpoint(
      {
        repository: 'acme/model',
        revision: 'main',
        config_json: llama({ dtype: 'bfloat16' }),
        hf_quant_config_json: null,
        files: files(5 * GIB),
        gpu_id: 'GPU-b',
      },
      DESCRIPTOR,
      [card({ free_vram_bytes: 20 * GIB }), big],
      HOST,
      testEngine
    )
    expect(verdict.checked_gpu_id).toBe('GPU-b')
    expect(verdict.fits_other_gpus).toEqual(['GPU-a'])
  })

  it('the engine’s checkpointProblems refuse a supported architecture with its own reason', () => {
    const quirky = { ...DESCRIPTOR, supported_architectures: ['QuirkyForCausalLM'] }
    const verdict = checkCheckpoint(
      {
        repository: 'acme/model',
        revision: 'main',
        config_json: { architectures: ['QuirkyForCausalLM'], dtype: 'bfloat16' },
        hf_quant_config_json: null,
        files: files(GIB),
      },
      quirky,
      [card()],
      HOST,
      testEngine
    )
    expect(verdict.verdict).toMatchObject({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE', message: 'This loader cannot read Quirky checkpoints.' },
    })
  })

  it('a format the rule names but this engine’s descriptor lacks names the format and the engine', () => {
    const verdict = check(llama({ quantization_config: { quant_method: 'awq', bits: 4 } }))
    expect(verdict.quantization_format).toBe('autoawq_w4a16')
    expect(verdict.verdict).toMatchObject({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE', details: 'autoawq_w4a16' },
    })
    if (!verdict.verdict.ok)
      expect(verdict.verdict.error.message).toContain('test-engine does not support "autoawq_w4a16"')
  })

  it('an exclusion in this engine’s matrix refuses that card', () => {
    const int8 = llama({
      quantization_config: {
        quant_method: 'compressed-tensors',
        config_groups: {
          g: { weights: { type: 'int', num_bits: 8 }, input_activations: { type: 'int', num_bits: 8 } },
        },
      },
    })
    expect(check(int8).verdict).toEqual({ ok: true })
    expect(check(int8, 2 * GIB, [card({ compute_capability: '12.0' })]).verdict).toMatchObject({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE' },
    })
  })

  it('GGUF and an unrecognised format are refused before anything else, naming the engine for GGUF', () => {
    const gguf = checkCheckpoint(
      {
        repository: 'acme/model',
        revision: 'main',
        config_json: llama({ dtype: 'bfloat16' }),
        hf_quant_config_json: null,
        files: [{ path: 'm.gguf', size: GIB, sha256: 'aa' }],
      },
      DESCRIPTOR,
      [card()],
      HOST,
      testEngine
    )
    if (gguf.verdict.ok) throw new Error('GGUF must be refused')
    expect(gguf.verdict.error.message).toContain('not supported by test-engine')
    expect(check(llama({ quantization_config: { quant_method: 'bitsandbytes' } })).verdict).toMatchObject({
      ok: false,
      error: { code: 'MODEL_INCOMPATIBLE', message: expect.stringContaining('bitsandbytes') },
    })
  })

  it('no GPU at all is a missing prerequisite naming the engine', () => {
    expect(() => check(llama({ dtype: 'bfloat16' }), GIB, [])).toThrow(
      /test-engine compatibility cannot be checked/
    )
  })
})
