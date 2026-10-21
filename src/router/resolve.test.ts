import { describe, expect, it } from 'vitest'
import { LOCAL_SEARCH_ORDER, modelIdsMatch, resolveRemoteMedia, resolveRemoteProvider } from './resolve.js'
import type { RemoteProvider } from './resolve.js'

const provider = (name: string, models: string[] = []): RemoteProvider => ({
  provider: name,
  apiKey: `key-${name}`,
  baseUrl: `https://${name}.example/v1`,
  customHeaders: [],
  models,
})

describe('resolveRemoteProvider', () => {
  const providers = new Map([
    ['openai', provider('openai', ['gpt-5'])],
    ['openrouter', provider('openrouter')],
  ])

  it('finds the provider that lists the model', () => {
    expect(resolveRemoteProvider('gpt-5', providers)?.provider).toBe('openai')
  })

  it('reads a provider prefix before the first slash', () => {
    // An id like openrouter/anthropic/claude names its provider up front; the rest is the provider's own id.
    expect(resolveRemoteProvider('openrouter/anthropic/claude', providers)?.provider).toBe('openrouter')
  })

  it('accepts a provider key as the whole id', () => {
    expect(resolveRemoteProvider('openrouter', providers)?.provider).toBe('openrouter')
  })

  it('prefers a listing over a prefix', () => {
    const both = new Map([
      ['openai', provider('openai', ['openrouter/x'])],
      ['openrouter', provider('openrouter')],
    ])
    expect(resolveRemoteProvider('openrouter/x', both)?.provider).toBe('openai')
  })

  it('leaves a model no provider claims to the local sessions', () => {
    expect(resolveRemoteProvider('local.model', providers)).toBeUndefined()
    expect(resolveRemoteProvider('unknown/model', providers)).toBeUndefined()
  })
})

describe('modelIdsMatch', () => {
  it('folds a dot and an underscore and nothing else', () => {
    expect(modelIdsMatch('Qwen3.5-9B', 'Qwen3_5-9B')).toBe(true)
    expect(modelIdsMatch('local-model', 'local_model')).toBe(false)
    expect(modelIdsMatch('a', 'ab')).toBe(false)
  })
})

describe('LOCAL_SEARCH_ORDER', () => {
  it('searches TurboQuant, upstream, MLX, TensorRT-LLM, PrismML, vLLM, SGLang, Foundry Local, then LiteRT-LM last so no existing route moves', () => {
    // vllm after atomic-prism, which core 0.10.0 shipped (change add-vllm-runtime, D11); sglang after
    // vllm by the same rule (change add-sglang-runtime, D8); foundry-local after sglang (add-foundry-local, D5);
    // litert-lm after foundry-local (add-litert-lm-runtime, task 6.1).
    expect(LOCAL_SEARCH_ORDER).toEqual([
      'llamacpp',
      'llamacpp-upstream',
      'mlx',
      'tensorrt-llm',
      'atomic-prism',
      'vllm',
      'sglang',
      'foundry-local',
      'litert-lm',
    ])
  })
})

describe('resolveRemoteMedia', () => {
  const withMedia = (name: string, ids: Array<[string, 'image' | 'video']>): RemoteProvider => ({
    ...provider(name, ['chat-model']),
    media: { models: ids.map(([id, kind]) => ({ id, kind })) },
  })
  const providers = new Map([
    [
      'openrouter',
      withMedia('openrouter', [
        ['google/veo-3.1', 'video'],
        ['google/gemini-nano-banana-2.1', 'image'],
      ]),
    ],
    ['aimlapi', withMedia('aimlapi', [['google/gemini-nano-banana-2.1', 'image']])],
  ])

  it('reads a registered provider prefix when that provider lists the rest', () => {
    expect(resolveRemoteMedia('aimlapi/google/gemini-nano-banana-2.1', 'image', providers)).toEqual({
      provider: 'aimlapi',
      model: 'google/gemini-nano-banana-2.1',
    })
  })

  it('takes the first provider in registration order for a bare id, of the asked kind only', () => {
    expect(resolveRemoteMedia('google/gemini-nano-banana-2.1', 'image', providers)?.provider).toBe(
      'openrouter'
    )
    expect(resolveRemoteMedia('google/veo-3.1', 'image', providers)).toBeUndefined()
    expect(resolveRemoteMedia('chat-model', 'image', providers)).toBeUndefined()
  })

  it('skips a provider without media, and a named provider that does not list the rest', () => {
    const mixed = new Map([
      ['openai', provider('openai', ['gpt-5'])],
      ['aimlapi', withMedia('aimlapi', [['x', 'image']])],
    ])
    expect(resolveRemoteMedia('openai/x', 'image', mixed)).toBeUndefined()
    expect(resolveRemoteMedia('aimlapi/y', 'image', mixed)).toBeUndefined()
    expect(resolveRemoteMedia('x', 'image', mixed)).toEqual({ provider: 'aimlapi', model: 'x' })
  })
})
