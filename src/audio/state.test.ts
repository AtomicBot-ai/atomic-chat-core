import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { AudioJob } from '../contracts/index.js'
import { AudioState, isTerminalAudioJobState, JOB_HISTORY } from './state.js'
import type { AudioJobRecord } from './state.js'

const paths = dataLayout('/data').audio
const record = (id: string, state: AudioJob['state'] = 'queued'): AudioJobRecord => ({
  job: {
    id,
    state,
    mode: 'speech',
    modelId: 'm',
    request: { text: 'x' },
    createdAtMs: 1,
    progress: { phase: 'queued', elapsedMs: 0 },
    output: null,
  },
  cancel: { requested: false, abort: new AbortController() },
})

describe('AudioState', () => {
  it('answers the default output folder until one is chosen, and goes back to it', () => {
    const state = new AudioState(paths)
    expect(state.outputDir()).toBe(join('/data', 'audios'))
    state.outputDirOverride = '/sounds'
    expect(state.outputDir()).toBe('/sounds')
    state.outputDirOverride = '   '
    expect(state.outputDir()).toBe(join('/data', 'audios'))
  })

  it('arms the idle deadline from the setting, never with 0, and clears it', () => {
    let now = 1_000
    const state = new AudioState(paths, () => now)
    expect(state.idleUnloadSecs).toBe(600)
    state.touchIdle()
    expect(state.idleExpired()).toBe(false)
    now += 600_000
    expect(state.idleExpired()).toBe(true)
    state.clearIdle()
    expect(state.idleExpired()).toBe(false)
    state.idleUnloadSecs = 0
    state.touchIdle()
    now += 10_000_000
    expect(state.idleExpired()).toBe(false)
  })

  it('keeps copies of the jobs, the active one in the status, and a bounded history', () => {
    const state = new AudioState(paths)
    state.insertJob(record('a'))
    const copy = state.job('a') as AudioJob
    copy.state = 'failed'
    expect(state.job('a')?.state).toBe('queued')
    expect(state.activeJob()).toBeNull()
    state.activeJobId = 'a'
    expect(state.activeJob()?.id).toBe('a')
    expect(state.updateJob('a', (job) => (job.state = 'completed'))?.state).toBe('completed')
    expect(state.activeJob()).toBeNull()
    expect(state.updateJob('missing', () => {})).toBeUndefined()
    for (let i = 0; i < JOB_HISTORY + 5; i++) state.insertJob(record(`j${i}`))
    expect(state.job('a')).toBeUndefined()
    expect(state.record('j4')).toBeUndefined()
    expect(state.record('j5')?.job.id).toBe('j5')
    expect(state.record(`j${JOB_HISTORY + 4}`)?.job.id).toBe(`j${JOB_HISTORY + 4}`)
  })

  it('remembers the model state and its error together', () => {
    const state = new AudioState(paths)
    state.setModelState('failed', { code: 'MODEL_LOAD_FAILED', message: 'x' })
    expect([state.modelState, state.modelError?.code]).toEqual(['failed', 'MODEL_LOAD_FAILED'])
    state.setModelState('loaded')
    expect(state.modelError).toBeUndefined()
  })
})

describe('isTerminalAudioJobState', () => {
  it.each([
    ['queued', false],
    ['generating', false],
    ['completed', true],
    ['failed', true],
    ['cancelled', true],
  ] as const)('%s → %s', (state, expected) => {
    expect(isTerminalAudioJobState(state)).toBe(expected)
  })
})
