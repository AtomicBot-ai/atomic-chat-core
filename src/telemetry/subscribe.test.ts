import { describe, expect, it } from 'vitest'
import { CoreEmitter } from '../events/index.js'
import { reportCoreEvents } from './subscribe.js'
import type { ErrorReport } from './types.js'

describe('reportCoreEvents', () => {
  it('lets the internal observer own diffusion failures while keeping session death reporting', () => {
    const events = new CoreEmitter({ instanceId: 'i' })
    const captured: ErrorReport[] = []
    const off = reportCoreEvents(events, { capture: (r) => captured.push(r) }, 'linux', false)
    events.emit('diffusion:error', { code: 'ENGINE_CRASHED', message: 'already observed' })
    const died = {
      provider: 'mlx' as const,
      pid: 1,
      model_id: 'm',
      exit_code: null,
      signal: 'SIGSEGV',
      message: 'crashed',
    }
    events.emit('session:died', died)
    expect(captured.map((r) => r.source)).toEqual(['backend_crash'])
    off()
    events.emit('session:died', died)
    expect(captured).toHaveLength(1)
  })
  it('reports engine deaths and image failures, and stops when unsubscribed', () => {
    const events = new CoreEmitter({ instanceId: 'i' })
    const captured: ErrorReport[] = []
    const off = reportCoreEvents(events, { capture: (r) => captured.push(r) }, 'darwin')
    const died = { provider: 'mlx' as const, pid: 1, model_id: 'm', exit_code: null, message: 'crashed' }
    events.emit('session:died', { ...died, signal: 'SIGSEGV' })
    events.emit('session:died', { ...died, signal: 'SIGTERM' })
    events.emit('diffusion:error', { code: 'MODEL_LOAD_FAILED', message: 'x', details: 'error: bad tensor' })
    events.emit('diffusion:error', { code: 'ENGINE_CRASHED', message: 'y', jobId: 'job-1' })
    events.emit('diffusion:error', { code: 'DISK_FULL', message: 'z', jobId: 'job-2' })
    expect(captured.map((r) => r.fingerprint)).toEqual([
      ['backend-crash', 'mlx', 'sigsegv'],
      ['diffusion-load-failure', 'MODEL_LOAD_FAILED'],
      ['diffusion-failure', 'ENGINE_CRASHED'],
      ['diffusion-failure', 'DISK_FULL'],
    ])
    expect(captured[1]?.extra).toEqual({ engine_errors: 'error: bad tensor' })
    off()
    events.emit('session:died', { ...died, signal: 'SIGABRT' })
    expect(captured).toHaveLength(4)
  })

  it('reports audio failures the same way, leaving what the user can fix alone', () => {
    const events = new CoreEmitter({ instanceId: 'i' })
    const captured: ErrorReport[] = []
    const off = reportCoreEvents(events, { capture: (r) => captured.push(r) }, 'darwin')
    events.emit('audio:error', { code: 'MODEL_LOAD_FAILED', message: 'x', details: 'error: bad tensor' })
    events.emit('audio:error', { code: 'ENGINE_CRASHED', message: 'y', jobId: 'job-1' })
    events.emit('audio:error', { code: 'REQUEST_REJECTED', message: 'z', jobId: 'job-2' })
    off()
    events.emit('audio:error', { code: 'ENGINE_CRASHED', message: 'later', jobId: 'job-3' })
    expect(captured.map((r) => [r.source, ...(r.fingerprint ?? [])])).toEqual([
      ['audio_load', 'audio-load-failure', 'MODEL_LOAD_FAILED'],
      ['audio_job', 'audio-failure', 'ENGINE_CRASHED'],
    ])
  })
})
