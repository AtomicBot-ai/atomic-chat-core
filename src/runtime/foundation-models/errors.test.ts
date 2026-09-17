import { describe, expect, it } from 'vitest'
import {
  classifyFoundationModelsExit,
  classifyFoundationModelsStderr,
  foundationModelsBinaryMissing,
  foundationModelsErrorLine,
  foundationModelsTimeout,
} from './errors.js'

describe('foundation models errors', () => {
  it('recognises the Swift server wording for a model that is still downloading', () => {
    const error = classifyFoundationModelsStderr(
      '[foundation-models] ERROR: Foundation model is downloading or not yet ready'
    )
    expect(error.code).toBe('FOUNDATION_MODELS_UNAVAILABLE')
    expect(error.message).toMatch(/still downloading/)
  })

  it('finds the reason line, case-sensitively, among other stderr output', () => {
    const stderr =
      'info Hummingbird: starting\n[foundation-models] ERROR: Device is not eligible for Apple Intelligence\n'
    expect(foundationModelsErrorLine(stderr)).toBe(
      '[foundation-models] ERROR: Device is not eligible for Apple Intelligence'
    )
    expect(foundationModelsErrorLine('[FOUNDATION-MODELS] error: x')).toBeUndefined()
  })

  it('explains an exit by the reason line when there is one, with only that line as details', () => {
    const error = classifyFoundationModelsExit(
      { code: 1, signal: null },
      'noise\n[foundation-models] ERROR: Apple Intelligence is not enabled in System Settings\n'
    )
    expect(error.toJSON()).toEqual({
      code: 'FOUNDATION_MODELS_UNAVAILABLE',
      message:
        'Apple Intelligence is not enabled. Please enable it in System Settings → Apple Intelligence & Siri.',
      details: '[foundation-models] ERROR: Apple Intelligence is not enabled in System Settings',
    })
  })

  it('reports a bare exit with the plugin message and code, -1 for a signal', () => {
    expect(classifyFoundationModelsExit({ code: 3, signal: null }, '').toJSON()).toEqual({
      code: 'SERVER_START_FAILED',
      message:
        'Foundation Models server exited with code 3 before becoming ready. Ensure Apple Intelligence is enabled in System Settings.',
    })
    expect(classifyFoundationModelsExit({ code: null, signal: 'SIGKILL' }, '').message).toContain('code -1 ')
  })

  it('words the timeout and a missing binary as the plugin did', () => {
    expect(foundationModelsTimeout(60).toJSON()).toEqual({
      code: 'SERVER_START_TIMED_OUT',
      message: 'Foundation Models server did not become ready within 60 seconds.',
    })
    expect(foundationModelsBinaryMissing('/r/foundation-models-server').toJSON()).toEqual({
      code: 'BINARY_NOT_FOUND',
      message: 'foundation-models-server binary not found at: /r/foundation-models-server',
    })
  })
})
