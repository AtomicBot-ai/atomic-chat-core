import { describe, expect, it } from 'vitest'
import { LiteRtHostUsageError, parseLiteRtHostArgs } from './args.js'

const SERVE = [
  'serve',
  '--lib',
  '/b/0.18.1/macos-arm64',
  '--engine-version',
  '0.18.1',
  '--model',
  '/m/gemma.litertlm',
  '--backend',
  'gpu',
  '--max-tokens',
  '8192',
  '--port',
  '41234',
  '--cache',
  '/data/litert-lm/cache',
  '--id',
  'gemma-4-e2b-gpu',
]

describe('parseLiteRtHostArgs', () => {
  it('reads probe and inspect', () => {
    expect(parseLiteRtHostArgs(['probe', '--lib', '/b'])).toEqual({ mode: 'probe', lib: '/b' })
    expect(parseLiteRtHostArgs(['inspect', '--lib', '/b', '/m/x.litertlm'])).toEqual({
      mode: 'inspect',
      lib: '/b',
      file: '/m/x.litertlm',
    })
  })

  it('reads serve with every option, flags off by default', () => {
    expect(parseLiteRtHostArgs(SERVE)).toEqual({
      mode: 'serve',
      lib: '/b/0.18.1/macos-arm64',
      engineVersion: '0.18.1',
      model: '/m/gemma.litertlm',
      backend: 'gpu',
      maxTokens: 8192,
      port: 41234,
      cache: '/data/litert-lm/cache',
      id: 'gemma-4-e2b-gpu',
      speculative: false,
      reasoning: false,
    })
    expect(
      parseLiteRtHostArgs([
        ...SERVE.map((arg) => (arg === 'gpu' ? 'npu' : arg)),
        '--dispatch',
        '/b/lib/vendors/intel_openvino/dispatch',
        '--ov-libs',
        '/data/litert-lm/accelerators/openvino/2026.4.1',
        '--speculative',
        '--reasoning',
      ])
    ).toMatchObject({
      backend: 'npu',
      dispatch: '/b/lib/vendors/intel_openvino/dispatch',
      ovLibs: '/data/litert-lm/accelerators/openvino/2026.4.1',
      speculative: true,
      reasoning: true,
    })
  })

  it.each([
    [['serve'], /--lib/],
    [SERVE.filter((arg) => arg !== '--id' && arg !== 'gemma-4-e2b-gpu'), /--id/],
    [SERVE.map((arg) => (arg === 'gpu' ? 'tpu' : arg)), /--backend tpu/],
    [SERVE.map((arg) => (arg === '41234' ? '70000' : arg)), /--port 70000/],
    [SERVE.map((arg) => (arg === '8192' ? '-1' : arg)), /--max-tokens/],
    [SERVE.map((arg) => (arg === '8192' ? '0' : arg)), /--max-tokens 0/],
    [SERVE.map((arg) => (arg === '0.18.1' ? 'latest' : arg)), /--engine-version latest/],
    [SERVE.map((arg) => (arg === 'gpu' ? 'npu' : arg)), /--dispatch and --ov-libs/],
    [[...SERVE, '--dispatch', '/d'], /only for --backend npu/],
    [[...SERVE, '--unknown'], /unknown/i],
    [['inspect', '--lib', '/b'], /one model file/],
    [['probe'], /--lib/],
    [['serve-test'], /unknown mode/],
    [[], /unknown mode/],
  ])('refuses %j', (argv, message) => {
    expect(() => parseLiteRtHostArgs(argv)).toThrow(LiteRtHostUsageError)
    expect(() => parseLiteRtHostArgs(argv)).toThrow(message)
  })
})
