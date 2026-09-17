import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('cloud and auth routes', () => {
  it('maps a missing subscription to 401 and a failed sign-in to 502 with the error envelope', async () => {
    const { AtomicCoreError } = await import('../../../contracts/index.js')
    const server = await start({
      chatgpt: {
        status: async () => ({ connected: false, email: null, plan_type: null, expires_at: null }),
        startLogin: async () => {
          throw new AtomicCoreError('IO_ERROR', 'cannot listen on 127.0.0.1:1455 for the sign-in callback')
        },
        waitLogin: async () => {
          throw new AtomicCoreError('AUTH_FAILED', 'callback state did not match this sign-in')
        },
        cancelLogin: () => {},
        logout: async () => ({ connected: false, email: null, plan_type: null, expires_at: null }),
        models: async () => {
          throw new AtomicCoreError('AUTH_REQUIRED', 'no ChatGPT subscription is connected')
        },
      },
    })
    try {
      const models = await server.get('/atomic/v1/auth/chatgpt/models')
      expect(models.status).toBe(401)
      expect(await models.json()).toEqual({
        error: { code: 'AUTH_REQUIRED', message: 'no ChatGPT subscription is connected' },
      })
      expect((await server.get('/atomic/v1/auth/chatgpt/login/wait', { method: 'POST' })).status).toBe(502)
      expect((await server.get('/atomic/v1/auth/chatgpt/login', { method: 'POST' })).status).toBe(500)
      expect(
        (await server.get('/atomic/v1/cloud/providers', { headers: { authorization: 'Bearer nope' } })).status
      ).toBe(401)
    } finally {
      await server.server.close()
    }
  })
})
