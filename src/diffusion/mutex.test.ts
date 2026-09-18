import { describe, expect, it } from 'vitest'
import { AsyncMutex } from './mutex.js'

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('AsyncMutex', () => {
  it('runs one holder at a time, in the order they asked', async () => {
    const mutex = new AsyncMutex()
    const log: string[] = []
    const work = (name: string, turns: number) =>
      mutex.run(async () => {
        log.push(`${name}:in`)
        for (let i = 0; i < turns; i++) await tick()
        log.push(`${name}:out`)
        return name
      })
    const results = await Promise.all([work('a', 3), work('b', 1), work('c', 0)])
    expect(results).toEqual(['a', 'b', 'c'])
    expect(log).toEqual(['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out'])
  })

  it('lets the next holder in after one that threw', async () => {
    const mutex = new AsyncMutex()
    const failed = mutex.run(async () => {
      await tick()
      throw new Error('boom')
    })
    const next = mutex.run(async () => 'after')
    await expect(failed).rejects.toThrow('boom')
    await expect(next).resolves.toBe('after')
  })

  it('hands out a release that can be called more than once', async () => {
    const mutex = new AsyncMutex()
    const release = await mutex.acquire()
    let entered = false
    const waiting = mutex.acquire().then((r) => {
      entered = true
      return r
    })
    await tick()
    expect(entered).toBe(false)
    release()
    release()
    const second = await waiting
    expect(entered).toBe(true)
    second()
    await expect(mutex.run(async () => 1)).resolves.toBe(1)
  })
})

describe('tryAcquire', () => {
  it('takes a free lock at once and refuses a held one', async () => {
    const mutex = new AsyncMutex()
    expect(mutex.locked).toBe(false)
    const release = mutex.tryAcquire()
    expect(release).toBeDefined()
    expect(mutex.locked).toBe(true)
    expect(mutex.tryAcquire()).toBeUndefined()
    // A waiter queued behind it is served on release, and the lock stays held for it.
    const waiting = mutex.acquire()
    release?.()
    expect(mutex.locked).toBe(true)
    const second = await waiting
    expect(mutex.tryAcquire()).toBeUndefined()
    second()
    expect(mutex.locked).toBe(false)
  })
})
