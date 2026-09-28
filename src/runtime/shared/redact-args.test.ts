import { describe, expect, it } from 'vitest'
import { redactArgs } from './redact-args.js'

describe('redactArgs', () => {
  it('masks the value that follows --api-key', () => {
    expect(redactArgs(['--port', '1234', '--api-key', 'sk-secret-value'])).toEqual([
      '--port',
      '1234',
      '--api-key',
      '<redacted>',
    ])
  })

  it('masks the --api-key=<value> single-token form', () => {
    expect(redactArgs(['--port', '1234', '--api-key=sk-secret-value'])).toEqual([
      '--port',
      '1234',
      '--api-key=<redacted>',
    ])
  })

  it('leaves every other argument untouched', () => {
    const args = ['--override-tensor', 'exps=CPU', '--n-gpu-layers', '100', '--flash-attn', 'auto']
    expect(redactArgs(args)).toEqual(args)
  })

  it('leaves a trailing --api-key with no value alone', () => {
    expect(redactArgs(['--port', '1234', '--api-key'])).toEqual(['--port', '1234', '--api-key'])
  })

  it('returns an empty list unchanged', () => {
    expect(redactArgs([])).toEqual([])
  })
})
