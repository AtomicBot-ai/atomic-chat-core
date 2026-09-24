import { afterEach, describe, expect, it } from 'vitest'
import { startControlHarness } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
const running: ControlHarness[] = []
afterEach(async () => {
  for (const h of running.splice(0)) await h.server.close()
})
const result = {
  sessionId: '684286da-7283-4e22-9436-c6f6c3c03015',
  text: 'OK',
  inputTokens: 17,
  outputTokens: 3,
}
describe('Claude control routes', () => {
  it('requires a control token and preserves status, login, and per-request streaming shapes', async () => {
    let logins = 0
    const status = {
      installed: true,
      loggedIn: true,
      subscription: true,
      plan: 'max',
      version: 'fixture',
      error: null,
      models: [],
    }
    const h = await startControlHarness({
      claudeCode: {
        status: async () => status,
        login: async () => {
          logins++
        },
        chat: async (request, emit) => {
          expect(request.prompt).toBe('hello')
          await emit({ type: 'ready' })
          await emit({ type: 'delta', text: 'OK' })
          return result
        },
      },
    })
    running.push(h)
    expect(
      (await h.get('/atomic/v1/claude-code/status', { headers: { authorization: 'Bearer wrong' } })).status
    ).toBe(401)
    expect(await (await h.get('/atomic/v1/claude-code/status')).json()).toEqual(status)
    expect((await h.get('/atomic/v1/claude-code/login', { method: 'POST' })).status).toBe(200)
    expect(logins).toBe(1)
    const response = await h.get('/atomic/v1/claude-code/chat', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'hello' }),
    })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(
      (await response.text())
        .trim()
        .split('\n\n')
        .map((frame) => JSON.parse(frame.slice(6)))
    ).toEqual([{ type: 'ready' }, { type: 'delta', text: 'OK' }, { type: 'result', result }])
  })
  it('aborts the runtime when its client disconnects and reports model errors as stream errors', async () => {
    let cancelled: (() => void) | undefined
    const cancellation = new Promise<void>((resolve) => {
      cancelled = resolve
    })
    const h = await startControlHarness({
      claudeCode: {
        status: async () => {
          throw new Error('unused')
        },
        login: async () => {},
        chat: async (request, emit, signal) => {
          if (request.prompt === 'fail') throw new Error('Usage limit reached')
          await emit({ type: 'ready' })
          await new Promise<void>((resolve) =>
            signal!.addEventListener(
              'abort',
              () => {
                cancelled!()
                resolve()
              },
              { once: true }
            )
          )
          return result
        },
      },
    })
    running.push(h)
    const failed = await h.get('/atomic/v1/claude-code/chat', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'fail' }),
    })
    expect(await failed.text()).toContain('"type":"error","message":"Usage limit reached"')
    const response = await h.get('/atomic/v1/claude-code/chat', {
      method: 'POST',
      body: JSON.stringify({ prompt: 'wait' }),
    })
    const reader = response.body!.getReader()
    await reader.read()
    await reader.cancel()
    await cancellation
  })
})
