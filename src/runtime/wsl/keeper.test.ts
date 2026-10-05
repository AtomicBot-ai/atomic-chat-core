import { describe, expect, it } from 'vitest'
import type { WslDistributionTransport, WslHold, WslHoldEnd } from './transport.js'
import { createDistributionKeeper } from './keeper.js'

/** A transport whose holds are visible and can be ended from outside (`wsl --shutdown`). */
const fake = () => {
  const live: { end: (released: boolean) => void }[] = []
  let started = 0
  const transport: WslDistributionTransport = {
    name: 'AtomicChat',
    exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    hold: (): WslHold => {
      started += 1
      let resolve!: (end: WslHoldEnd) => void
      const exited = new Promise<WslHoldEnd>((r) => (resolve = r))
      const entry = {
        end: (released: boolean) => {
          live.splice(live.indexOf(entry), 1)
          resolve({ code: released ? null : 1, signal: null, released })
        },
      }
      live.push(entry)
      return { exited, release: () => entry.end(true) }
    },
  }
  return { transport, live, started: () => started, shutdown: () => [...live].forEach((h) => h.end(false)) }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('createDistributionKeeper', () => {
  it('holds the distribution while anything needs it, with one process however many need it', () => {
    const f = fake()
    const keeper = createDistributionKeeper(f.transport)
    const a = keeper.acquire('session')
    const b = keeper.acquire('download')
    expect(f.live).toHaveLength(1)
    a.release()
    expect(f.live).toHaveLength(1)
    b.release()
    expect(f.live).toHaveLength(0)
  })

  it('holds nothing when nothing needs it (spec "Простой")', () => {
    const f = fake()
    const keeper = createDistributionKeeper(f.transport)
    keeper.acquire('session').release()
    expect(f.live).toHaveLength(0)
    expect(keeper.held()).toBe(false)
  })

  it('a release is idempotent: releasing twice never lets go of someone else’s hold', () => {
    const f = fake()
    const keeper = createDistributionKeeper(f.transport)
    const a = keeper.acquire('session')
    keeper.acquire('download')
    a.release()
    a.release()
    expect(f.live).toHaveLength(1)
  })

  it('tells every subscriber when the VM stops under a hold, and starts nothing again by itself', async () => {
    const f = fake()
    const keeper = createDistributionKeeper(f.transport)
    const stops: string[] = []
    keeper.onStopped(() => stops.push('stopped'))
    keeper.acquire('session')
    f.shutdown()
    await tick()
    expect(stops).toEqual(['stopped'])
    // Restarting on its own would boot the VM the user stopped, or loop on a missing distribution.
    expect(f.started()).toBe(1)
    expect(keeper.held()).toBe(false)
    // The next one who needs it holds it again.
    keeper.acquire('load')
    expect(f.started()).toBe(2)
  })

  it('does not report its own release as a stop', async () => {
    const f = fake()
    const keeper = createDistributionKeeper(f.transport)
    const stops: string[] = []
    keeper.onStopped(() => stops.push('stopped'))
    keeper.acquire('session').release()
    await tick()
    expect(stops).toEqual([])
  })

  it('a subscriber that releases its lease on the stop keeps the VM down', async () => {
    const f = fake()
    const keeper = createDistributionKeeper(f.transport)
    const lease = keeper.acquire('session')
    keeper.onStopped(() => lease.release())
    f.shutdown()
    await tick()
    expect(f.started()).toBe(1)
    expect(f.live).toHaveLength(0)
  })
})
