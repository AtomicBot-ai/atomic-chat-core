import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HEARTBEAT_INTERVAL_SECS } from './watchdog.js'
import { startHeartbeatTicker } from './heartbeat.js'
import type { HeartbeatFs } from './heartbeat.js'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
})
afterEach(() => {
  vi.useRealTimers()
})

const noopOnError = (): void => {}

function fakeFs(): HeartbeatFs & { writes: string[] } {
  const writes: string[] = []
  return {
    writes,
    async writeFile(_path, data) {
      writes.push(data)
    },
  }
}

describe('startHeartbeatTicker', () => {
  it('writes the heartbeat immediately, then again every interval, until stopped', async () => {
    const fs = fakeFs()
    const ticker = startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      onError: noopOnError,
    })

    expect(fs.writes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fs.writes).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(2_000)
    expect(fs.writes).toHaveLength(4)

    ticker.stop()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fs.writes).toHaveLength(4)
  })

  it('writes the current clock reading as the heartbeat content, so mtime-only readers still see it move', async () => {
    const fs = fakeFs()
    let now = 1_000
    startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      now: () => now,
      onError: noopOnError,
    })

    expect(fs.writes).toEqual(['1000'])

    now = 2_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fs.writes).toEqual(['1000', '2000'])
  })

  it('defaults the interval to DEFAULT_HEARTBEAT_INTERVAL_SECS when none is given', async () => {
    const fs = fakeFs()
    const ticker = startHeartbeatTicker({ path: '/tmp/heartbeat', fs, onError: noopOnError })

    await vi.advanceTimersByTimeAsync(DEFAULT_HEARTBEAT_INTERVAL_SECS * 1_000 - 1)
    expect(fs.writes).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1)
    expect(fs.writes).toHaveLength(2)

    ticker.stop()
  })

  it('reports a failed write through onError and keeps ticking instead of throwing', async () => {
    const errors: unknown[] = []
    const failure = new Error('disk full')
    const fs: HeartbeatFs = {
      writeFile: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined),
    }
    const ticker = startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      onError: (error) => errors.push(error),
    })

    // The first tick's rejection is asynchronous; let its microtask settle before asserting.
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([failure])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(fs.writeFile).toHaveBeenCalledTimes(2)
    expect(errors).toEqual([failure])

    ticker.stop()
  })

  it('never throws out of stop(), even called twice', () => {
    const fs = fakeFs()
    const ticker = startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      onError: noopOnError,
    })
    expect(() => {
      ticker.stop()
      ticker.stop()
    }).not.toThrow()
  })

  it('resolves ready only once the first write actually succeeds, not on a failed one', async () => {
    const errors: unknown[] = []
    const failure = new Error('disk full')
    const fs: HeartbeatFs = {
      writeFile: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined),
    }
    const ticker = startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      onError: (error) => errors.push(error),
    })

    let resolved = false
    ticker.ready.then(() => {
      resolved = true
    })

    // First tick fails: ready must not resolve from it.
    await vi.advanceTimersByTimeAsync(0)
    expect(errors).toEqual([failure])
    expect(resolved).toBe(false)

    // Second tick (the next interval) succeeds: now ready resolves.
    await vi.advanceTimersByTimeAsync(1_000)
    await ticker.ready
    expect(resolved).toBe(true)

    ticker.stop()
  })

  // Item 5 (findings-2.9-r2): `ready` used to be a plain resolve-only promise, so a ticker that was
  // stopped before its first write ever succeeded (every write failing, or stop() called before any
  // write had a chance to settle) left any caller `await`ing `ready` hanging forever.
  it('rejects ready if stop() is called before the first write ever succeeds', async () => {
    const fs: HeartbeatFs = {
      writeFile: vi.fn().mockRejectedValue(new Error('disk full')),
    }
    const ticker = startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      onError: noopOnError,
    })

    await vi.advanceTimersByTimeAsync(0) // let the first (failing) write settle
    ticker.stop()

    await expect(ticker.ready).rejects.toThrow(/stopped/i)
  })

  it('rejects ready if stop() is called synchronously, before the first write has any chance to settle', async () => {
    const fs = fakeFs()
    const ticker = startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      onError: noopOnError,
    })

    ticker.stop()

    await expect(ticker.ready).rejects.toThrow(/stopped/i)
  })

  it('leaves ready resolved (does not retroactively reject it) if stop() is called after the first write already succeeded', async () => {
    const fs = fakeFs()
    const ticker = startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      onError: noopOnError,
    })

    await ticker.ready
    ticker.stop()

    await expect(ticker.ready).resolves.toBeUndefined()
  })

  it('skips a tick while the previous write is still in flight, instead of overlapping it', async () => {
    let resolveFirstWrite: (() => void) | undefined
    let writeCalls = 0
    const fs: HeartbeatFs = {
      writeFile: vi.fn().mockImplementation(() => {
        writeCalls += 1
        if (writeCalls === 1) {
          return new Promise<void>((resolve) => {
            resolveFirstWrite = resolve
          })
        }
        return Promise.resolve()
      }),
    }

    const ticker = startHeartbeatTicker({
      path: '/tmp/heartbeat',
      intervalMs: 1_000,
      fs,
      onError: noopOnError,
    })
    expect(fs.writeFile).toHaveBeenCalledTimes(1)

    // Two more intervals elapse while the first write is still pending: both ticks are skipped.
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fs.writeFile).toHaveBeenCalledTimes(1)

    // The first write finally resolves; the next scheduled tick is free to proceed again.
    resolveFirstWrite?.()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fs.writeFile).toHaveBeenCalledTimes(2)

    ticker.stop()
  })
})
