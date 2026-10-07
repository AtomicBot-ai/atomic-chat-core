import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

const post = (path: string, body?: unknown) =>
  h.get(`/atomic/v1/engine-builds/${path}`, {
    method: 'POST',
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error

describe('engine-builds routes', () => {
  it('reads the catalog and the update check with an empty or a full body', async () => {
    const proxy = { url: 'http://proxy.local:3128' }
    expect((await post('mlx/catalog')).status).toBe(200)
    expect(await (await post('sd-cpp/catalog', { force: true, proxy })).json()).toMatchObject({
      engine: 'sd-cpp',
    })
    expect(await (await post('mlx/updates', { force: false })).json()).toEqual({
      update_needed: false,
      current: null,
      target: null,
    })
    expect(h.calls).toEqual([
      'engine-builds catalog mlx {}',
      `engine-builds catalog sd-cpp {"force":true,"proxy":${JSON.stringify(proxy)}}`,
      'engine-builds updates mlx {"force":false}',
    ])
  })

  it('installs under the caller task id', async () => {
    const res = await post('sd-cpp/install', {
      task_id: 'diffusion-backend-master-900-macos-arm64',
      force: true,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ installed: true, build: { origin: 'downloaded' } })
    expect(h.calls).toEqual([
      'engine-builds install sd-cpp {"task_id":"diffusion-backend-master-900-macos-arm64","force":true}',
    ])
  })

  it('refuses an install without a task id, unknown fields and fields of the wrong type', async () => {
    for (const body of [
      {},
      { task_id: '' },
      { task_id: 7 },
      { task_id: 'a\u0001b' },
      { task_id: 't', backend: 'win-cpu-x64' },
      { task_id: 't', force: 'yes' },
      { task_id: 't', proxy: 'http://proxy' },
    ]) {
      const res = await post('mlx/install', body)
      expect(res.status, JSON.stringify(body)).toBe(400)
      expect((await errorOf(res)).code).toBe('INVALID_ARGUMENT')
    }
    const unknown = await post('mlx/catalog', { refresh: true })
    expect(unknown.status).toBe(400)
    expect(await errorOf(unknown)).toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect((await post('mlx/catalog', [1])).status).toBe(400)
    expect(h.calls).toEqual([])
  })

  it('knows sd-cpp and mlx only', async () => {
    for (const path of ['llamacpp/catalog', 'diffusers/updates', 'vllm/install']) {
      const res = await post(path, { task_id: 't' })
      expect(res.status).toBe(400)
      expect((await errorOf(res)).code).toBe('INVALID_ARGUMENT')
    }
    const del = await h.get('/atomic/v1/engine-builds/foo/master-1-aaaaaaa/x', { method: 'DELETE' })
    expect((await errorOf(del)).code).toBe('INVALID_ARGUMENT')
    expect(h.calls).toEqual([])
  })

  it('removes a build named by its tag and backend id, and refuses path tricks', async () => {
    const res = await h.get('/atomic/v1/engine-builds/sd-cpp/master-900-aaaaaaa/win-cuda12-x64', {
      method: 'DELETE',
    })
    expect(await res.json()).toEqual({ removed: true })
    expect(h.calls).toEqual(['engine-builds remove sd-cpp master-900-aaaaaaa win-cuda12-x64'])
    for (const path of ['sd-cpp/../models', 'sd-cpp/%2E%2E/x', 'sd-cpp/master-1/a%2Fb']) {
      const bad = await h.get(`/atomic/v1/engine-builds/${path}`, { method: 'DELETE' })
      expect(bad.status, path).toBeGreaterThanOrEqual(400)
    }
    expect(h.calls).toHaveLength(1)
  })
})
