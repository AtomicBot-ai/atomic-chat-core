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
    const ticker = startHeartbeatTicker({ path: '/tmp/heartbeat', intervalMs: 1_000, fs })

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
    startHeartbeatTicker({ path: '/tmp/heartbeat', intervalMs: 1_000, fs, now: () => now })

    expect(fs.writes).toEqual(['1000'])

    now = 2_000
    await vi.advanceTimersByTimeAsync(1_000)
    expect(fs.writes).toEqual(['1000', '2000'])
  })

  it('defaults the interval to DEFAULT_HEARTBEAT_INTERVAL_SECS when none is given', async () => {
    const fs = fakeFs()
    const ticker = startHeartbeatTicker({ path: '/tmp/heartbeat', fs })

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
    const ticker = startHeartbeatTicker({ path: '/tmp/heartbeat', intervalMs: 1_000, fs })
    expect(() => {
      ticker.stop()
      ticker.stop()
    }).not.toThrow()
  })
})
