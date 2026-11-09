import { expect, it, vi } from 'vitest'
import { AsyncMutex } from '../../diffusion/index.js'
import type { FastFlowLmAccelerators } from '../../contracts/index.js'
import { createFlmProbe } from './probe.js'

const facts = (ready: boolean) => ({ ready }) as FastFlowLmAccelerators

it('shares one inspection across a catalog burst, then reads fresh facts', async () => {
  let finish!: () => void
  const waiting = new Promise<void>((resolve) => {
    finish = resolve
  })
  const inspect = vi.fn(async () => {
    await waiting
    return facts(true)
  })
  const probe = createFlmProbe(new AsyncMutex(), inspect)
  const calls = Array.from({ length: 20 }, () => probe())
  await Promise.resolve()
  try {
    expect(inspect).toHaveBeenCalledTimes(1)
  } finally {
    finish()
  }
  await Promise.all(calls)
  expect(inspect).toHaveBeenCalledTimes(1)
  inspect.mockResolvedValueOnce(facts(false))
  expect(await probe()).toEqual(facts(false))
  expect(inspect).toHaveBeenCalledTimes(2)
})

it('keeps the build lock and inspects only after a pending mutation finishes', async () => {
  const lock = new AsyncMutex()
  const release = await lock.acquire()
  const inspect = vi.fn(async () => facts(true))
  const probe = createFlmProbe(lock, inspect)
  const calls = [probe(), probe()]
  await Promise.resolve()
  expect(inspect).not.toHaveBeenCalled()
  release()
  await Promise.all(calls)
  expect(inspect).toHaveBeenCalledTimes(1)
  expect(lock.locked).toBe(false)
})

it('shares failures without keeping a failed result for the next request', async () => {
  const inspect = vi.fn().mockRejectedValueOnce(new Error('probe failed')).mockResolvedValue(facts(true))
  const probe = createFlmProbe(new AsyncMutex(), inspect)
  const results = await Promise.allSettled([probe(), probe()])
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
  expect(await probe()).toEqual(facts(true))
  expect(inspect).toHaveBeenCalledTimes(2)
})
