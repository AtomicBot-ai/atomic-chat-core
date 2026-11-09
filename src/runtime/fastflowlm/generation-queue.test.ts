import { expect, it, vi } from 'vitest'
import { GenerationQueue } from './generation-queue.js'
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { resolve, promise }
}
it('removes detached waiters, refuses overflow and waits for native cancellation before the next request', async () => {
  const fence = deferred(),
    upstream = deferred()
  const q = new GenerationQueue(1, () => fence.promise)
  const current = new AbortController(),
    queued = new AbortController(),
    next = vi.fn(async () => {})
  const a = q.run(current.signal, () => upstream.promise)
  const b = q.run(queued.signal, next)
  expect(await q.run(new AbortController().signal, next)).toBe(false)
  queued.abort()
  expect(await b).toBe(true)
  const c = q.run(new AbortController().signal, next)
  current.abort()
  upstream.resolve()
  await Promise.resolve()
  expect(next).not.toHaveBeenCalled()
  fence.resolve()
  await Promise.all([a, c])
  expect(next).toHaveBeenCalledTimes(1)
})
