import { describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import { DiffusionState, isTerminalJobState, JOB_HISTORY } from './state.js'
import type { JobRecord } from './state.js'

const paths = dataLayout('/data').diffusion

function record(id: string): JobRecord {
  return {
    kind: 'image',
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

  it('keeps the video folder apart from the image folder', () => {
    const state = new DiffusionState(paths)
    expect(state.videoOutputDir()).toBe(paths.defaultVideoOutputDir)
    expect(state.activeVideoJob()).toBeNull()
    state.config = { dataFolder: '/data', outputDir: '/pics', videoOutputDir: ' ' }
    expect(state.videoOutputDir()).toBe(paths.defaultVideoOutputDir)
    state.config = { dataFolder: '/data', videoOutputDir: '/clips' }
    expect(state.videoOutputDir()).toBe('/clips')
    expect(state.outputDir()).toBe(paths.defaultOutputDir)
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

  it('keeps image and video records apart, and lists the video ones newest first', () => {
    const state = new DiffusionState(paths)
    const video = (id: string, createdAtMs: number): JobRecord => ({
      kind: 'video',
      job: {
        id,
        state: 'queued',
        modelId: 'ltx-2:q4_k_m',
        request: { prompt: 'x', width: 768, height: 512, steps: 8, cfgScale: 1 },
        createdAtMs,
        progress: null,
        outputs: [],
      },
      cancel: { requested: false },
    })
    state.insertJob(record('img'))
    state.insertJob(video('v1', 1))
    state.insertJob(video('v2', 2))
    expect(state.job('v1')).toBeUndefined()
    expect(state.videoJob('img')).toBeUndefined()
    expect(state.videoJob('v1')?.modelId).toBe('ltx-2:q4_k_m')
    expect(state.anyJob('img')?.id).toBe('img')
    expect(state.anyJob('v2')?.id).toBe('v2')
    expect(state.anyJob('nope')).toBeUndefined()
    expect(state.videoJobs().map((j) => j.id)).toEqual(['v2', 'v1'])
    // Copies, both ways.
    const copy = state.videoJob('v1')
    if (copy) copy.state = 'failed'
    expect(state.videoJob('v1')?.state).toBe('queued')

    state.activeJobId = 'v1'
    expect(state.activeJob()).toBeNull()
    expect(state.activeVideoJob()?.id).toBe('v1')
    state.updateJob('v1', (r) => (r.job.state = 'completed'))
    expect(state.activeVideoJob()).toBeNull()
    state.activeJobId = 'img'
    expect(state.activeVideoJob()).toBeNull()
    expect(state.activeJob()?.id).toBe('img')
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
