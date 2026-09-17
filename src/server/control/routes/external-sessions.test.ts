import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

// No route test covered this family before the control API was split into route files; these pin
// how each route maps the request onto `ExternalSessionControl` and wraps its answer.
describe('external session routes', () => {
  it('publishes, heartbeats and unregisters under the owner in the path', async () => {
    const calls: unknown[] = []
    await h.server.close()
    h = await start({
      externalSessions: {
        publish: (owner, generation, sessions) => {
          calls.push(['publish', owner, generation, sessions])
          return { generation, sessions: 1 }
        },
        heartbeat: (owner, generation) => {
          calls.push(['heartbeat', owner, generation])
          return { alive: true }
        },
        unregister: (owner, generation) => {
          calls.push(['unregister', owner, generation])
          return true
        },
        list: () => [],
        answerCtx: () => false,
      },
    })

    const published = await h.get('/atomic/v1/external-sessions/app', {
      method: 'PUT',
      body: JSON.stringify({ generation: 3, sessions: [{ model_id: 'm' }] }),
    })
    expect(await published.json()).toEqual({ generation: 3, sessions: 1 })

    const beat = await h.get('/atomic/v1/external-sessions/app/heartbeat', {
      method: 'POST',
      body: JSON.stringify({ generation: '3' }),
    })
    expect(await beat.json()).toEqual({ alive: true })

    const gone = await h.get('/atomic/v1/external-sessions/app', {
      method: 'DELETE',
      body: JSON.stringify({ generation: 3 }),
    })
    expect(await gone.json()).toEqual({ unregistered: true })

    expect(calls).toEqual([
      ['publish', 'app', 3, [{ model_id: 'm' }]],
      ['heartbeat', 'app', 3],
      ['unregister', 'app', 3],
    ])
  })

  it('lists registered sessions and hands a context answer to its request', async () => {
    const answers: unknown[] = []
    await h.server.close()
    h = await start({
      externalSessions: {
        publish: (_owner, generation) => ({ generation, sessions: 0 }),
        heartbeat: () => ({ alive: false }),
        unregister: () => false,
        list: () => [{ owner: 'app', model_id: 'm' }],
        answerCtx: (owner, requestId, outcome) => {
          answers.push([owner, requestId, outcome])
          return true
        },
      },
    })

    expect(await (await h.get('/atomic/v1/external-sessions')).json()).toEqual({
      sessions: [{ owner: 'app', model_id: 'm' }],
    })
    const answered = await h.get('/atomic/v1/external-sessions/app/ctx/req-1', {
      method: 'POST',
      body: JSON.stringify({ ok: true, new_ctx_len: 16384 }),
    })
    expect(await answered.json()).toEqual({ accepted: true })
    expect(answers).toEqual([['app', 'req-1', { ok: true, new_ctx_len: 16384 }]])
  })
})
