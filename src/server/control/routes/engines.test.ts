import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

const send = (method: string, path: string, body?: unknown) =>
  h.get(`/atomic/v1/engines/${path}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const errorOf = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string; details?: string } }).error

describe('POST /engines/versions', () => {
  it('answers with an empty or a full body and refuses a field it does not know', async () => {
    const proxy = { url: 'http://proxy.local:3128' }
    expect((await send('POST', 'versions')).status).toBe(200)
    expect(
      await (await send('POST', 'versions', { force: true, proxy, app_version: '2.1.0' })).json()
    ).toMatchObject({ engines: [{ engine: 'llamacpp-upstream' }] })
    const extra = await send('POST', 'versions', { force: true, verbose: true })
    expect(extra.status).toBe(400)
    expect(await errorOf(extra)).toMatchObject({ code: 'INVALID_ARGUMENT', details: 'verbose' })
    expect(h.calls).toEqual([
      'engines versions {}',
      `engines versions {"force":true,"proxy":${JSON.stringify(proxy)},"app_version":"2.1.0"}`,
    ])
  })
})

describe('POST /engines/:engine/update', () => {
  it('passes a llama.cpp target and answers 200; a managed engine answers 202', async () => {
    const swap = await send('POST', 'llamacpp-upstream/update', {
      task_id: 'engine-update-llamacpp-upstream-b11500',
      target: { variant: 'win-cuda12-x64' },
    })
    expect(swap.status).toBe(200)
    expect(await swap.json()).toMatchObject({ updated: true })
    const managed = await send('POST', 'vllm/update', { request_id: 'upd-1', app_version: '2.1.0' })
    expect(managed.status).toBe(202)
    expect(await managed.json()).toEqual({ operation_id: 'op-1' })
    expect(h.calls).toEqual([
      'engines update llamacpp-upstream {"task_id":"engine-update-llamacpp-upstream-b11500","target":{"variant":"win-cuda12-x64"}}',
      'engines update vllm {"request_id":"upd-1","app_version":"2.1.0"}',
    ])
  })

  it('refuses a target for sd-cpp, the other kind of body, an unknown engine and a missing task id', async () => {
    const refusals = [
      await send('POST', 'sd-cpp/update', { task_id: 't', target: { variant: 'macos-arm64' } }),
      await send('POST', 'vllm/update', { task_id: 't' }),
      await send('POST', 'llamacpp/update', { request_id: 'r' }),
      await send('POST', 'whisper/update', { task_id: 't' }),
      await send('POST', 'mlx/update', {}),
      await send('POST', 'llamacpp/update', { task_id: 't', target: { version: 'b1' } }),
      await send('POST', 'llamacpp/update', { task_id: 't', target: { variant: 'a/b' } }),
    ]
    for (const res of refusals) {
      expect(res.status).toBe(400)
      expect((await errorOf(res)).code).toBe('INVALID_ARGUMENT')
    }
    expect(h.calls).toEqual([])
  })
})

describe('DELETE /engines/:engine/builds/:version/:variant', () => {
  it('removes a llama.cpp build, and begins a managed removal with retain_models from the query', async () => {
    const llama = await send('DELETE', 'llamacpp/builds/b9000-1.6.0/win-cuda-12-x64')
    expect(llama.status).toBe(200)
    expect(await llama.json()).toEqual({ removed: true })
    const managed = await send('DELETE', 'vllm/builds/vllm-0.31.0-r1/linux%2Famd64?retain_models=false')
    expect(managed.status).toBe(202)
    expect(await managed.json()).toEqual({ operation_id: 'op-2' })
    await send('DELETE', 'tensorrt-llm/builds/tensorrt-llm-1.3.0rc29-r3/linux%2Farm64')
    expect(h.calls).toEqual([
      'engines remove llamacpp b9000-1.6.0 win-cuda-12-x64 {}',
      'engines remove vllm vllm-0.31.0-r1 linux/amd64 {"retainModels":false}',
      'engines remove tensorrt-llm tensorrt-llm-1.3.0rc29-r3 linux/arm64 {}',
    ])
  })

  it('refuses segments with characters a build id never has, and a retain_models that is not a boolean', async () => {
    const refusals = [
      await send('DELETE', 'llamacpp/builds/..%2F..%2Fetc/win-cpu-x64'),
      await send('DELETE', 'llamacpp/builds/b1/win%20cpu'),
      await send('DELETE', 'llamacpp/builds/b1/linux%2Famd64'),
      await send('DELETE', 'vllm/builds/vllm-0.31.0-r1/linux%2Fppc64'),
      await send('DELETE', 'vllm/builds/vllm-0.31.0-r1/linux%2Famd64?retain_models=maybe'),
      await send('DELETE', 'whisper/builds/b1/x'),
    ]
    for (const res of refusals) {
      expect(res.status).toBe(400)
      expect((await errorOf(res)).code).toBe('INVALID_ARGUMENT')
    }
    expect(h.calls).toEqual([])
  })
})

describe('POST /engines/:engine/builds/:version/:variant/activate', () => {
  it('activates with no body or an empty one, and refuses one with fields', async () => {
    expect(
      await (await send('POST', 'llamacpp-upstream/builds/b11400/win-vulkan-x64/activate')).json()
    ).toEqual({
      activated: true,
      active: { version: 'b11400', variant: 'win-vulkan-x64' },
    })
    expect((await send('POST', 'llamacpp-upstream/builds/b11400/win-vulkan-x64/activate', {})).status).toBe(
      200
    )
    const extra = await send('POST', 'llamacpp-upstream/builds/b11400/win-vulkan-x64/activate', {
      force: true,
    })
    expect(extra.status).toBe(400)
    const segment = await send('POST', 'llamacpp-upstream/builds/b11400/win%2Fvulkan/activate')
    expect(segment.status).toBe(400)
    expect(h.calls).toEqual([
      'engines activate llamacpp-upstream b11400 win-vulkan-x64',
      'engines activate llamacpp-upstream b11400 win-vulkan-x64',
    ])
  })
})
