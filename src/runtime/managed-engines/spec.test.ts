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
    engine_id: 'test-engine',
    provider: 'test-engine',
    label: 'Test engine',
    descriptor: { engine_id: 'test-engine', label: 'Test engine', url: 'https://conf/test-engine.json' },
    ...over,
  }) as ManagedEngineSpec

describe('ManagedEngineRegistry', () => {
  it('lists engines in registration order and finds them by provider id', () => {
    const registry = new ManagedEngineRegistry()
    registry.register(TENSORRT_LLM_ENGINE)
    registry.register(second())
    expect(registry.list().map((spec) => spec.engine_id)).toEqual(['tensorrt-llm', 'test-engine'])
    expect(registry.get('test-engine')?.label).toBe('Test engine')
    expect(registry.get('llamacpp')).toBeUndefined()
    expect(registry.has('tensorrt-llm')).toBe(true)
    expect(registry.descriptorSources().map((source) => source.engine_id)).toEqual([
      'tensorrt-llm',
      'test-engine',
    ])
  })

  it('регистрация с несовпадающим id падает: provider id other than engine_id', () => {
    expect(() => new ManagedEngineRegistry().register(second({ provider: 'other-provider' }))).toThrow(
      /engine_id "test-engine" must equal its provider id "other-provider"/
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
