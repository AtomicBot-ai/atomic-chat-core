import { describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import { DiffusionState, isTerminalJobState, JOB_HISTORY } from './state.js'
import type { JobRecord } from './state.js'

const paths = dataLayout('/data').diffusion

function record(id: string): JobRecord {
  return {
    job: {
      id,
      state: 'queued',
      modelId: 'm',
      request: { prompt: 'x', width: 512, height: 512, steps: 4, cfgScale: 1, batchSize: 1 },
      createdAtMs: 1,
      progress: null,
      outputs: [],
    },
    cancel: { requested: false },
  }
}

describe('DiffusionState', () => {
  it('starts unconfigured, with the default output folder and idle interval', () => {
    const state = new DiffusionState(paths)
    expect(state.configured).toBe(false)
    expect(state.outputDir()).toBe(paths.defaultOutputDir)
    expect(state.idleUnloadSecs()).toBe(600)
    state.config = { dataFolder: '/data', outputDir: '  ', idleUnloadSecs: 0 }
    expect(state.configured).toBe(true)
    expect(state.outputDir()).toBe(paths.defaultOutputDir)
    expect(state.idleUnloadSecs()).toBe(0)
    state.config = { dataFolder: '/data', outputDir: '/pics' }
    expect(state.outputDir()).toBe('/pics')
  })

  it('keeps the idle deadline against an injected clock, and never for zero seconds', () => {
    let clock = 1_000
    const state = new DiffusionState(paths, () => clock)
    state.config = { dataFolder: '/data', idleUnloadSecs: 10 }
    expect(state.idleExpired()).toBe(false)
    state.touchIdle()
    expect(state.idleExpired()).toBe(false)
    clock += 9_999
    expect(state.idleExpired()).toBe(false)
    clock += 1
    expect(state.idleExpired()).toBe(true)
    state.clearIdle()
    expect(state.idleExpired()).toBe(false)
    state.config = { dataFolder: '/data', idleUnloadSecs: 0 }
    state.touchIdle()
    clock += 1_000_000
    expect(state.idleExpired()).toBe(false)
  })

  it('hands out copies of jobs, keeps a bounded history, and knows the active one', () => {
    const state = new DiffusionState(paths)
    state.insertJob(record('a'))
    const copy = state.job('a')
    expect(copy?.state).toBe('queued')
    if (copy) copy.state = 'failed'
    expect(state.job('a')?.state).toBe('queued')
    expect(state.job('missing')).toBeUndefined()
    expect(state.updateJob('missing', () => {})).toBeUndefined()
    expect(state.record('a')?.cancel.requested).toBe(false)

    expect(state.activeJob()).toBeNull()
    state.activeJobId = 'a'
    expect(state.activeJob()?.id).toBe('a')
    expect(state.updateJob('a', (r) => (r.job.state = 'generating'))?.state).toBe('generating')
    expect(state.activeJob()?.state).toBe('generating')
    state.updateJob('a', (r) => (r.job.state = 'completed'))
    expect(state.activeJob()).toBeNull()
    state.activeJobId = 'gone'
    expect(state.activeJob()).toBeNull()

    for (let i = 0; i < JOB_HISTORY + 3; i++) state.insertJob(record(`j${i}`))
    expect(state.jobIds()).toHaveLength(JOB_HISTORY)
    expect(state.job('a')).toBeUndefined()
    expect(state.job('j2')).toBeUndefined()
    expect(state.job('j3')).toBeDefined()
    expect(state.job(`j${JOB_HISTORY + 2}`)).toBeDefined()
  })

  it('tracks the model state with its error', () => {
    const state = new DiffusionState(paths)
    state.setModelState('failed', { code: 'OUT_OF_MEMORY', message: 'oom' })
    expect([state.modelState, state.modelError?.code]).toEqual(['failed', 'OUT_OF_MEMORY'])
    state.setModelState('unloaded')
    expect(state.modelError).toBeUndefined()
    expect(isTerminalJobState('cancelled')).toBe(true)
    expect(isTerminalJobState('generating')).toBe(false)
  })
})
