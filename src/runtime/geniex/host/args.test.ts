import { describe, expect, it } from 'vitest'
import { GeniexHostUsageError, parseGeniexHostArgs } from './args.js'

const SERVE = [
  'serve',
  '--lib',
  '/b/0.9.3/win-arm64',
  '--engine-version',
  '0.9.3',
  '--model',
  '/m/qwen3-4b/Qwen3-4B-Q4_0.gguf',
  '--plugin',
  'llama_cpp',
  '--device',
  'npu',
  '--nctx',
  '8192',
  '--max-tokens',
  '4096',
  '--power-mode',
  'burst',
  '--port',
  '41234',
  '--tmp',
  '/data/geniex/tmp',
  '--id',
  'qwen3-4b',
]

describe('parseGeniexHostArgs (task 5.1)', () => {
  it('reads probe and inspect', () => {
    expect(parseGeniexHostArgs(['probe', '--lib', '/b'])).toEqual({ mode: 'probe', lib: '/b' })
    expect(parseGeniexHostArgs(['inspect', '/m/x.gguf'])).toEqual({ mode: 'inspect', path: '/m/x.gguf' })
    expect(parseGeniexHostArgs(['inspect', '/m/bundle'])).toEqual({ mode: 'inspect', path: '/m/bundle' })
  })

  it('reads serve with every option, the optional ones off by default', () => {
    expect(parseGeniexHostArgs(SERVE)).toEqual({
      mode: 'serve',
      lib: '/b/0.9.3/win-arm64',
      engineVersion: '0.9.3',
      model: '/m/qwen3-4b/Qwen3-4B-Q4_0.gguf',
      plugin: 'llama_cpp',
      device: 'npu',
      nCtx: 8192,
      maxTokens: 4096,
      powerMode: 'burst',
      port: 41234,
      tmp: '/data/geniex/tmp',
      id: 'qwen3-4b',
      reasoning: false,
    })
    expect(
      parseGeniexHostArgs([...SERVE, '--mmproj', '/m/gemma/mmproj-F16.gguf', '--reasoning'])
    ).toMatchObject({ mmproj: '/m/gemma/mmproj-F16.gguf', reasoning: true })
    expect(parseGeniexHostArgs(SERVE.map((arg) => (arg === 'llama_cpp' ? 'qairt' : arg)))).toMatchObject({
      plugin: 'qairt',
    })
    for (const device of ['gpu', 'cpu', 'hybrid'])
      expect(parseGeniexHostArgs(SERVE.map((arg) => (arg === 'npu' ? device : arg)))).toMatchObject({
        device,
      })
  })

  it('refuses what core would never send: an unknown mode, option, plugin, device or power mode, a missing value', () => {
    const refuse = (argv: string[], why: RegExp) => expect(() => parseGeniexHostArgs(argv)).toThrow(why)
    refuse(['nope'], /unknown mode "nope"/)
    refuse([], /unknown mode ""/)
    refuse(['probe'], /--lib is required/)
    refuse(['probe', '--lib', '/b', '--extra'], /extra/)
    refuse(['inspect'], /inspect takes one path/)
    refuse(['inspect', '/a', '/b'], /inspect takes one path/)
    refuse(
      SERVE.map((arg) => (arg === 'llama_cpp' ? 'onnx' : arg)),
      /--plugin onnx is not llama_cpp or qairt/
    )
    refuse(
      SERVE.map((arg) => (arg === 'npu' ? 'tpu' : arg)),
      /--device tpu is not npu, gpu, cpu or hybrid/
    )
    refuse(
      SERVE.map((arg) => (arg === 'burst' ? 'turbo' : arg)),
      /--power-mode turbo is not one of/
    )
    refuse(
      SERVE.map((arg) => (arg === '0.9.3' ? 'latest' : arg)),
      /--engine-version latest is not X\.Y\.Z/
    )
    refuse(
      SERVE.map((arg) => (arg === '8192' ? '0' : arg)),
      /--nctx 0 is not a whole number from 1/
    )
    refuse(
      SERVE.map((arg) => (arg === '41234' ? '70000' : arg)),
      /--port 70000 is not a whole number/
    )
    refuse(
      SERVE.filter((arg) => arg !== '--id' && arg !== 'qwen3-4b'),
      /--id is required/
    )
    expect(() => parseGeniexHostArgs(['serve'])).toThrow(GeniexHostUsageError)
  })
})
