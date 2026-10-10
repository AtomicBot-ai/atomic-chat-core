import { describe, expect, it } from 'vitest'
import { describeMlxExit, mlxBinaryMissing, mlxModelMissing, mlxTimeout } from './errors.js'

describe('mlx errors', () => {
  it('diagnoses an exit the way the plugin logged it', () => {
    expect(describeMlxExit({ code: null, signal: 'SIGTERM' }, '')).toContain('signal SIGTERM')
    expect(describeMlxExit({ code: 1, signal: null }, '  ')).toContain('produced no stderr')
    expect(describeMlxExit({ code: null, signal: null }, '')).toContain('code -1')
    expect(describeMlxExit({ code: 1, signal: null }, 'out of memory')).toBe(
      'Out of memory. The model requires more memory than is available on this device.'
    )
  })

  it('words startup failures as the plugin did', () => {
    expect(mlxTimeout(600, 'loading').toJSON()).toEqual({
      code: 'MODEL_LOAD_TIMED_OUT',
      message: 'The MLX model took too long to load and timed out.',
      details: 'Timeout: 600s\n\nStderr:\nloading',
    })
    expect(mlxBinaryMissing('/b').toJSON()).toEqual({
      code: 'BINARY_NOT_FOUND',
      message: 'MLX is not installed. Install the MLX engine, then load the model again.',
      details: 'mlx-server not found; looked at /b',
    })
    expect(mlxBinaryMissing().details).toBeUndefined()
    expect(mlxModelMissing('/m').message).toBe('Model file not found at: /m')
  })
})
