import { describe, expect, it } from 'vitest'
import { LOCAL_SEARCH_ORDER } from '../../router/index.js'
import { isLlamaCppServer } from '../public/index.js'
import { countMethod, isLlamaCppFamily, sessionHeaders, takesThinkingSwitch } from './engine.js'
import type { CompactionTarget } from './engine.js'

const target = (over: Partial<CompactionTarget> = {}): CompactionTarget => ({
  provider: 'llamacpp-upstream',
  modelId: 'demo',
  port: 1,
  apiKey: 'k',
  ...over,
})

describe('isLlamaCppFamily', () => {
  it("names the same engines as the public server's llama.cpp check", () => {
    for (const provider of LOCAL_SEARCH_ORDER) {
      expect(isLlamaCppFamily(provider), provider).toBe(isLlamaCppServer(provider))
    }
    expect(isLlamaCppFamily('foundation-models')).toBe(false)
  })
})

describe('takesThinkingSwitch', () => {
  it.each([
    ['llamacpp', true],
    ['llamacpp-upstream', true],
    ['atomic-prism', true],
    ['vllm', true],
    ['sglang', true],
    ['mlx', false],
    ['tensorrt-llm', false],
    ['foundation-models', false],
    ['strata', false],
  ])('%s → %s', (provider, expected) => {
    expect(takesThinkingSwitch(provider)).toBe(expected)
  })
})

describe('countMethod', () => {
  const tokenize = { routes: [{ method: 'POST', path: '/tokenize' }] }
  it.each([
    ['llama.cpp counts through its template', target(), 'llamacpp'],
    ['the fork as well', target({ provider: 'atomic-prism' }), 'llamacpp'],
    [
      'a session that declares the chat /tokenize',
      target({ provider: 'vllm', policy: tokenize }),
      'tokenize',
    ],
    [
      'a declared session without it',
      target({
        provider: 'tensorrt-llm',
        policy: { routes: [{ method: 'POST', path: '/v1/chat/completions' }] },
      }),
      'estimate',
    ],
    [
      'a GET /tokenize is not the chat one',
      target({ provider: 'geniex', policy: { routes: [{ method: 'GET', path: '/tokenize' }] } }),
      'estimate',
    ],
    ['MLX', target({ provider: 'mlx', apiKey: '' }), 'estimate'],
    ['Apple Foundation Models', target({ provider: 'foundation-models' }), 'estimate'],
  ] as const)('%s', (_name, session, expected) => {
    expect(countMethod(session)).toBe(expected)
  })
})

describe('sessionHeaders', () => {
  it('sends the session key, and no Authorization to an engine without one', () => {
    expect(sessionHeaders(target())).toEqual({
      'Content-Type': 'application/json',
      'Authorization': 'Bearer k',
    })
    expect(sessionHeaders(target({ provider: 'mlx', apiKey: '' }))).toEqual({
      'Content-Type': 'application/json',
    })
  })
})
