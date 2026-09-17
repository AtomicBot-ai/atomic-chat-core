import { describe, expect, it } from 'vitest'
import { autoIncreaseCtx } from './ctx.js'
import type { CtxIncreaseOutcome, LocalTarget, PublicServerDeps } from './types.js'

function deps(sessions: LocalTarget[], increaseCtx: PublicServerDeps['increaseCtx']): PublicServerDeps {
  return {
    findLocal: (provider, id) => sessions.find((s) => s.provider === provider && s.modelId === id),
    listLocal: () => sessions,
    providers: () => new Map(),
    increaseCtx,
  }
}

const demo: LocalTarget = {
  provider: 'llamacpp-upstream',
  modelId: 'demo',
  port: 1,
  apiKey: 'k',
  isEmbedding: false,
}

describe('autoIncreaseCtx', () => {
  it('shares one reload between concurrent overflows of the same model', async () => {
    let calls = 0
    let release: (o: CtxIncreaseOutcome) => void = () => {}
    const d = deps([demo], () => {
      calls++
      return new Promise((resolve) => (release = resolve))
    })

    const both = Promise.all([
      autoIncreaseCtx(d, 'llamacpp-upstream', 'demo', 'error'),
      autoIncreaseCtx(d, 'llamacpp-upstream', 'demo', 'error'),
    ])
    release({ ok: true, new_ctx_len: 8192 })

    expect(await both).toEqual([
      { port: 1, apiKey: 'k' },
      { port: 1, apiKey: 'k' },
    ])
    expect(calls).toBe(1)
  })

  it('never grows an embedding session, and turns a declined or failed reload into no retry', async () => {
    let calls = 0
    const embed = { ...demo, modelId: 'embed', isEmbedding: true }
    const grow = deps([embed], () => {
      calls++
      return Promise.resolve({ ok: true })
    })
    expect(await autoIncreaseCtx(grow, 'llamacpp-upstream', 'embed', 'error')).toBeUndefined()
    expect(calls).toBe(0)

    const declined = deps([demo], () => Promise.resolve({ ok: false, reason: 'at_max' }))
    expect(await autoIncreaseCtx(declined, 'llamacpp-upstream', 'demo', 'error')).toBeUndefined()

    const failed = deps([demo], () => Promise.reject(new Error('boom')))
    expect(await autoIncreaseCtx(failed, 'llamacpp-upstream', 'demo', 'error')).toBeUndefined()
  })
})
