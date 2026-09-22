import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  LoadCancelRegistry,
  MODEL_LOAD_CANCELLED_MESSAGE,
  isLoadCancelled,
  loadCancelledError,
  raceLoadCancel,
  throwIfLoadCancelled,
} from './load-cancel.js'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('loadCancelledError', () => {
  it("carries the app's code and wording verbatim", () => {
    const error = loadCancelledError()
    expect(error).toBeInstanceOf(AtomicCoreError)
    expect(error.toJSON()).toEqual({
      code: 'MODEL_LOAD_CANCELLED',
      message: 'The model load was cancelled.',
    })
    expect(MODEL_LOAD_CANCELLED_MESSAGE).toBe('The model load was cancelled.')
  })
})

describe('isLoadCancelled / throwIfLoadCancelled', () => {
  it('a caller with no signal is never cancelled', () => {
    expect(isLoadCancelled(undefined)).toBe(false)
    expect(() => throwIfLoadCancelled(undefined)).not.toThrow()
  })

  it('reports and throws once the signal is aborted', () => {
    const controller = new AbortController()
    expect(isLoadCancelled(controller.signal)).toBe(false)
    expect(() => throwIfLoadCancelled(controller.signal)).not.toThrow()
    controller.abort()
    expect(isLoadCancelled(controller.signal)).toBe(true)
    expect(() => throwIfLoadCancelled(controller.signal)).toThrowError(
      expect.objectContaining({ code: 'MODEL_LOAD_CANCELLED' })
    )
  })
})

describe('raceLoadCancel', () => {
  it('is the work itself when there is nothing to cancel with', async () => {
    const work = Promise.resolve(7)
    expect(raceLoadCancel(work)).toBe(work)
    await expect(raceLoadCancel(work)).resolves.toBe(7)
  })

  it('settles with the work when the signal never aborts, and stops listening', async () => {
    const controller = new AbortController()
    const added: string[] = []
    const removed: string[] = []
    const signal = controller.signal
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      added.push(type)
      return (add as (...args: unknown[]) => void)(type, ...rest)
    }) as typeof signal.addEventListener
    signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      removed.push(type)
      return (remove as (...args: unknown[]) => void)(type, ...rest)
    }) as typeof signal.removeEventListener

    await expect(raceLoadCancel(Promise.resolve('ready'), signal)).resolves.toBe('ready')
    await expect(raceLoadCancel(Promise.reject(new Error('boom')), signal)).rejects.toThrow('boom')
    expect(added).toEqual(['abort', 'abort'])
    expect(removed).toEqual(['abort', 'abort'])
  })

  it('rejects at once when the signal is already aborted, swallowing the abandoned work', async () => {
    const controller = new AbortController()
    controller.abort()
    const work = deferred<number>()
    const raced = raceLoadCancel(work.promise, controller.signal)
    await expect(raced).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    // Would surface as an unhandled rejection if the abandoned work were not swallowed.
    work.reject(new Error('late failure'))
    await new Promise((r) => setImmediate(r))
  })

  it('rejects the moment the signal aborts, before the work settles', async () => {
    const controller = new AbortController()
    const work = deferred<number>()
    const raced = raceLoadCancel(work.promise, controller.signal)
    let settled = false
    void raced.catch(() => {
      settled = true
    })
    await new Promise((r) => setImmediate(r))
    expect(settled).toBe(false)
    controller.abort()
    await expect(raced).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
      message: MODEL_LOAD_CANCELLED_MESSAGE,
    })
    work.reject(new Error('late failure'))
    await new Promise((r) => setImmediate(r))
  })
})

// The five semantics of the app's `load_cancel.rs` tests, then what the shared entry adds.
describe('LoadCancelRegistry', () => {
  it('cancel trips the registered load', () => {
    const registry = new LoadCancelRegistry()
    const handle = registry.register('qwen')
    expect(registry.cancel('qwen')).toBe(true)
    expect(handle.signal.aborted).toBe(true)
  })

  it('cancel without a load in flight reports nothing to cancel', () => {
    const registry = new LoadCancelRegistry()
    expect(registry.cancel('qwen')).toBe(false)
    registry.register('qwen').release()
    expect(registry.cancel('qwen')).toBe(false)
  })

  it('a finished load does not unregister one still pending', () => {
    const registry = new LoadCancelRegistry()
    const first = registry.register('qwen')
    const second = registry.register('qwen')
    first.release()
    expect(registry.cancel('qwen')).toBe(true)
    expect(second.signal.aborted).toBe(true)
  })

  it('a new load does not inherit an earlier cancel', () => {
    const registry = new LoadCancelRegistry()
    const first = registry.register('qwen')
    registry.cancel('qwen')
    first.release()
    const second = registry.register('qwen')
    expect(second.signal.aborted).toBe(false)
  })

  it('a tripped signal resolves a pending race', async () => {
    const registry = new LoadCancelRegistry()
    const handle = registry.register('qwen')
    const raced = raceLoadCancel(new Promise<never>(() => {}), handle.signal)
    registry.cancel('qwen')
    await expect(raced).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(isLoadCancelled(handle.signal)).toBe(true)
  })

  it('loads pending on one key share an entry, so one cancel reaches the one that is running', () => {
    const registry = new LoadCancelRegistry()
    const running = registry.register('qwen')
    const queued = registry.register('qwen')
    expect(queued.signal).toBe(running.signal)
    expect(registry.cancel('qwen')).toBe(true)
    expect(running.signal.aborted).toBe(true)
    expect(queued.signal.aborted).toBe(true)
  })

  it('a load registered while a cancelled one unwinds starts clean, and the old release leaves it alone', () => {
    const registry = new LoadCancelRegistry()
    const cancelled = registry.register('qwen')
    registry.cancel('qwen')
    // Still unwinding: the entry is there, and a repeated cancel says so.
    expect(registry.cancel('qwen')).toBe(true)
    const fresh = registry.register('qwen')
    expect(fresh.signal).not.toBe(cancelled.signal)
    expect(fresh.signal.aborted).toBe(false)
    cancelled.release()
    // The unwound load must not have removed the newer entry.
    expect(registry.cancel('qwen')).toBe(true)
    expect(fresh.signal.aborted).toBe(true)
  })

  it('keys are independent, and release is idempotent', () => {
    const registry = new LoadCancelRegistry()
    const a = registry.register('llamacpp\0a')
    const b = registry.register('mlx\0a')
    expect(registry.cancel('llamacpp\0a')).toBe(true)
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(false)
    const again = registry.register('mlx\0a')
    b.release()
    b.release()
    // One holder is left, so the entry is still there.
    expect(registry.cancel('mlx\0a')).toBe(true)
    expect(again.signal.aborted).toBe(true)
  })
})
