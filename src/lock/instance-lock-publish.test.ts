import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { InstanceLock, inspectLock } from './instance-lock.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-lock-publish-')
})
afterEach(() => data.cleanup())

// A shutdown that arrives while `createAtomicCore` is still bringing the endpoint up releases the
// lock and closes its handle; startup then publishes the endpoint anyway. That write must be a
// no-op: the file is gone (and may belong to another owner), and its descriptor is closed.
describe('InstanceLock.publish after release', () => {
  it('does not write to the closed lock handle a shutdown already released', async () => {
    const lock = await InstanceLock.acquire(data.layout)
    await lock.release()
    expect(await inspectLock(data.layout)).toEqual({ kind: 'free' })
    await expect(lock.publish('127.0.0.1', 42_424)).resolves.toBeUndefined()
    expect(await inspectLock(data.layout)).toEqual({ kind: 'free' })
  })

  it('still publishes, and keeps publishing, for a lock that was never released', async () => {
    const lock = await InstanceLock.acquire(data.layout)
    await lock.publish('127.0.0.1', 42_424)
    expect(await inspectLock(data.layout)).toMatchObject({ kind: 'owned', record: { state: 'ready' } })
    await lock.release()
  })
})
