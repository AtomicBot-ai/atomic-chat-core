import { describe, expect, it } from 'vitest'
import { noThinkingTemplateKwargs } from './thinking.js'

const ask = (extra: Record<string, unknown> = {}) => ({
  model: 'demo',
  max_tokens: 32000,
  messages: [{ role: 'user', content: 'how are you?' }],
  ...extra,
})

describe('noThinkingTemplateKwargs', () => {
  it.each(['llamacpp', 'llamacpp-upstream', 'atomic-prism'] as const)(
    'turns the template thinking off on %s for a request with no thinking field',
    (provider) => {
      expect(noThinkingTemplateKwargs(provider, ask())).toEqual({ enable_thinking: false })
    }
  )

  it('turns it off for thinking disabled or null too', () => {
    expect(noThinkingTemplateKwargs('llamacpp', ask({ thinking: { type: 'disabled' } }))).toEqual({
      enable_thinking: false,
    })
    expect(noThinkingTemplateKwargs('llamacpp', ask({ thinking: null }))).toEqual({ enable_thinking: false })
  })

  it('leaves a request that asks for thinking as it is', () => {
    for (const thinking of [
      { type: 'enabled', budget_tokens: 2048 },
      { type: 'adaptive' },
      { type: 'something-new' },
      'on',
    ]) {
      expect(noThinkingTemplateKwargs('llamacpp-upstream', ask({ thinking })), JSON.stringify(thinking)).toBe(
        undefined
      )
    }
  })

  it('keeps the client kwargs, and never overrides a switch the client set itself', () => {
    expect(
      noThinkingTemplateKwargs(
        'llamacpp-upstream',
        ask({ chat_template_kwargs: { reasoning_effort: 'low' } })
      )
    ).toEqual({ reasoning_effort: 'low', enable_thinking: false })
    for (const extra of [
      { chat_template_kwargs: { enable_thinking: true } },
      { extra_params: { chat_template_kwargs: { enable_thinking: true } } },
      { extra_params: { reasoning_effort: 'high' } },
      { chat_template_kwargs: 'not-an-object' },
    ]) {
      expect(noThinkingTemplateKwargs('llamacpp-upstream', ask(extra)), JSON.stringify(extra)).toBe(undefined)
    }
  })

  it('leaves engines other than llama.cpp, and bodies that are not objects, alone', () => {
    for (const provider of ['mlx', 'vllm', 'sglang', 'tensorrt-llm'] as const) {
      expect(noThinkingTemplateKwargs(provider, ask()), provider).toBe(undefined)
    }
    expect(noThinkingTemplateKwargs('llamacpp', [])).toBe(undefined)
  })
})
