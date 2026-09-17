import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

describe('backend routes', () => {
  it('lists installed packs and passes the selected one through', async () => {
    const seen: string[] = []
    h.backends.list = async (provider: string, current?: string) => {
      seen.push(`${provider} ${current ?? ''}`)
      return [{ version: 'b6325', backend: 'macos-arm64', path: '/packs/b6325', active: true }]
    }

    const res = await h.get('/atomic/v1/backends/llamacpp-upstream?current=b6325/macos-arm64')

    expect(res.status).toBe(200)
    expect((await res.json()) as { backends: unknown[] }).toMatchObject({
      backends: [{ version: 'b6325', active: true }],
    })
    expect(seen).toEqual(['llamacpp-upstream b6325/macos-arm64'])
  })

  it('installs under the task id the caller named', async () => {
    // The progress bar listens on a name built from this id; the core must not invent its own.
    const res = await h.get('/atomic/v1/backends/llamacpp-upstream/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'b6325', backend: 'macos-arm64', task_id: 'install-1' }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ version: 'b6325', installed: true })
  })

  it('refuses an install that does not say what to install or under which task', async () => {
    const missing = await h.get('/atomic/v1/backends/llamacpp-upstream/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 'b6325' }),
    })

    expect(missing.status).toBe(400)
    expect((await missing.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'INVALID_ARGUMENT' },
    })
  })

  it('removes a pack and says whether there was one', async () => {
    const res = await h.get('/atomic/v1/backends/llamacpp-upstream/b6325/macos-arm64', {
      method: 'DELETE',
    })

    expect(await res.json()).toEqual({ removed: true })
  })

  it('passes proxy policy to install without changing its response', async () => {
    let seen: unknown
    h.backends.install = async (_provider, version, backend, options) => {
      seen = options.proxy
      return { version, backend, installed: true, path: '/pack' }
    }
    const res = await h.get('/atomic/v1/backends/llamacpp-upstream/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: 'b1',
        backend: 'macos-arm64',
        task_id: 't',
        proxy: { url: 'http://proxy:8080' },
      }),
    })
    expect(res.status).toBe(200)
    expect(seen).toEqual({ url: 'http://proxy:8080' })
  })

  it('passes the TurboQuant asset name through, and ignores an empty one', async () => {
    const seen: unknown[] = []
    h.backends.install = async (_provider, version, backend, options) => {
      seen.push(options.assetName)
      return { version, backend, installed: true, path: '/pack' }
    }
    for (const asset_name of ['llama-turboquant-macos-arm64.tar.gz', '']) {
      await h.get('/atomic/v1/backends/llamacpp/install', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ version: 'b10018-1.3.0', backend: 'macos-arm64', task_id: 't', asset_name }),
      })
    }
    expect(seen).toEqual(['llama-turboquant-macos-arm64.tar.gz', undefined])
  })

  it('cancels the task id that owns the UI row', async () => {
    let seen = ''
    h.backends.cancel = (taskId) => {
      seen = taskId
      return true
    }
    const res = await h.get('/atomic/v1/downloads/llamacpp-backend-b1/macos-arm64/cancel', { method: 'POST' })
    expect(await res.json()).toEqual({ cancelled: true })
    expect(seen).toBe('llamacpp-backend-b1/macos-arm64')
  })

  it('returns revisioned optimal state and refuses an obsolete write with 409', async () => {
    h.backends.getOptimal = async () => ({ revision: 2, optimal: null })
    h.backends.setOptimal = async () => ({ status: 'conflict', current: { revision: 2, optimal: null } })
    expect(await (await h.get('/atomic/v1/backends/llamacpp-upstream/optimal')).json()).toEqual({
      revision: 2,
      optimal: null,
    })
    const res = await h.get('/atomic/v1/backends/llamacpp-upstream/optimal', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ optimal: null, expected_revision: 1 }),
    })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ status: 'conflict', current: { revision: 2, optimal: null } })
  })
})
