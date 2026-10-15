import { describe, expect, it } from 'vitest'
import { parseFoundryHostArgs } from './args.js'

const COMMON = [
  '--lib',
  '/b/v2.1.0/macos-arm64',
  '--app-data',
  '/d/foundry-local/runtime',
  '--logs',
  '/d/foundry-local/logs',
]

describe('parseFoundryHostArgs', () => {
  it('reads probe with the build, the library data and the logs, and the accelerators core knows are prepared', () => {
    expect(parseFoundryHostArgs(['probe', ...COMMON, '--prepared', 'WebGpuExecutionProvider'])).toEqual({
      mode: 'probe',
      lib: '/b/v2.1.0/macos-arm64',
      appData: '/d/foundry-local/runtime',
      logs: '/d/foundry-local/logs',
      prepared: ['WebGpuExecutionProvider'],
    })
  })

  it('reads prepare with the accelerators to prepare, none meaning all the library finds', () => {
    expect(
      parseFoundryHostArgs(['prepare', ...COMMON, 'CUDAExecutionProvider', 'WebGpuExecutionProvider'])
    ).toMatchObject({
      mode: 'prepare',
      accelerators: ['CUDAExecutionProvider', 'WebGpuExecutionProvider'],
    })
    expect(parseFoundryHostArgs(['prepare', ...COMMON])).toMatchObject({ mode: 'prepare', accelerators: [] })
  })

  it('reads serve with the model, its accelerator, the port, the cache and what the library is told about the model', () => {
    const args = parseFoundryHostArgs([
      'serve',
      ...COMMON,
      '--model',
      '/d/foundry-local/models/qwen3-0.6b-generic-gpu',
      '--ep',
      'webgpu',
      '--port',
      '41987',
      '--cache',
      '/d/foundry-local/tmp/s1',
      '--id',
      'atomic-qwen3-0.6b-generic-gpu:1',
      '--tools',
      '--reasoning-start',
      '<think>',
      '--reasoning-end',
      '</think>',
      '--context-length',
      '40960',
    ])
    expect(args).toEqual({
      mode: 'serve',
      lib: '/b/v2.1.0/macos-arm64',
      appData: '/d/foundry-local/runtime',
      logs: '/d/foundry-local/logs',
      model: '/d/foundry-local/models/qwen3-0.6b-generic-gpu',
      ep: 'webgpu',
      port: 41987,
      cache: '/d/foundry-local/tmp/s1',
      id: 'atomic-qwen3-0.6b-generic-gpu:1',
      tools: true,
      reasoningStart: '<think>',
      reasoningEnd: '</think>',
      contextLength: 40960,
    })
  })

  it('refuses an unknown mode, a missing directory, an unknown accelerator, a bad port and an id without a version', () => {
    const serve = [
      'serve',
      ...COMMON,
      '--model',
      '/m',
      '--ep',
      'cpu',
      '--port',
      '1',
      '--cache',
      '/c',
      '--id',
      'm:1',
    ]
    for (const argv of [
      [],
      ['load', ...COMMON],
      ['probe', '--lib', '/b'],
      ['probe', ...COMMON, '--bogus'],
      serve.map((a) => (a === 'cpu' ? 'tpu' : a)),
      serve.map((a) => (a === '1' ? '70000' : a)),
      serve.map((a) => (a === 'm:1' ? 'm' : a)),
      serve.filter((a) => a !== '--cache' && a !== '/c'),
      [
        'serve',
        ...COMMON,
        '--model',
        '/m',
        '--ep',
        'cpu',
        '--port',
        '1',
        '--cache',
        '/c',
        '--id',
        'm:1',
        '--context-length',
        'x',
      ],
    ])
      expect(() => parseFoundryHostArgs(argv), JSON.stringify(argv)).toThrow()
  })
})
