import { spawn } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import {
  InstanceLock,
  canonicalDataFolder,
  inspectLock,
  parseLockRecord,
  readLockRecord,
  waitForPublishedOwner,
} from './instance-lock.js'
import type { LockRecord } from './instance-lock.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-lock-')
})
afterEach(() => data.cleanup())

const write = (record: Partial<LockRecord>) =>
  writeFile(
    data.layout.core.instanceLock,
    JSON.stringify({
      instance_id: 'other-instance',
      pid: 999_999,
      process_start_id: 'linux:1',
      protocol: 2,
      version: '0.0.1',
      data_folder: data.root,
      control_host: '127.0.0.1',
      control_port: 41_000,
      state: 'ready',
      acquired_at: '2026-09-15T00:00:00.000Z',
      ...record,
    })
  )

/** A pid that existed and is now gone: what a crashed owner leaves behind. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true })
  await new Promise((r) => child.on('exit', r))
  return child.pid as number
}

describe('InstanceLock.acquire', () => {
  it('creates a starting record, publishes the endpoint and releases the file', async () => {
    const lock = await InstanceLock.acquire(data.layout)
    expect(lock.record).toMatchObject({ pid: process.pid, state: 'starting', control_port: 0, protocol: 2 })
    expect(lock.record.instance_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(lock.record.data_folder).toBe(await canonicalDataFolder(data.root))
    expect((await inspectLock(data.layout)).kind).toBe('owned')

    await lock.publish('127.0.0.1', 42_424)
    const onDisk = (await readLockRecord(data.layout.core.instanceLock)) as LockRecord
    expect(onDisk).toMatchObject({ state: 'ready', control_host: '127.0.0.1', control_port: 42_424 })
    expect(await waitForPublishedOwner(data.layout, { timeoutMs: 100 })).toMatchObject({
      control_port: 42_424,
    })

    await lock.release()
    expect(await inspectLock(data.layout)).toEqual({ kind: 'free' })
  })

  it('records a null portable identity when the platform cannot provide one', async () => {
    const lock = await InstanceLock.acquire(data.layout, { platform: 'aix' as NodeJS.Platform })
    expect(lock.record.owner_started_at).toBeNull()
    await lock.release()
  })

  it('refuses a second owner while the first is alive, and names where control lives', async () => {
    const first = await InstanceLock.acquire(data.layout)
    await first.publish('127.0.0.1', 5_000)
    await expect(InstanceLock.acquire(data.layout)).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
      details: expect.stringContaining('127.0.0.1:5000') as unknown as string,
    })
    await first.release()
  })

  it('refuses takeover when the recorded pid is alive but its identity cannot be proven', async () => {
    await write({ pid: process.pid, process_start_id: null })
    expect(await inspectLock(data.layout)).toMatchObject({ kind: 'owned', verdict: 'unknown' })
    await expect(InstanceLock.acquire(data.layout)).rejects.toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
  })

  it('takes over a lock whose process is gone', async () => {
    await write({ pid: await deadPid() })
    expect(await inspectLock(data.layout)).toMatchObject({ kind: 'stale', verdict: 'dead' })
    const lock = await InstanceLock.acquire(data.layout)
    expect(lock.record.pid).toBe(process.pid)
    await lock.release()
  })

  it('takes over a lock whose pid was reused by a different process', async () => {
    await write({ pid: process.pid, process_start_id: 'linux:not-this-process' })
    expect(await inspectLock(data.layout)).toMatchObject({ kind: 'stale', verdict: 'mismatch' })
    const lock = await InstanceLock.acquire(data.layout)
    expect(lock.record.instance_id).not.toBe('other-instance')
    await lock.release()
  })

  it('gives exactly one owner when several starters race for a stale lock', async () => {
    await write({ pid: await deadPid() })
    const results = await Promise.allSettled([
      InstanceLock.acquire(data.layout),
      InstanceLock.acquire(data.layout),
      InstanceLock.acquire(data.layout),
      InstanceLock.acquire(data.layout),
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    expect(won).toHaveLength(1)
    for (const lost of results.filter((r) => r.status === 'rejected')) {
      expect((lost as PromiseRejectedResult).reason).toMatchObject({ code: 'CORE_ALREADY_RUNNING' })
    }
    await (won[0] as PromiseFulfilledResult<InstanceLock>).value.release()
  })

  it('recovers a lock that is not valid JSON at all', async () => {
    await writeFile(data.layout.core.instanceLock, '{ this is not json')
    expect(await inspectLock(data.layout, { sleep: async () => {}, now: fakeClock() })).toEqual({
      kind: 'corrupt',
    })
    const lock = await InstanceLock.acquire(data.layout, { sleep: async () => {}, now: fakeClock() })
    expect(lock.record.pid).toBe(process.pid)
    await lock.release()
  })
})

describe('release', () => {
  it('leaves a lock alone once another instance owns it', async () => {
    const lock = await InstanceLock.acquire(data.layout)
    await write({ instance_id: 'someone-else', pid: process.pid, process_start_id: null })
    await lock.release()
    const after = (await readLockRecord(data.layout.core.instanceLock)) as LockRecord
    expect(after.instance_id).toBe('someone-else')
  })

  it('removes a stale takeover mutex instead of deadlocking on it', async () => {
    await write({ pid: await deadPid() })
    const mutex = `${data.layout.core.instanceLock}.takeover`
    await writeFile(mutex, '1\n')
    const old = Date.now() - 60_000
    const { utimes } = await import('node:fs/promises')
    await utimes(mutex, new Date(old), new Date(old))
    const lock = await InstanceLock.acquire(data.layout)
    expect(lock.record.pid).toBe(process.pid)
    await expect(readFile(mutex, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await lock.release()
  })
})

describe('readLockRecord and parseLockRecord', () => {
  it('reports a missing file, fills defaults and rejects records without identity fields', async () => {
    expect(await readLockRecord(data.layout.core.instanceLock)).toBeUndefined()
    expect(parseLockRecord('{"instance_id":"a","pid":7}')).toMatchObject({
      protocol: 0,
      version: '',
      control_port: 0,
      state: 'starting',
      process_start_id: null,
    })
    expect(parseLockRecord('{"instance_id":"a","pid":7,"owner_started_at":"epoch:123"}')).toMatchObject({
      owner_started_at: 'epoch:123',
    })
    expect(parseLockRecord('{"pid":7}')).toBeUndefined()
    expect(parseLockRecord('[]')).toBeUndefined()
    expect(parseLockRecord('null')).toBeUndefined()
    expect(parseLockRecord('nope')).toBeUndefined()
  })

  it('retries a torn write and returns the record once it lands', async () => {
    let reads = 0
    const now = fakeClock()
    await writeFile(data.layout.core.instanceLock, '{"instance_i')
    const sleep = async () => {
      if (++reads === 2) await write({ instance_id: 'landed', pid: process.pid })
    }
    const record = (await readLockRecord(data.layout.core.instanceLock, { sleep, now })) as LockRecord
    expect(record.instance_id).toBe('landed')
  })
})

describe('waitForPublishedOwner', () => {
  it('fails with CORE_START_FAILED when nothing publishes in time', async () => {
    await expect(waitForPublishedOwner(data.layout, { timeoutMs: 0 })).rejects.toMatchObject({
      code: 'CORE_START_FAILED',
      details: expect.stringContaining('no live owner') as unknown as string,
    })
    const lock = await InstanceLock.acquire(data.layout)
    await expect(waitForPublishedOwner(data.layout, { timeoutMs: 30 })).rejects.toMatchObject({
      details: expect.stringContaining('did not publish') as unknown as string,
    })
    await lock.release()
  })
})

/** Monotonic clock that never reaches the corrupt-grace deadline by itself. */
function fakeClock(): () => number {
  let t = 0
  return () => (t += 200)
}
