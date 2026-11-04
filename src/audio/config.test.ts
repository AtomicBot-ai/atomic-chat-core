import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { sampleAudioSpec } from '../../test/helpers/audio-fixtures.js'
import { buildServerConfig, resolveModelPath, taskForMode } from './config.js'

describe('taskForMode', () => {
  it.each([
    ['speech', 'tts'],
    ['music', 'gen'],
    ['effects', 'gen'],
  ] as const)('%s is served as %s', (mode, task) => {
    expect(taskForMode(mode)).toBe(task)
  })
})

describe('resolveModelPath', () => {
  it.each([
    [
      'a relative file under the models folder',
      'kokoro/k.gguf',
      '/d/audio/models',
      'darwin',
      '/d/audio/models/kokoro/k.gguf',
    ],
    ['an absolute file anywhere', '/elsewhere/k.gguf', '/d/audio/models', 'darwin', '/elsewhere/k.gguf'],
    ['an absolute path, normalised', '/elsewhere/../x/k.gguf', '/d/audio/models', 'linux', '/x/k.gguf'],
    [
      'a Windows relative file',
      'kokoro\\k.gguf',
      'C:\\d\\audio\\models',
      'win32',
      'C:\\d\\audio\\models\\kokoro\\k.gguf',
    ],
    ['a Windows absolute file', 'D:\\m\\k.gguf', 'C:\\d\\audio\\models', 'win32', 'D:\\m\\k.gguf'],
    [
      'a relative path that dips and comes back',
      'a/../b/k.gguf',
      '/d/audio/models',
      'darwin',
      '/d/audio/models/b/k.gguf',
    ],
  ] as const)('resolves %s', (_name, file, root, platform, expected) => {
    expect(resolveModelPath(file, root, platform)).toBe(expected)
  })

  it.each([
    ['../escape.gguf', '/d/audio/models', 'darwin'],
    ['a/../../escape.gguf', '/d/audio/models', 'linux'],
    ['..\\escape.gguf', 'C:\\d\\audio\\models', 'win32'],
    ['.', '/d/audio/models', 'darwin'],
    ['  ', '/d/audio/models', 'darwin'],
  ] as const)('refuses %j', (file, root, platform) => {
    expect(() => resolveModelPath(file, root, platform)).toThrow(AtomicCoreError)
    try {
      resolveModelPath(file, root, platform)
    } catch (error) {
      expect((error as AtomicCoreError).code).toBe('INVALID_REQUEST')
    }
  })
})

describe('buildServerConfig', () => {
  it('serves one model, loaded before listening, never unloaded or joined by the engine', () => {
    expect(buildServerConfig(sampleAudioSpec(), 3456)).toEqual({
      host: '127.0.0.1',
      port: 3456,
      backend: 'metal',
      lazy_load: false,
      max_loaded_models: 1,
      idle_unload_ms: 0,
      models: [
        {
          id: 'kokoro-82m:q8_0',
          family: 'kokoro_tts',
          path: '/data/audio/models/kokoro/kokoro-82m-q8_0.gguf',
          task: 'tts',
          mode: 'offline',
        },
      ],
    })
  })

  it('carries the options and the default voice when the load names them, and drops empty ones', () => {
    const config = buildServerConfig(
      sampleAudioSpec({
        backend: 'cpu',
        loadOptions: { 'kokoro.weights': 'f16' },
        sessionOptions: {},
        defaultRequestOptions: { speed: 1.1, return_timestamps: false },
        defaultVoice: 'af_heart',
      }),
      3001
    )
    expect(config.backend).toBe('cpu')
    expect(config.models[0]).toEqual({
      id: 'kokoro-82m:q8_0',
      family: 'kokoro_tts',
      path: '/data/audio/models/kokoro/kokoro-82m-q8_0.gguf',
      task: 'tts',
      mode: 'offline',
      load_options: { 'kokoro.weights': 'f16' },
      default_request_options: { speed: 1.1, return_timestamps: false },
      default_voice_preset: { voice_id: 'af_heart' },
    })
    expect(buildServerConfig(sampleAudioSpec({ defaultVoice: '' }), 1).models[0]).not.toHaveProperty(
      'default_voice_preset'
    )
  })
})
