import { describe, expect, it } from 'vitest'
import { AUDIO_BACKEND_ENV, audioChildEnv, buildAudioServerArgs, resolveAudioBackend } from './args.js'

describe('buildAudioServerArgs', () => {
  it.each([
    [
      'always the backend, no UI, the log and the load progress',
      ['/run/server.json', 3456, 'metal' as const, undefined],
      [
        '--config',
        '/run/server.json',
        '--no-ui',
        '--host',
        '127.0.0.1',
        '--port',
        '3456',
        '--backend',
        'metal',
        '--log',
        '--load-progress',
        '1',
      ],
    ],
    [
      'threads last when asked',
      ['/c.json', 3001, 'cpu' as const, 6],
      [
        '--config',
        '/c.json',
        '--no-ui',
        '--host',
        '127.0.0.1',
        '--port',
        '3001',
        '--backend',
        'cpu',
        '--log',
        '--load-progress',
        '1',
        '--threads',
        '6',
      ],
    ],
  ] as const)('%s', (_name, [file, port, backend, threads], expected) => {
    expect(buildAudioServerArgs(file, port, backend, threads)).toEqual(expected)
  })

  it('leaves out a thread count that is not positive', () => {
    expect(buildAudioServerArgs('/c.json', 1, 'cuda', 0)).not.toContain('--threads')
  })
})

describe('resolveAudioBackend', () => {
  it.each([
    ['metal', {}, 'metal'],
    ['vulkan', { [AUDIO_BACKEND_ENV]: 'cpu' }, 'cpu'],
    ['cuda', { [AUDIO_BACKEND_ENV]: ' CPU ' }, 'cpu'],
    ['cuda', { [AUDIO_BACKEND_ENV]: 'vulkan' }, 'cuda'],
  ] as const)('%s with %j runs on %s', (build, env, expected) => {
    expect(resolveAudioBackend(build, env)).toBe(expected)
  })
})

describe('audioChildEnv', () => {
  it('points every temporary-folder variable of the platform at the audio tmp folder', () => {
    expect(audioChildEnv('darwin', '/d/audio/tmp')).toEqual({ TMPDIR: '/d/audio/tmp' })
    expect(audioChildEnv('linux', '/d/audio/tmp')).toEqual({ TMPDIR: '/d/audio/tmp' })
    expect(audioChildEnv('win32', 'C:\\d\\audio\\tmp')).toEqual({
      TMPDIR: 'C:\\d\\audio\\tmp',
      TEMP: 'C:\\d\\audio\\tmp',
      TMP: 'C:\\d\\audio\\tmp',
    })
  })
})
