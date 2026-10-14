import { describe, expect, it } from 'vitest'
import type { GpuFacts } from '../../contracts/index.js'
import { ManagedEngineRegistry } from '../managed-engines/index.js'
import { SGLANG_CONTEXT_OVERFLOW_BODIES } from '../../../test/helpers/sglang-log-fixtures.js'
import { SGLANG_ENGINE, sglangRoutePolicy } from './engine.js'

/** Change `add-sglang-runtime`, task 2.4: SGLang as a managed engine of the registry. */
const GiB = 1024 ** 3

describe('SGLANG_ENGINE', () => {
  it('is sglang everywhere — engine, provider, adapter, descriptor source — and registers', () => {
    expect(SGLANG_ENGINE.engine_id).toBe('sglang')
    expect(SGLANG_ENGINE.provider).toBe('sglang')
    expect(SGLANG_ENGINE.adapter.id).toBe('sglang')
    expect(SGLANG_ENGINE.descriptor).toEqual({
      engine_id: 'sglang',
      label: 'SGLang',
      url: 'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/sglang.json',
    })
    expect(() => new ManagedEngineRegistry().register(SGLANG_ENGINE)).not.toThrow()
  })

  it('reads its own settings and refuses an invalid one before anything else', () => {
    expect(SGLANG_ENGINE.settings({ max_running_requests: 4 }).max_running_requests).toBe(4)
    expect(() => SGLANG_ENGINE.settings({ max_running_requests: 0 })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' })
    )
    expect(SGLANG_ENGINE.check(SGLANG_ENGINE.settings({})).engineId).toBe('sglang')
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
    const plan = SGLANG_ENGINE.launchPlan?.(
      SGLANG_ENGINE.settings({}),
      {
        weightBytesTotal: GiB,
        configJson: { num_hidden_layers: 2, num_attention_heads: 2, head_dim: 64 },
        hfQuantConfigJson: null,
      },
      gpu,
      { availableBytes: 0, totalBytes: 0 }
    )
    expect(plan).toEqual({ memFractionStatic: 0.6923, multimodal: false })
  })
})

describe('sglangRoutePolicy', () => {
  it('declares SGLang’s routes, maps its context overflow, and refuses tools when the session has none', () => {
    const policy = sglangRoutePolicy(
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
      (policy.mapError?.(400, SGLANG_CONTEXT_OVERFLOW_BODIES.input) as { error: { code: string } }).error.code
    ).toBe('context_length_exceeded')
    // A session the core did not start keeps the routes and the mapping, and leaves tools to the engine.
    expect(sglangRoutePolicy(null).tools).toBe(true)
  })
})
