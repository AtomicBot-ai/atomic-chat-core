import { describe, expect, it } from 'vitest'
import { LOCAL_SEARCH_ORDER, modelIdsMatch, resolveRemoteProvider } from './resolve.js'
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
  it('searches TurboQuant, then upstream, then MLX', () => {
    expect(LOCAL_SEARCH_ORDER).toEqual(['llamacpp', 'llamacpp-upstream', 'mlx'])
  })
})
