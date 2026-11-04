import { describe, expect, it } from 'vitest'
import { FifoLock } from './fifo-lock.js'

describe('FifoLock', () => {
  it('runs work in arrival order, one at a time, a failure not blocking the next', async () => {
    const lock = new FifoLock()
    const order: string[] = []
    let active = 0
    let maxActive = 0
    const job = (name: string, fail = false) =>
      lock.run(async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push(name)
        active--
        if (fail) throw new Error(name)
      })
    const first = job('a')
    const second = job('b', true)
    const third = job('c')
    expect(lock.waiting).toBe(3)
    await first
    await expect(second).rejects.toThrow('b')
    await third
    expect(order).toEqual(['a', 'b', 'c'])
    expect(maxActive).toBe(1)
    expect(lock.waiting).toBe(0)
  })
})
