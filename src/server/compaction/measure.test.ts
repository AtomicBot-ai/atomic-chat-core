import { describe, expect, it } from 'vitest'
import type { ContextPlan, LocalProviderId } from '../../contracts/index.js'
import type { CompactionTarget } from './engine.js'
import { SessionPlans, compactFailureError, contextMeasureResult } from './measure.js'

describe('contextMeasureResult', () => {
  it.each([
    [
      'llama.cpp with both windows',
      'llamacpp-upstream',
      8192,
      32768,
      { windowTokens: 8192, maxWindowTokens: 32768, resize: 'reload', supportsPromptProgress: true },
    ],
    [
      'a managed engine',
      'vllm',
      4096,
      undefined,
      { windowTokens: 4096, resize: 'restart', supportsPromptProgress: false },
    ],
    [
      'Foundation Models, no window',
      'foundation-models',
      undefined,
      undefined,
      { resize: 'fixed', supportsPromptProgress: false },
    ],
    [
      'a provider that is not local',
      'cloud',
      undefined,
      undefined,
      { resize: 'fixed', supportsPromptProgress: false },
    ],
  ] as const)('%s', (_name, provider, window, maxWindow, expected) => {
    expect(
      contextMeasureResult(provider as LocalProviderId, { tokens: 100, exact: true }, window, maxWindow)
    ).toEqual({ promptTokens: 100, exact: true, ...expected })
  })
})

describe('compactFailureError', () => {
  it('tells the caller there is nothing to summarize, and the engine that it failed', () => {
    expect(
      compactFailureError({ ok: false, reason: 'nothing_to_compact', message: 'only one turn' }, 'mlx', 'm')
    ).toMatchObject({ code: 'INVALID_ARGUMENT', message: 'only one turn', details: 'mlx/m' })
    expect(
      compactFailureError({ ok: false, reason: 'summary_failed', message: '503: Loading model' }, 'mlx', 'm')
    ).toMatchObject({ code: 'UPSTREAM_ERROR', details: '503: Loading model' })
  })
})

describe('SessionPlans', () => {
  const llama = (over: Partial<CompactionTarget> = {}): CompactionTarget => ({
    provider: 'llamacpp-upstream',
    modelId: 'demo',
    port: 1,
    apiKey: 'k',
    ...over,
  })
  const plan = (maxCtx: number): ContextPlan => ({ recommendedCtx: 8192, maxCtx, basis: 'unified' })

  it('reads each session’s plan once, for the engines that grow by reload only', async () => {
    const asked: string[] = []
    const plans = new SessionPlans(async (provider, modelId) => {
      asked.push(`${provider}/${modelId}`)
      return modelId === 'zero' ? plan(0) : modelId === 'none' ? undefined : plan(65536)
    })
    expect(await plans.maxWindow(llama())).toBe(65536)
    expect(await plans.maxWindow(llama())).toBe(65536)
    expect(await plans.maxWindow(llama({ modelId: 'zero' }))).toBeUndefined()
    expect(await plans.maxWindow(llama({ modelId: 'none' }))).toBeUndefined()
    expect(await plans.maxWindow(llama({ provider: 'vllm' }))).toBeUndefined()
    // A reload is a new session, asked again.
    expect(await plans.maxWindow(llama({ generation: 'g2' }))).toBe(65536)
    expect(asked).toEqual([
      'llamacpp-upstream/demo',
      'llamacpp-upstream/zero',
      'llamacpp-upstream/none',
      'llamacpp-upstream/demo',
    ])
  })

  it('answers no maximum for an unreadable plan or without a reader, and starts over once full', async () => {
    expect(await new SessionPlans(undefined).maxWindow(llama())).toBeUndefined()
    expect(
      await new SessionPlans(() => Promise.reject(new Error('no gguf'))).maxWindow(llama())
    ).toBeUndefined()
    let reads = 0
    const small = new SessionPlans(async () => {
      reads++
      return plan(4096)
    }, 1)
    await small.maxWindow(llama({ port: 1 }))
    await small.maxWindow(llama({ port: 2 }))
    await small.maxWindow(llama({ port: 1 }))
    expect(reads).toBe(3)
  })
})
