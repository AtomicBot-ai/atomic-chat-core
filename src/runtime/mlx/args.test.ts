import { describe, expect, it } from 'vitest'
import { buildMlxServerArgs, normalizeMlxModelPath } from './args.js'

const base = {
  ctx_size: 0,
  draft_model_path: '',
  block_size: 0,
  draft_kind: '',
  kv_bits: 0,
  kv_quant_scheme: '',
}

describe('mlx args', () => {
  it('collapses a weight file to its folder only when it is a file', () => {
    expect(normalizeMlxModelPath('/m/model.safetensors', () => true)).toBe('/m')
    expect(normalizeMlxModelPath('/m/model.safetensors', () => false)).toBe('/m/model.safetensors')
    expect(normalizeMlxModelPath('/definitely/not/here/model.safetensors')).toBe(
      '/definitely/not/here/model.safetensors'
    )
  })

  it('formats fractional and integral KV bits without a trailing zero', () => {
    expect(
      buildMlxServerArgs('/m', 1, { ...base, kv_bits: 4, kv_quant_scheme: 'uniform' }, () => false)
    ).toEqual([
      '--model',
      '/m',
      '--host',
      '127.0.0.1',
      '--port',
      '1',
      '--kv-bits',
      '4',
      '--kv-quant-scheme',
      'uniform',
    ])
  })
})
