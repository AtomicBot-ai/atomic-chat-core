import { describe, expect, it } from 'vitest'
import { fakeEngineFetch, words } from '../../../test/helpers/fake-engine-fetch.js'
import { PromptCalibration, UNCALIBRATED_MARGIN } from './calibration.js'
import { countPromptTokens } from './count.js'
import type { CompactionTarget } from './engine.js'
import { MEDIA_PART_TOKENS, estimatePromptTokens } from './estimate.js'

const llama: CompactionTarget = { provider: 'llamacpp-upstream', modelId: 'demo', port: 8080, apiKey: 'k' }
const vllm: CompactionTarget = {
  provider: 'vllm',
  modelId: 'Qwen/Qwen3-8B',
  port: 8081,
  apiKey: 'gw',
  policy: { routes: [{ method: 'POST', path: '/tokenize' }] },
}
const mlx: CompactionTarget = { provider: 'mlx', modelId: 'm', port: 8082, apiKey: '' }
const tool = { type: 'function', function: { name: 'f', parameters: {} } }
const image = { type: 'image_url', image_url: { url: 'http://x/y.png' } }

describe('countPromptTokens', () => {
  it("renders llama.cpp's template with the tools, then tokenizes the prompt, with the session key", async () => {
    const engine = fakeEngineFetch()
    const request = {
      messages: [{ role: 'user', content: words(40) }],
      tools: [tool],
      chat_template_kwargs: { enable_thinking: false },
    }
    expect(await countPromptTokens(llama, request, { fetch: engine.fetch })).toEqual({
      tokens: 40,
      exact: true,
    })
    expect(engine.calls.map((c) => [c.path, c.authorization])).toEqual([
      ['/apply-template', 'Bearer k'],
      ['/tokenize', 'Bearer k'],
    ])
    expect(engine.calls[0]?.body).toEqual(request)
    expect(engine.calls[1]?.body).toEqual({ content: words(40) })
  })

  it('leaves media out of the template and prices each part apart, which is no longer exact', async () => {
    const engine = fakeEngineFetch()
    const counted = await countPromptTokens(
      llama,
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }, image] }] },
      { fetch: engine.fetch }
    )
    expect(counted).toEqual({ tokens: 3 + MEDIA_PART_TOKENS, exact: false })
    expect(engine.calls[0]?.body['messages']).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'what is this' }] },
    ])
  })

  it('asks a session that declares the chat /tokenize for its count', async () => {
    const engine = fakeEngineFetch()
    const counted = await countPromptTokens(
      vllm,
      { messages: [{ role: 'user', content: words(12) }], tools: [tool] },
      { fetch: engine.fetch }
    )
    expect(counted).toEqual({ tokens: 12, exact: true })
    expect(engine.calls).toEqual([
      {
        path: '/tokenize',
        authorization: 'Bearer gw',
        body: {
          model: 'Qwen/Qwen3-8B',
          messages: [{ role: 'user', content: words(12) }],
          tools: [tool],
          add_generation_prompt: true,
        },
      },
    ])
  })

  it.each([
    ['an error status', { '/apply-template': () => ({ status: 400, json: { error: 'no tools' } }) }],
    ['an unreachable engine', { '/apply-template': () => 'throw' as const }],
    ['an answer without a prompt', { '/apply-template': () => ({ json: {} }) }],
    ['tokens that are not a list', { '/tokenize': () => ({ json: { tokens: 7 } }) }],
  ])('estimates when the engine count fails: %s', async (_name, replies) => {
    const engine = fakeEngineFetch({ replies })
    const request = { messages: [{ role: 'user', content: words(300) }] }
    expect(await countPromptTokens(llama, request, { fetch: engine.fetch })).toEqual({
      tokens: Math.ceil(estimatePromptTokens(request) * UNCALIBRATED_MARGIN),
      exact: false,
    })
  })

  it('estimates an engine that cannot count, scaled by what its session taught', async () => {
    const engine = fakeEngineFetch()
    const request = { messages: [{ role: 'user', content: words(500) }] }
    const estimate = estimatePromptTokens(request)
    const calibration = new PromptCalibration()
    expect(await countPromptTokens(mlx, request, { fetch: engine.fetch, calibration })).toEqual({
      tokens: Math.ceil(estimate * UNCALIBRATED_MARGIN),
      exact: false,
    })
    calibration.learn(mlx, estimate, Math.round(estimate * 0.75))
    expect((await countPromptTokens(mlx, request, { fetch: engine.fetch, calibration })).tokens).toBe(
      Math.ceil(estimate * (Math.round(estimate * 0.75) / estimate))
    )
    expect(engine.calls).toEqual([])
  })

  it('a count of a vLLM answer that is not a count falls back to the estimate', async () => {
    const engine = fakeEngineFetch({ replies: { '/tokenize': () => ({ json: { count: -1 } }) } })
    expect(
      (await countPromptTokens(vllm, { messages: [{ role: 'user', content: 'x' }] }, { fetch: engine.fetch }))
        .exact
    ).toBe(false)
  })
})
