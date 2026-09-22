import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOUDFLARED_BIN_ENV,
  cloudflaredArgs,
  cloudflaredFileName,
  resolveCloudflaredBinary,
  scrubTunnelEnv,
} from './cloudflared-args.js'

describe('cloudflaredArgs', () => {
  // The app's `the_command_line_pins_the_origin_and_disables_self_update`.
  it('pins the origin and disables self-update', () => {
    expect(cloudflaredArgs('http://127.0.0.1:1337')).toEqual([
      'tunnel',
      '--url',
      'http://127.0.0.1:1337',
      '--no-autoupdate',
    ])
    expect(cloudflaredArgs('http://127.0.0.1:1337', 'http2', '/dev/null')).toEqual([
      'tunnel',
      '--config',
      '/dev/null',
      '--url',
      'http://127.0.0.1:1337',
      '--no-autoupdate',
      '--protocol',
      'http2',
    ])
  })
})

describe('scrubTunnelEnv', () => {
  it('removes every TUNNEL_* variable, which cloudflared would read as flags, and keeps the rest', () => {
    expect(
      scrubTunnelEnv({
        PATH: '/usr/bin',
        HOME: '/home/u',
        TUNNEL_TOKEN: 'secret',
        TUNNEL_URL: 'http://elsewhere',
        TUNNEL_TRANSPORT_PROTOCOL: 'quic',
        tunnel_loglevel: 'debug',
        NOT_A_TUNNEL_VAR: 'kept',
        UNSET: undefined,
      })
    ).toEqual({ PATH: '/usr/bin', HOME: '/home/u', NOT_A_TUNNEL_VAR: 'kept' })
  })
})

describe('resolveCloudflaredBinary', () => {
  const bundled = join('/app/resources/bin', 'cloudflared')
  const everything = (path: string) => ['/named/cloudflared', '/env/cloudflared', bundled].includes(path)

  it.each([
    ['the path the app named', { explicit: '/named/cloudflared' }, '/named/cloudflared'],
    [
      'the environment when nothing was named',
      { env: { [CLOUDFLARED_BIN_ENV]: ' /env/cloudflared ' } },
      '/env/cloudflared',
    ],
    ['the resources folder last', {}, bundled],
  ])('prefers %s', (_what, given, expected) => {
    expect(
      resolveCloudflaredBinary({
        resourcesDir: '/app/resources/bin',
        platform: 'darwin',
        exists: everything,
        ...given,
      })
    ).toBe(expected)
  })

  it('names the .exe on Windows', () => {
    expect(cloudflaredFileName('win32')).toBe('cloudflared.exe')
    expect(cloudflaredFileName('linux')).toBe('cloudflared')
    const windows = join('C:\\app\\resources\\bin', 'cloudflared.exe')
    expect(
      resolveCloudflaredBinary({
        resourcesDir: 'C:\\app\\resources\\bin',
        platform: 'win32',
        exists: (path) => path === windows,
      })
    ).toBe(windows)
  })

  it('answers nothing when there is no binary, and does not replace a named one that is missing', () => {
    expect(resolveCloudflaredBinary({ platform: 'darwin', exists: () => true })).toBeUndefined()
    expect(
      resolveCloudflaredBinary({
        resourcesDir: '/app/resources/bin',
        platform: 'darwin',
        exists: () => false,
      })
    ).toBeUndefined()
    expect(
      resolveCloudflaredBinary({
        explicit: '/gone/cloudflared',
        resourcesDir: '/app/resources/bin',
        platform: 'darwin',
        exists: (path) => path === bundled,
      })
    ).toBeUndefined()
  })
})
