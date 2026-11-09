import { expect, it } from 'vitest'
import { createCore, useCoreHarness } from '../../test/helpers/core-harness.js'

useCoreHarness()

it('reuses the listener after host key rotation without reviving the revoked key', async () => {
  let keys = ['key-a']
  const core = await createCore({ publicApiKeys: () => keys })
  const started = await core.startPublicServer({ port: 0, apiKey: 'key-a' })
  let starts = 0
  core.events.on('server:started', () => {
    starts++
  })
  keys = ['key-b']
  await expect(core.startPublicServer({ port: started.port, apiKey: 'key-b' })).resolves.toEqual(started)
  expect(starts).toBe(0)
  for (const [key, status] of [
    ['key-a', 401],
    ['key-b', 200],
  ] as const) {
    const response = await fetch(`http://127.0.0.1:${started.port}/v1/models`, {
      headers: { authorization: `Bearer ${key}` },
    })
    await response.text()
    expect(response.status).toBe(status)
  }
  await expect(
    core.startPublicServer({ port: started.port, apiKey: 'key-b', prefix: '/other' })
  ).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
})

it.each([false, true])(
  'still rejects a changed static key when the host keyring is inactive (callback=%s)',
  async (callback) => {
    const core = await createCore(callback ? { publicApiKeys: () => undefined } : {})
    const started = await core.startPublicServer({ port: 0, apiKey: 'key-a' })
    await expect(core.startPublicServer({ port: started.port, apiKey: 'key-b' })).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
    })
  }
)
