import { describe, expect, it } from 'vitest'
import { err, ok } from './result.js'

describe('Result', () => {
  it('carries a value on success and nothing else', () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 })
    // A successful result with no payload is still a success, not an absent answer.
    expect(ok(undefined)).toEqual({ ok: true, value: undefined })
  })

  it('carries the same error shape the core throws, omitting details when there are none', () => {
    expect(err('GPU_BUSY', 'Another model holds the GPU.')).toEqual({
      ok: false,
      error: { code: 'GPU_BUSY', message: 'Another model holds the GPU.' },
    })
    expect(err('MANAGED_OPERATION_CONFLICT', 'No.', 'phase=ready')).toEqual({
      ok: false,
      error: { code: 'MANAGED_OPERATION_CONFLICT', message: 'No.', details: 'phase=ready' },
    })
  })
})
