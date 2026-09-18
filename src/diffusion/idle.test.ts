import { describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import { idleTick, startIdleTask } from './idle.js'
import { AsyncMutex } from './mutex.js'
import { DiffusionState } from './state.js'
import type { DiffusionSession } from './state.js'

const paths = dataLayout('/data').diffusion

function setup(clock: { now: number }) {
  const state = new DiffusionState(paths, () => clock.now)
  state.config = { dataFolder: '/data', idleUnloadSecs: 10 }
  const unloads: string[] = []
  const log: string[] = []
  const loadLock = new AsyncMutex()
  const deps = {
    state,
    loadLock,
    unload: async (reason: string) => {
      unloads.push(reason)
      state.session = undefined
      state.clearIdle()
    },
    log: (level: string, msg: string) => log.push(`${level}: ${msg}`),
  }
  state.session = { server: {} } as unknown as DiffusionSession
  return { state, deps, unloads, log, loadLock }
}

describe('idleTick', () => {
  it('unloads once the deadline has passed and nothing is running', async () => {
    const clock = { now: 1_000 }
    const { state, deps, unloads, log } = setup(clock)
    state.touchIdle()
    expect(await idleTick(deps)).toBe(false)
    clock.now += 10_000
    state.activeJobId = 'job'
    expect(await idleTick(deps), 'a running job keeps the model').toBe(false)
    state.activeJobId = undefined
    expect(await idleTick(deps)).toBe(true)
    expect(unloads).toEqual(['idle'])
    expect(log).toEqual(['info: unloading the image model after idling'])
    // Nothing left to unload: the deadline is dropped instead.
    state.touchIdle()
    clock.now += 10_000
    expect(await idleTick(deps)).toBe(false)
    expect(state.idleExpired()).toBe(false)
  })

  it('never waits behind a load, and reports an unload that failed', async () => {
    const clock = { now: 1_000 }
    const { state, deps, unloads, log, loadLock } = setup(clock)
    state.touchIdle()
    clock.now += 10_000
    const release = await loadLock.acquire()
    expect(await idleTick(deps)).toBe(false)
    expect(unloads).toEqual([])
    release()
    const failing = { ...deps, unload: () => Promise.reject(new Error('boom')) }
    expect(await idleTick(failing)).toBe(false)
    expect(log.at(-1)).toBe('warn: idle unload failed: boom')
    expect(loadLock.locked).toBe(false)
  })

  it('ticks on a timer that does not hold the process open', async () => {
    const clock = { now: 1_000 }
    const { state, deps, unloads } = setup(clock)
    state.touchIdle()
    clock.now += 10_000
    const task = startIdleTask({ ...deps, tickMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    task.stop()
    expect(unloads).toEqual(['idle'])
  })
})
