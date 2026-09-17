import { describe, expect, it } from 'vitest'
import { createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { inspectLock } from '../lock/index.js'

useCoreHarness()

describe('shutdown', () => {
  it('stops the public listener, closes control and releases the lock', async () => {
    const core = await createCore()
    await core.startPublicServer({ port: 0 })
    const controlUrl = core.control.url
    await core.shutdown()
    expect(await inspectLock(data.layout)).toEqual({ kind: 'free' })
    await expect(fetch(`${controlUrl}/atomic/v1/health`)).rejects.toThrow()
    await core.shutdown() // idempotent
  })

  it('rejects new work as soon as shutdown begins', async () => {
    const core = await createCore()
    const stopping = core.shutdown()
    await expect(core.load('llamacpp-upstream', 'late')).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await expect(core.unload('llamacpp-upstream', 'late')).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await expect(core.startPublicServer({ port: 0 })).rejects.toMatchObject({
      code: 'CORE_NOT_RUNNING',
    })
    await stopping
  })
})
