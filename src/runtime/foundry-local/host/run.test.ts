import { describe, expect, it } from 'vitest'
import { FoundryLibraryError } from './library.js'
import type { FoundryLibrary, FoundryManager, FoundryManagerConfig } from './library.js'
import { libraryDir, runFoundryHost } from './run.js'

/** A stand-in for the `bun:ffi` layer: what the host asked of the library, and canned answers. */
export function fakeLibrary(over: Partial<FoundryManager> = {}) {
  const calls: string[] = []
  const configs: FoundryManagerConfig[] = []
  const manager: FoundryManager = {
    discoverableEps: () => [
      { name: 'WebGpuExecutionProvider', registered: false },
      { name: 'CUDAExecutionProvider', registered: false },
    ],
    downloadAndRegisterEps: () => {},
    registerLocalModel: () => ({ load: () => {}, unload: () => {}, executionProvider: () => null }),
    webServiceStart: () => [],
    shutdown: () => void calls.push('shutdown'),
    release: () => void calls.push('release'),
    ...over,
  }
  const library: FoundryLibrary = {
    version: '2.1.0',
    cApiVersion: 2,
    createManager: (config) => {
      configs.push(config)
      return manager
    },
  }
  return { library, calls, configs }
}

const io = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    out,
    err,
    stdout: (line: string) => void out.push(line),
    stderr: (line: string) => void err.push(line),
  }
}
const COMMON = ['--lib', '/b/v2.1.0/linux-x64', '--app-data', '/d/runtime', '--logs', '/d/logs']

describe('runFoundryHost', () => {
  it('probe: opens the build, lists the accelerators with what core knows is prepared, and shuts the library down', async () => {
    const fake = fakeLibrary()
    const opened: string[] = []
    const out = io()
    const code = await runFoundryHost(['probe', ...COMMON, '--prepared', 'WebGpuExecutionProvider'], {
      ...out,
      loadLibrary: async (dir) => {
        opened.push(dir)
        return fake.library
      },
    })
    expect(code).toBe(0)
    expect(opened).toEqual(['/b/v2.1.0/linux-x64'])
    expect(JSON.parse(out.out[0] as string)).toEqual({
      c_api_version: 2,
      version: '2.1.0',
      accelerators: [
        { name: 'WebGpuExecutionProvider', execution_provider: 'webgpu', device: 'gpu', prepared: true },
        { name: 'CUDAExecutionProvider', execution_provider: 'cuda', device: 'gpu', prepared: false },
      ],
    })
    expect(fake.configs[0]).toMatchObject({
      appName: 'atomic-chat',
      appDataDir: '/d/runtime',
      logsDir: '/d/logs',
      webServiceEndpoints: [],
      additionalOptions: { DisableNonessentialTelemetry: 'true' },
    })
    expect(fake.calls).toEqual(['shutdown', 'release'])
  })

  it('exits 2 on a usage error, 3 when the library does not load, 4 when a call fails', async () => {
    const usage = io()
    expect(
      await runFoundryHost(['probe'], { ...usage, loadLibrary: async () => fakeLibrary().library })
    ).toBe(2)
    expect(usage.err[0]).toMatch(/--lib/)

    const missing = io()
    const noLib = async () => {
      throw new FoundryLibraryError('load', 0, 'libatomic.so.1: cannot open shared object file')
    }
    expect(await runFoundryHost(['probe', ...COMMON], { ...missing, loadLibrary: noLib })).toBe(3)
    expect(missing.err[0]).toMatch(/foundry_local does not load.*libatomic\.so\.1/)

    const failing = fakeLibrary({
      discoverableEps: () => {
        throw new FoundryLibraryError('Manager_GetDiscoverableEps', 2, 'internal')
      },
    })
    const broken = io()
    expect(
      await runFoundryHost(['probe', ...COMMON], { ...broken, loadLibrary: async () => failing.library })
    ).toBe(4)
    expect(broken.err[0]).toMatch(/Manager_GetDiscoverableEps/)
    expect(failing.calls).toEqual(['shutdown', 'release'])
  })
})

describe('libraryDir', () => {
  it('opens <build>/lib when the build has one, else the folder itself', () => {
    expect(libraryDir('/b', (path) => path === '/b/lib')).toBe('/b/lib')
    expect(libraryDir('/b', () => false)).toBe('/b')
  })
})
