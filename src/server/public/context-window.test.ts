import { afterEach, describe, expect, it } from 'vitest'
import { SessionWindows, sessionWindow, windowFromProps } from './context-window.js'
import { closeAll, closedPort, localSession, startUpstream } from '../../../test/helpers/public-server.js'

afterEach(closeAll)

describe('windowFromProps', () => {
  it("reads one slot's window, as llama-server reports it, and nothing else", () => {
    expect(windowFromProps({ default_generation_settings: { n_ctx: 65536 }, total_slots: 1 })).toBe(65536)
    expect(windowFromProps({ n_ctx: 8192 })).toBe(8192)
    expect(windowFromProps({ default_generation_settings: { n_ctx: 0 } })).toBeUndefined()
    expect(windowFromProps('busy')).toBeUndefined()
  })
})

describe('SessionWindows', () => {
  it("asks a llama.cpp session's /props once per load, with the session key", async () => {
    const asked: Array<string | undefined> = []
    let window = 32768
    const { port } = await startUpstream((req, _body, res) => {
      asked.push(`${req.url} ${req.headers.authorization}`)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: window } }))
    })
    const windows = new SessionWindows()
    const session = localSession(port, { generation: 'g1' })

    expect(await windows.of(session)).toBe(32768)
    window = 65536
    expect(await windows.of(session)).toBe(32768)
    // Reloaded with another window: a new generation is asked again.
    expect(await windows.of({ ...session, generation: 'g2' })).toBe(65536)
    expect(asked).toEqual(['/props Bearer k', '/props Bearer k'])
  })

  it('asks again after an engine that did not answer, and never asks an engine without /props', async () => {
    let up = false
    const { port } = await startUpstream((_req, _body, res) => {
      res.writeHead(up ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify(up ? { default_generation_settings: { n_ctx: 4096 } } : { error: 'loading' }))
    })
    const windows = new SessionWindows()

    expect(await windows.of(localSession(port))).toBeUndefined()
    up = true
    expect(await windows.of(localSession(port))).toBe(4096)
    expect(await windows.of(localSession(await closedPort()))).toBeUndefined()

    let fetched = false
    const mlx = new SessionWindows({
      fetch: () => {
        fetched = true
        return Promise.reject(new Error('unexpected'))
      },
    })
    expect(await mlx.of(localSession(port, { provider: 'mlx' }))).toBeUndefined()
    expect(fetched).toBe(false)
  })

  it('takes the window a declared session states over asking anyone', async () => {
    const declared = localSession(1, {
      provider: 'vllm',
      policy: { routes: [], tools: true, structuredOutput: true, mapError: () => null, contextLength: 16384 },
    })
    const deps = {
      findLocal: () => undefined,
      listLocal: () => [],
      providers: () => new Map(),
      increaseCtx: () => Promise.resolve({ ok: false }),
    }
    expect(await sessionWindow({ ...deps, contextWindow: () => Promise.resolve(1) }, declared)).toBe(16384)
    expect(await sessionWindow(deps, localSession(1))).toBeUndefined()
  })
})
