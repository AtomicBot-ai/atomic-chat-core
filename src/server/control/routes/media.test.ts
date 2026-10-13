import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import type { ControlServerDeps } from '../types.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('media routes', () => {
  it('answer the catalog and a provider’s models of the asked kind', async () => {
    const catalog = await h.get('/atomic/v1/media/catalog')
    expect(catalog.status).toBe(200)
    expect(await catalog.json()).toMatchObject({ catalog_version: 1, origin: 'baseline' })
    const models = await h.get('/atomic/v1/media/providers/openrouter/models?kind=video')
    expect(await models.json()).toEqual({
      provider: 'openrouter',
      kind: 'video',
      api: null,
      models: [],
      live: false,
    })
    expect(h.calls).toContain('media models openrouter video')
  })

  it('refuse a kind that is neither image nor video', async () => {
    const answer = await h.get('/atomic/v1/media/providers/openrouter/models?kind=audio')
    expect(answer.status).toBe(400)
  })

  it('say so when the core has no remote media', async () => {
    const bare = await start({ media: undefined } as unknown as Partial<ControlServerDeps>)
    try {
      const answer = await bare.get('/atomic/v1/media/catalog')
      expect(answer.status).toBe(409)
      expect(await answer.json()).toMatchObject({ error: { code: 'REMOTE_NOT_CONFIGURED' } })
    } finally {
      await bare.server.close()
    }
  })
})
