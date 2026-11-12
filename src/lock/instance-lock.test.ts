import { spawn } from 'node:child_process'
import type * as Fs from 'node:fs/promises'
import { mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { classifyFailure, diagnosticTags } from '../telemetry/index.js'
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
import { processStartEpoch } from './process-identity.js'

vi.mock(import('node:fs/promises'), async (original) => {
  const fs = await original()
  return { ...fs, rm: vi.fn(fs.rm) }
})

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
      protocol: 1,
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

  // `owner_started_at` (seconds since the epoch) means the same to every reader, unlike an older
  // `process_start_id` printed in its writer's locale: it decides, as the desktop app's reader does.
  it('keeps an owner whose start time matches, whatever locale its start identity was written in', async () => {
    await write({
      pid: process.pid,
      process_start_id: 'darwin:понедельник, 19 октября 2026 г. 13:33:52',
      owner_started_at: (await processStartEpoch(process.pid)) ?? null,
    })
    expect(await inspectLock(data.layout)).toMatchObject({ kind: 'owned', verdict: 'match' })
  })

  it('frees a lock whose start time names another process behind the same pid', async () => {
    await write({
      pid: process.pid,
      process_start_id: 'darwin:понедельник, 19 октября 2026 г. 13:33:52',
      owner_started_at: 'epoch:1',
    })
    expect(await inspectLock(data.layout)).toMatchObject({ kind: 'stale', verdict: 'mismatch' })
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

  it('serializes two starters reclaiming the same abandoned takeover mutex', async () => {
    const crashedPid = await deadPid()
    await write({ pid: crashedPid })
    const mutex = `${data.layout.core.instanceLock}.takeover`
    await writeFile(mutex, `${crashedPid}\n`)
    let onFirstRemoval!: () => void
    const firstRemoval = new Promise<void>((resolve) => {
      onFirstRemoval = resolve
    })
    let onContention!: () => void
    const secondContended = new Promise<void>((resolve) => {
      onContention = resolve
    })
    const fs = await vi.importActual<typeof Fs>('node:fs/promises')
    let removing = false
    let overlappingRemovals = false
    vi.mocked(rm).mockImplementation(async (path, options) => {
      if (path !== mutex) return fs.rm(path, options)
      if (removing) {
        overlappingRemovals = true
        onContention()
      }
      removing = true
      onFirstRemoval()
      await secondContended
      try {
        await fs.rm(path, options)
      } finally {
        removing = false
      }
    })
    try {
      const first = InstanceLock.acquire(data.layout, { platform: 'aix' })
      await firstRemoval
      const second = InstanceLock.acquire(data.layout, {
        platform: 'aix',
        sleep: async (ms) => {
          onContention()
          await new Promise((resolve) => setTimeout(resolve, ms))
        },
      })
      const results = await Promise.allSettled([first, second])
      expect(overlappingRemovals).toBe(false)
      const winners = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []))
      expect(winners).toHaveLength(1)
      const winner = winners[0]!
      expect(results).toContainEqual({
        status: 'rejected',
        reason: expect.objectContaining({ code: 'CORE_ALREADY_RUNNING' }) as unknown,
      })
      expect(await readLockRecord(data.layout.core.instanceLock)).toMatchObject({
        instance_id: winner.instanceId,
      })
      await winner.release()
    } finally {
      onContention()
      vi.mocked(rm).mockImplementation(fs.rm)
    }
  })

  it('leaves the takeover mutex untouched while a live recovery claimant is paused', async () => {
    const crashedPid = await deadPid()
    await write({ pid: crashedPid })
    const mutex = `${data.layout.core.instanceLock}.takeover`
    await writeFile(mutex, `${crashedPid}\n`)
    const peer = join(
      data.layout.core.dir,
      'instance.lock.recover-99999999-unknown-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'
    )
    await writeFile(peer, '')
    const deps = {
      platform: 'aix' as const,
      sleep: async () => {},
      alive: (pid: number) => pid === 99999999 || pid === process.pid,
    }
    await expect(InstanceLock.acquire(data.layout, deps)).rejects.toMatchObject({ code: 'CORE_START_FAILED' })
    expect(await readFile(mutex, 'utf8')).toBe(`${crashedPid}\n`)
    expect(await readFile(peer, 'utf8')).toBe('')
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

  it('preserves the underlying filesystem cause on instance lock IO_ERRORs', async () => {
    // 1. InstanceLock.acquire failing on open(path, 'wx') with a non-EEXIST filesystem error.
    const tooLongLayout = {
      ...data.layout,
      core: {
        ...data.layout.core,
        instanceLock: join(data.layout.core.dir, 'l'.repeat(260)),
      },
    }
    const nativeAcquireErr = (await open(tooLongLayout.core.instanceLock, 'wx')
      .then((handle) => handle.close())
      .catch((e: unknown) => e)) as NodeJS.ErrnoException
    expect(nativeAcquireErr).toBeInstanceOf(Error)
    const acquireErr = (await InstanceLock.acquire(tooLongLayout).catch((e: unknown) => e)) as AtomicCoreError
    expect(acquireErr).toBeInstanceOf(AtomicCoreError)
    expect(acquireErr.code).toBe('IO_ERROR')
    expect(acquireErr.cause).toBeInstanceOf(Error)
    expect(acquireErr.cause).toMatchObject({
      code: nativeAcquireErr.code,
      message: nativeAcquireErr.message,
      path: nativeAcquireErr.path,
      syscall: nativeAcquireErr.syscall,
    })
    expect(acquireErr.toJSON()).toEqual({
      code: 'IO_ERROR',
      message: `Cannot create the instance lock at ${tooLongLayout.core.instanceLock}`,
      details: (acquireErr.cause as Error).message,
    })
    const diagnostic = classifyFailure(acquireErr, { component: 'core', operation: 'startup' })
    expect(diagnostic).toMatchObject(
      classifyFailure(nativeAcquireErr, { component: 'core', operation: 'startup' })
    )
    expect(diagnosticTags(acquireErr, diagnostic).cause_code).toBe(nativeAcquireErr.code)

    // 2. readLockRecord failing with a non-ENOENT error (EISDIR on a directory).
    await mkdir(data.layout.core.dir, { recursive: true })
    const readErr = (await readLockRecord(data.layout.core.dir).catch((e: unknown) => e)) as AtomicCoreError
    expect(readErr).toBeInstanceOf(AtomicCoreError)
    expect(readErr.code).toBe('IO_ERROR')
    expect((readErr.cause as NodeJS.ErrnoException).code).toBe('EISDIR')

    // 3. tryRecoverStale failing on open(mutexPath, 'wx') with a non-EEXIST error.
    const borderlineLock = join(data.layout.core.dir, 's'.repeat(250))
    await writeFile(
      borderlineLock,
      JSON.stringify({
        instance_id: 'stale-owner',
        pid: await deadPid(),
        process_start_id: 'linux:1',
        protocol: 2,
        version: '0.0.1',
        data_folder: data.root,
        control_host: '127.0.0.1',
        control_port: 41_000,
        state: 'ready',
        acquired_at: '2026-09-15T00:00:00.000Z',
      })
    )
    const takeoverLayout = {
      ...data.layout,
      core: {
        ...data.layout.core,
        instanceLock: borderlineLock,
      },
    }
    const nativeTakeoverErr = (await open(`${borderlineLock}.takeover`, 'wx')
      .then((handle) => handle.close())
      .catch((e: unknown) => e)) as NodeJS.ErrnoException
    expect(nativeTakeoverErr).toBeInstanceOf(Error)
    const takeoverErr = (await InstanceLock.acquire(takeoverLayout).catch(
      (e: unknown) => e
    )) as AtomicCoreError
    expect(takeoverErr).toBeInstanceOf(AtomicCoreError)
    expect(takeoverErr.code).toBe('IO_ERROR')
    expect(takeoverErr.cause).toMatchObject({
      code: nativeTakeoverErr.code,
      message: nativeTakeoverErr.message,
      path: nativeTakeoverErr.path,
      syscall: nativeTakeoverErr.syscall,
    })
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

  it('reclaims a takeover mutex left by a dead process without waiting for the age fallback', async () => {
    const crashedPid = await deadPid()
    await write({ pid: crashedPid })
    const mutex = `${data.layout.core.instanceLock}.takeover`
    const claim = `instance.lock.recover-${crashedPid}-unknown-11111111-1111-4111-8111-111111111111`
    await writeFile(join(data.layout.core.dir, claim), '')
    await writeFile(mutex, `${crashedPid}\n`)
    const lock = await InstanceLock.acquire(data.layout, { sleep: async () => {} })
    expect(lock.record.pid).toBe(process.pid)
    await expect(readFile(mutex, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      (await readdir(data.layout.core.dir)).filter((name) => name.startsWith('instance.lock.recover-'))
    ).toEqual([])
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
