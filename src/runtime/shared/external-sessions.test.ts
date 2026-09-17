import { describe, expect, it } from 'vitest'
import type { CoreEvents } from '../../contracts/index.js'
import { ExternalSessions } from './external-sessions.js'

function registry(options: { ttlMs?: number; ctxTimeoutMs?: number } = {}) {
  let clock = 1_000
  const events: Array<{ name: keyof CoreEvents; payload: unknown }> = []
  const sessions = new ExternalSessions({
    emit: (name, payload) => events.push({ name, payload }),
    now: () => clock,
    ...options,
  })
  return { sessions, events, advance: (ms: number) => (clock += ms) }
}

const mlx = { provider: 'mlx', model_id: 'qwen-mlx', port: 5001, api_key: '', is_embedding: false, pid: 42 }

describe('ExternalSessions', () => {
  it('replaces an owner snapshot, lists it for routing and refuses an older generation', () => {
    const { sessions, events } = registry()
    sessions.publish('app', 2, [mlx])
    expect(sessions.find('mlx', (id) => id === 'qwen-mlx')).toMatchObject({ owner: 'app', port: 5001 })

    expect(() => sessions.publish('app', 1, [])).toThrow(/stale registration for app/)
    sessions.publish('app', 2, [{ ...mlx, port: 5002 }])
    expect(sessions.list()).toEqual([{ ...mlx, port: 5002, owner: 'app' }])
    expect(events.map((e) => e.name)).toEqual(['external-sessions:changed', 'external-sessions:changed'])
  })

  it('does not let a late unregister from the previous generation remove the new one', () => {
    const { sessions } = registry()
    sessions.publish('app', 1, [mlx])
    sessions.publish('app', 2, [{ ...mlx, port: 5002 }])
    expect(sessions.unregister('app', 1)).toBe(false)
    expect(sessions.list()[0]?.port).toBe(5002)
    expect(sessions.unregister('app', 2)).toBe(true)
    expect(sessions.list()).toEqual([])
  })

  it('expires a registration that stops beating, and tells a stale heartbeat it is gone', () => {
    const { sessions, events, advance } = registry({ ttlMs: 100 })
    sessions.publish('app', 5, [mlx])
    advance(90)
    expect(sessions.heartbeat('app', 5)).toEqual({ alive: true })
    advance(90)
    expect(sessions.list()).toHaveLength(1)
    expect(sessions.heartbeat('app', 4)).toEqual({ alive: false })
    advance(20)
    expect(sessions.list()).toEqual([])
    expect(sessions.heartbeat('app', 5)).toEqual({ alive: false })
    expect(events.at(-1)).toEqual({
      name: 'external-sessions:changed',
      payload: { owner: 'app', sessions: 0, reason: 'expired' },
    })
  })

  it('validates what an owner publishes', () => {
    const { sessions } = registry()
    expect(() => sessions.publish('', 1, [])).toThrow(/needs an owner/)
    expect(() => sessions.publish('app', -1, [])).toThrow(/generation/)
    expect(() => sessions.publish('app', 1, {})).toThrow(/must be a list/)
    expect(() => sessions.publish('app', 1, [{ ...mlx, provider: 'openai' }])).toThrow(/not a local provider/)
    expect(() => sessions.publish('app', 1, [null])).toThrow(/not a local provider/)
    expect(() => sessions.publish('app', 1, [{ ...mlx, model_id: '' }])).toThrow(/model_id/)
    expect(() => sessions.publish('app', 1, [{ ...mlx, port: 70000 }])).toThrow(/port/)
    expect(sessions.publish('app', 1, [{ provider: 'llamacpp', model_id: 'turbo', port: 1 }])).toEqual({
      generation: 1,
      sessions: 1,
    })
    expect(sessions.list()[0]).toMatchObject({ api_key: '', is_embedding: false, pid: null })
  })

  it('asks the owner to grow a context and resolves with its answer, once', async () => {
    const { sessions, events } = registry()
    sessions.publish('app', 1, [mlx])

    const outcome = sessions.requestCtxIncrease('app', 'mlx', 'qwen-mlx', 'error')
    const asked = events.find((e) => e.name === 'external-sessions:ctx-requested')?.payload as {
      request_id: string
    }
    expect(asked).toMatchObject({ owner: 'app', provider: 'mlx', model_id: 'qwen-mlx', trigger: 'error' })
    expect(sessions.answerCtxIncrease('someone-else', asked.request_id, { ok: true })).toBe(false)
    expect(sessions.answerCtxIncrease('app', asked.request_id, { ok: true, new_ctx_len: 16384 })).toBe(true)
    expect(sessions.answerCtxIncrease('app', asked.request_id, { ok: true })).toBe(false)

    expect(await outcome).toEqual({ ok: true, new_ctx_len: 16384 })
  })

  it('declines when the owner does not answer in time, or unregisters while asked', async () => {
    const { sessions } = registry({ ctxTimeoutMs: 20 })
    sessions.publish('app', 1, [mlx])
    expect(await sessions.requestCtxIncrease('app', 'mlx', 'qwen-mlx', 'error')).toEqual({
      ok: false,
      reason: 'timeout',
    })

    const pending = sessions.requestCtxIncrease('app', 'mlx', 'qwen-mlx', 'error')
    sessions.unregister('app')
    sessions.unregister('app')
    expect(await pending).toEqual({ ok: false, reason: 'owner_gone' })
    const answered = registry()
    answered.sessions.publish('app', 1, [mlx])
    const reasoned = answered.sessions.requestCtxIncrease('app', 'mlx', 'qwen-mlx', 'error')
    const id = (answered.events.at(-1)?.payload as { request_id: string }).request_id
    answered.sessions.answerCtxIncrease('app', id, { ok: false, reason: 'at_max' })
    expect(await reasoned).toEqual({ ok: false, reason: 'at_max' })
    answered.sessions.answerCtxIncrease('app', 'nope', null)

    const noOutcome = answered.sessions.requestCtxIncrease('app', 'mlx', 'qwen-mlx', 'error')
    const nextId = (answered.events.at(-1)?.payload as { request_id: string }).request_id
    answered.sessions.answerCtxIncrease('app', nextId, null)
    expect(await noOutcome).toEqual({ ok: false })
  })
})
