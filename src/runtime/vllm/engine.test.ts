import { describe, expect, it } from 'vitest'
import type { GpuFacts } from '../../contracts/index.js'
import { ManagedEngineRegistry } from '../managed-engines/index.js'
import { VLLM_CONTEXT_OVERFLOW_BODIES } from '../../../test/helpers/vllm-log-fixtures.js'
import { VLLM_ENGINE, vllmRoutePolicy } from './engine.js'

/** Change `add-vllm-runtime`, task 3.4: vLLM as a managed engine of the registry. */
const GiB = 1024 ** 3

describe('VLLM_ENGINE', () => {
  it('is vllm everywhere — engine, provider, adapter, descriptor source — and registers', () => {
    expect(VLLM_ENGINE.engine_id).toBe('vllm')
    expect(VLLM_ENGINE.provider).toBe('vllm')
    expect(VLLM_ENGINE.adapter.id).toBe('vllm')
    expect(VLLM_ENGINE.descriptor).toEqual({
      engine_id: 'vllm',
      label: 'vLLM',
      url: 'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/vllm.json',
    })
    expect(() => new ManagedEngineRegistry().register(VLLM_ENGINE)).not.toThrow()
  })

  it('reads its own settings and refuses an invalid one before anything else', () => {
    expect(VLLM_ENGINE.settings({ max_num_seqs: 4 }).max_num_seqs).toBe(4)
    expect(() => VLLM_ENGINE.settings({ max_num_seqs: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    )
  })

  it('plans the launch from the re-probed card', () => {
    const gpu: GpuFacts = {
      gpu_id: 'GPU-1',
      name: 'RTX 4070',
      compute_capability: '8.9',
      total_vram_bytes: 8 * GiB,
      free_vram_bytes: 6.5 * GiB,
      driver_version: '580.95.05',
    }
    const plan = VLLM_ENGINE.launchPlan?.(
      VLLM_ENGINE.settings({ kv_cache_memory_gib: 1.5 }),
      {
        weightBytesTotal: GiB,
        configJson: { num_hidden_layers: 2, num_attention_heads: 2, head_dim: 64 },
        hfQuantConfigJson: null,
      },
      gpu,
      { availableBytes: 0, totalBytes: 0 }
    )
    // The KV cache size setting is passed as bytes; the share is core's auto from the re-probed card.
    expect(plan).toMatchObject({ kvCacheMemoryBytes: 1.5 * GiB, gpuMemoryUtilization: 0.625 })
  })
})

describe('vllmRoutePolicy', () => {
  it('declares vLLM’s routes, maps its context overflow, and refuses tools when the session has none', () => {
    const policy = vllmRoutePolicy(
      {
        tools: false,
        reasoning: false,
        structured_output: true,
        vision: false,
        embeddings: false,
        responses: false,
      },
      { contextLength: 8192, maxOutputTokens: 1024 }
    )
    expect(policy.routes.map((route) => route.path)).toEqual([
      '/v1/chat/completions',
      '/v1/completions',
      '/v1/models',
    ])
    expect(policy.tools).toBe(false)
    expect(policy.contextLength).toBe(8192)
    expect(
      (policy.mapError?.(400, VLLM_CONTEXT_OVERFLOW_BODIES.inputs) as { error: { code: string } }).error.code
    ).toBe('context_length_exceeded')
    // A session the core did not start keeps the routes and the mapping, and leaves tools to the engine.
    expect(vllmRoutePolicy(null).tools).toBe(true)
  })
})
