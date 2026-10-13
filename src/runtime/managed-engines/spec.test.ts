import { describe, expect, it } from 'vitest'
import { TENSORRT_LLM_ENGINE } from '../tensorrt-llm/index.js'
import { ManagedEngineRegistry, managedModelCheckOf, type ManagedEngineSpec } from './spec.js'

/**
 * The managed engine registry (change `add-vllm-runtime`, design D3): `engine_id` is the provider id
 * everywhere — residency leftovers, the store, the removal's unloader — so a spec that says otherwise
 * fails when core starts, never silently later.
 */
const second = (over: Partial<ManagedEngineSpec> = {}): ManagedEngineSpec =>
  ({
    ...TENSORRT_LLM_ENGINE,
    engine_id: 'vllm',
    provider: 'vllm',
    label: 'Second engine',
    descriptor: { engine_id: 'vllm', label: 'Second engine', url: 'https://conf/vllm.json' },
    ...over,
  }) as ManagedEngineSpec

describe('ManagedEngineRegistry', () => {
  it('lists engines in registration order and finds them by provider id', () => {
    const registry = new ManagedEngineRegistry()
    registry.register(TENSORRT_LLM_ENGINE)
    registry.register(second())
    expect(registry.list().map((spec) => spec.engine_id)).toEqual(['tensorrt-llm', 'vllm'])
    expect(registry.get('vllm')?.label).toBe('Second engine')
    expect(registry.get('llamacpp')).toBeUndefined()
    expect(registry.has('tensorrt-llm')).toBe(true)
    expect(registry.descriptorSources().map((source) => source.engine_id)).toEqual(['tensorrt-llm', 'vllm'])
  })

  it('регистрация с несовпадающим id падает: provider id other than engine_id', () => {
    expect(() => new ManagedEngineRegistry().register(second({ provider: 'other-provider' }))).toThrow(
      /engine_id "vllm" must equal its provider id "other-provider"/
    )
  })

  // Change add-sglang-runtime, D1: the provider lists core keeps by hand (the public server's
  // Responses lookup, the model store's paths, the registry() overloads) read MANAGED_PROVIDER_IDS, so
  // an engine missing from it would load and then be invisible to them.
  it('спека вне списка managed-провайдеров: refuses an engine missing from MANAGED_PROVIDER_IDS', () => {
    const outside = second({
      engine_id: 'test-engine',
      provider: 'test-engine',
      descriptor: { engine_id: 'test-engine', label: 'Test engine', url: 'https://conf/test-engine.json' },
    })
    expect(() => new ManagedEngineRegistry().register(outside)).toThrow(
      /test-engine is not in MANAGED_PROVIDER_IDS \(tensorrt-llm, vllm, sglang\)/
    )
  })

  it('refuses a descriptor source of another engine, and a second registration of one id', () => {
    const registry = new ManagedEngineRegistry()
    expect(() =>
      registry.register(
        second({ descriptor: { engine_id: 'tensorrt-llm', label: 'x', url: 'https://conf/x.json' } })
      )
    ).toThrow(/descriptor source/)
    registry.register(TENSORRT_LLM_ENGINE)
    expect(() => registry.register(TENSORRT_LLM_ENGINE)).toThrow(/already registered/)
  })

  it('TensorRT-LLM is registered as itself: engine, provider, descriptor and adapter agree', () => {
    expect(TENSORRT_LLM_ENGINE.engine_id).toBe('tensorrt-llm')
    expect(TENSORRT_LLM_ENGINE.provider).toBe('tensorrt-llm')
    expect(TENSORRT_LLM_ENGINE.descriptor.engine_id).toBe('tensorrt-llm')
    expect(TENSORRT_LLM_ENGINE.adapter.id).toBe('tensorrt-llm')
  })
})

describe('managedModelCheckOf', () => {
  it('reads the saved card and sizes the memory rule from the engine’s own settings', () => {
    const check = managedModelCheckOf(TENSORRT_LLM_ENGINE)
    expect(check.engineId).toBe('tensorrt-llm')
    expect(check.gpuIdOf({ gpu_id: 'GPU-1' })).toBe('GPU-1')
    expect(check.gpuIdOf({})).toBeNull()
    expect(check.checkEngineOf({}).engineId).toBe('tensorrt-llm')
  })
})
