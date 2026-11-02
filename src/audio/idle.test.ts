import { describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import { AsyncMutex } from '../diffusion/index.js'
import { sampleAudioSpec } from '../../test/helpers/audio-fixtures.js'
import { audioIdleTick, startAudioIdleTask } from './idle.js'
import type { AudioIdleDeps } from './idle.js'
import { AudioState } from './state.js'

function world() {
  let now = 0
  const state = new AudioState(dataLayout('/data').audio, () => now)
  const unloads: string[] = []
  const logs: string[] = []
  const deps: AudioIdleDeps = {
    state,
    loadLock: new AsyncMutex(),
    unload: async (reason) => {
      unloads.push(reason)
      state.spec = undefined
    },
    log: (level, msg) => logs.push(`${level} ${msg}`),
  }
  return { state, deps, unloads, logs, advance: (ms: number) => (now += ms) }
}

describe('audioIdleTick', () => {
  it('unloads a model idle past the deadline, and only then', async () => {
    const w = world()
    w.state.spec = sampleAudioSpec()
    w.state.touchIdle()
    expect(await audioIdleTick(w.deps)).toBe(false)
    w.advance(600_000)
    expect(await audioIdleTick(w.deps)).toBe(true)
    expect(w.unloads).toEqual(['idle'])
    expect(w.logs).toEqual(['info unloading the audio model after idling'])
  })

  it('waits for a job, never queues behind a load, and clears a deadline with nothing to unload', async () => {
    const w = world()
    w.state.spec = sampleAudioSpec()
    w.state.touchIdle()
    w.advance(600_000)
    w.state.activeJobId = 'job'
    expect(await audioIdleTick(w.deps)).toBe(false)
    w.state.activeJobId = undefined
    const release = await w.deps.loadLock.acquire()
    expect(await audioIdleTick(w.deps)).toBe(false)
    release()
    w.state.spec = undefined
    expect(await audioIdleTick(w.deps)).toBe(false)
    expect(w.state.idleExpired()).toBe(false)
    expect(w.unloads).toEqual([])
  })

  it('logs a failed unload and lets the lock go', async () => {
    const w = world()
    w.state.spec = sampleAudioSpec()
    w.state.touchIdle()
    w.advance(600_000)
    w.deps.unload = async () => Promise.reject(new Error('stuck'))
    expect(await audioIdleTick(w.deps)).toBe(false)
    expect(w.logs).toContain('warn idle unload failed: stuck')
    expect(w.deps.loadLock.locked).toBe(false)
  })
})

describe('startAudioIdleTask', () => {
  it('ticks until stopped', async () => {
    const w = world()
    w.state.spec = sampleAudioSpec()
    w.state.touchIdle()
    w.advance(600_000)
    const task = startAudioIdleTask({ ...w.deps, tickMs: 10 })
    await new Promise((resolve) => setTimeout(resolve, 60))
    task.stop()
    expect(w.unloads).toEqual(['idle'])
  })
})
