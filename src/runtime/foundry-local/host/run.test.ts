import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { FoundryLibraryError } from './library.js'
import type { FoundryLibrary, FoundryManager, FoundryManagerConfig } from './library.js'
import { failureReason, libraryDir, lineIo, logTailReader, runFoundryHost } from './run.js'

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
    expect(libraryDir('/b', (path) => path === join('/b', 'lib'))).toBe(join('/b', 'lib'))
    expect(libraryDir('/b', () => false)).toBe('/b')
  })
})

describe('runFoundryHost prepare', () => {
  /** A library whose CUDA download fails half way, as on a host without CUDA 12 (rulings S1, finding 11). */
  function partlyFailing() {
    const registered = new Set<string>()
    const asked: string[][] = []
    const fake = fakeLibrary({
      discoverableEps: () =>
        ['WebGpuExecutionProvider', 'CUDAExecutionProvider', 'OpenVINOExecutionProvider'].map((name) => ({
          name,
          registered: registered.has(name),
        })),
      downloadAndRegisterEps: (names, onProgress) => {
        asked.push(names)
        const [name] = names
        if (name === 'WebGpuExecutionProvider') {
          onProgress?.('WebGPU EP', 50)
          onProgress?.('WebGPU EP', 100)
          registered.add(name)
        }
        if (name === 'CUDAExecutionProvider') onProgress?.('CUDA EP', 30)
        // OpenVINO comes from Windows ML: registered, and no progress at all (rulings S2, finding 16).
        if (name === 'OpenVINOExecutionProvider') registered.add(name)
      },
    })
    return { ...fake, asked }
  }

  it('hands the progress callback only to CDN accelerators: Windows ML may call it from its own thread', async () => {
    // A Core Ultra laptop with an RTX: on a first install Windows ML reported OpenVINO's download from a
    // thread of its own, and Bun's plain callback, called off the JS thread, failed the prepare with
    // "onProgress is not defined". CUDA and WebGPU call back on the calling thread (rulings S2, finding 15).
    const offered = [
      'WebGpuExecutionProvider',
      'CUDAExecutionProvider',
      'OpenVINOExecutionProvider',
      'NvTensorRTRTXExecutionProvider',
      'QNNExecutionProvider',
    ]
    const given: Record<string, boolean> = {}
    const registered = new Set<string>()
    const fake = fakeLibrary({
      discoverableEps: () => offered.map((name) => ({ name, registered: registered.has(name) })),
      downloadAndRegisterEps: (names, onProgress) => {
        const name = names[0] ?? ''
        given[name] = onProgress !== undefined
        registered.add(name)
      },
    })
    const out = io()
    const code = await runFoundryHost(['prepare', ...COMMON], {
      ...out,
      loadLibrary: async () => fake.library,
      readLogTail: async () => '',
    })
    expect(code).toBe(0)
    expect(given).toEqual({
      WebGpuExecutionProvider: true,
      CUDAExecutionProvider: true,
      OpenVINOExecutionProvider: false,
      NvTensorRTRTXExecutionProvider: false,
      QNNExecutionProvider: false,
    })
    // Without a fraction a Windows ML accelerator still reports its start and its end.
    const lines = out.out.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines).toContainEqual({ accelerator: 'OpenVINOExecutionProvider', stage: 'started', fraction: 0 })
    expect(lines).toContainEqual({ accelerator: 'OpenVINOExecutionProvider', stage: 'done', fraction: 1 })
  })

  it('prepares one accelerator at a time, prints stage lines and a summary, and goes on after a failure', async () => {
    const fake = partlyFailing()
    const out = io()
    const code = await runFoundryHost(['prepare', ...COMMON], {
      ...out,
      loadLibrary: async () => fake.library,
      readLogTail: async () =>
        "[warning] EP: failed to load '.../libonnxruntime-genai-cuda.so' (libcublasLt.so.12: cannot open shared object file)\n" +
        '[warning] Failed to download or register EP(s) [CUDAExecutionProvider]; continuing',
    })
    expect(code).toBe(0)
    expect(fake.asked).toEqual([
      ['WebGpuExecutionProvider'],
      ['CUDAExecutionProvider'],
      ['OpenVINOExecutionProvider'],
    ])
    const lines = out.out.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(lines.slice(0, 4)).toEqual([
      { accelerator: 'WebGpuExecutionProvider', stage: 'started', fraction: 0 },
      { accelerator: 'WebGpuExecutionProvider', stage: 'downloading', fraction: 0.5 },
      { accelerator: 'WebGpuExecutionProvider', stage: 'downloading', fraction: 1 },
      { accelerator: 'WebGpuExecutionProvider', stage: 'done', fraction: 1 },
    ])
    expect(lines).toContainEqual({
      accelerator: 'CUDAExecutionProvider',
      stage: 'failed',
      fraction: null,
      reason: expect.stringContaining('libcublasLt.so.12'),
    })
    expect(lines).toContainEqual({ accelerator: 'OpenVINOExecutionProvider', stage: 'done', fraction: 1 })
    expect(lines.at(-1)).toEqual({
      done: true,
      accelerators: [
        { name: 'WebGpuExecutionProvider', prepared: true },
        {
          name: 'CUDAExecutionProvider',
          prepared: false,
          reason: expect.stringContaining('libcublasLt.so.12'),
        },
        { name: 'OpenVINOExecutionProvider', prepared: true },
      ],
    })
    expect(fake.calls).toEqual(['shutdown', 'release'])
  })

  it('prepares only the accelerators named, and refuses one this host does not offer without asking the library', async () => {
    const fake = partlyFailing()
    const out = io()
    expect(
      await runFoundryHost(['prepare', ...COMMON, 'QNNExecutionProvider', 'WebGpuExecutionProvider'], {
        ...out,
        loadLibrary: async () => fake.library,
        readLogTail: async () => '',
      })
    ).toBe(0)
    expect(fake.asked).toEqual([['WebGpuExecutionProvider']])
    expect(JSON.parse(out.out.at(-1) as string)).toEqual({
      done: true,
      accelerators: [
        {
          name: 'QNNExecutionProvider',
          prepared: false,
          reason: 'This computer does not offer QNNExecutionProvider.',
        },
        { name: 'WebGpuExecutionProvider', prepared: true },
      ],
    })
  })

  it('says why in general terms when the log names no cause, and survives a call that throws', async () => {
    const fake = fakeLibrary({
      discoverableEps: () => [{ name: 'CUDAExecutionProvider', registered: false }],
      downloadAndRegisterEps: () => {
        throw new FoundryLibraryError('Manager_DownloadAndRegisterEps', 5, 'EP download cancelled by user')
      },
    })
    const out = io()
    expect(
      await runFoundryHost(['prepare', ...COMMON], {
        ...out,
        loadLibrary: async () => fake.library,
        readLogTail: async () => '',
      })
    ).toBe(0)
    expect(JSON.parse(out.out.at(-1) as string)).toEqual({
      done: true,
      accelerators: [
        {
          name: 'CUDAExecutionProvider',
          prepared: false,
          reason: 'Manager_DownloadAndRegisterEps: EP download cancelled by user',
        },
      ],
    })
  })
})

describe('failureReason', () => {
  it('finds the cause the library logged, by the accelerator or its family, past the generic summary', () => {
    const linux = [
      "[2026-10-15 16:32:51.303] [warning] EP: failed to load '/x/cuda-ep/bin/libonnxruntime-genai-cuda.so' (libcublasLt.so.12: cannot open shared object file: No such file or directory)",
      '[2026-10-15 16:32:51.303] [warning] Failed to download or register EP(s) [CUDAExecutionProvider]; continuing',
    ].join('\n')
    expect(failureReason(linux, 'CUDAExecutionProvider')).toMatch(/^EP: failed to load .*libcublasLt\.so\.12/)
    const windows =
      '[2026-10-15 15:15:03.807] [warning] WinML EP OpenVINOExecutionProvider: EnsureReady failed (hr=0x80070005)'
    expect(failureReason(windows, 'OpenVINOExecutionProvider')).toBe(
      'WinML EP OpenVINOExecutionProvider: EnsureReady failed (hr=0x80070005)'
    )
    expect(failureReason(linux, 'WebGpuExecutionProvider')).toBeNull()
  })

  it('says what Windows blocked and what to do when app control refuses an unsigned library (4551)', () => {
    // A Core Ultra laptop with Smart App Control on: the whole CUDA bundle downloads, then Windows
    // refuses Microsoft's unsigned onnxruntime-genai-cuda.dll (ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION).
    const log = [
      "[2026-10-15 23:33:04.732] [warning] EP: failed to load 'C:\\Users\\msi_m\\AppData\\Roaming\\Atomic Chat\\data\\foundry-local\\runtime\\ep\\cuda-ep\\bundles\\cuda-ep-win-x64-cuda-12.8.4\\bin\\onnxruntime-genai-cuda.dll' (4551)",
      '[2026-10-15 23:33:04.732] [warning] Failed to download or register EP(s) [CUDAExecutionProvider]; continuing',
    ].join('\n')
    const reason = failureReason(log, 'CUDAExecutionProvider')
    expect(reason).toMatch(/^Windows blocked onnxruntime-genai-cuda\.dll/)
    expect(reason).toContain('Smart App Control')
    expect(reason).toContain('App & browser control')
    expect(reason).toContain('administrator')
    expect(reason).toContain('WebGPU')
    // Not the raw path and code the person cannot act on.
    expect(reason).not.toContain('(4551)')
  })
})

describe('logTailReader', () => {
  it('returns only what the log gained since the previous read', async () => {
    const { mkdtemp, appendFile, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'atomic-foundry-log-'))
    try {
      const file = join(dir, 'foundry_local_2026-10-15.log')
      await writeFile(file, 'old line\n')
      const read = logTailReader()
      expect(await read(dir)).toBe('')
      await appendFile(file, 'new line\n')
      expect(await read(dir)).toBe('new line\n')
      expect(await read(dir)).toBe('')
      await writeFile(join(dir, 'foundry_local_2026-10-16.log'), 'next day\n')
      expect(await read(dir)).toBe('next day\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runFoundryHost serve', () => {
  const SERVE = [
    'serve',
    ...COMMON,
    '--model',
    '/d/models/qwen3-0.6b-generic-gpu',
    '--ep',
    'webgpu',
    '--port',
    '41987',
    '--cache',
    '/d/tmp/s1',
    '--id',
    'atomic-qwen3-0.6b-generic-gpu:1',
  ]

  function serveLibrary(opts: { registers?: boolean; loadFails?: boolean } = {}) {
    const log: string[] = []
    const registered = new Set<string>()
    const fake = fakeLibrary({
      discoverableEps: () => [
        { name: 'WebGpuExecutionProvider', registered: registered.has('WebGpuExecutionProvider') },
      ],
      downloadAndRegisterEps: (names, onProgress) => {
        log.push(`register ${names.join(',')} progress=${String(onProgress !== undefined)}`)
        if (opts.registers !== false) for (const name of names) registered.add(name)
      },
      registerLocalModel: (path, id, metadata) => {
        log.push(`RegisterModel ${path} ${id} ${JSON.stringify(metadata)}`)
        return {
          load: () => {
            log.push('load')
            if (opts.loadFails) throw new FoundryLibraryError('Model_Load', 2, 'out of memory')
          },
          unload: () => void log.push('unload'),
          executionProvider: () => 'WebGPUExecutionProvider',
        }
      },
      webServiceStart: () => {
        log.push('WebServiceStart')
        return ['http://127.0.0.1:41987']
      },
    })
    return { ...fake, log }
  }

  it('registers the prepared accelerator, the model with explicit metadata, loads, serves on loopback and says so', async () => {
    const fake = serveLibrary()
    const out = io()
    const removed: string[] = []
    const disposed: string[] = []
    let stop: () => void = () => {}
    const running = runFoundryHost(
      [
        ...SERVE,
        '--tools',
        '--reasoning-start',
        '<think>',
        '--reasoning-end',
        '</think>',
        '--context-length',
        '40960',
      ],
      {
        ...out,
        loadLibrary: async () => fake.library,
        watchStop: () => ({
          stopped: new Promise<void>((resolve) => (stop = resolve)),
          dispose: () => void disposed.push('dispose'),
        }),
        removeDir: async (path) => void removed.push(path),
      }
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fake.configs[0]).toMatchObject({
      modelCacheDir: '/d/tmp/s1',
      webServiceEndpoints: ['http://127.0.0.1:41987'],
      additionalOptions: { DisableNonessentialTelemetry: 'true' },
    })
    expect(fake.log).toEqual([
      'register WebGpuExecutionProvider progress=false',
      `RegisterModel /d/models/qwen3-0.6b-generic-gpu atomic-qwen3-0.6b-generic-gpu:1 ${JSON.stringify({
        strings: {
          task: 'chat-completion',
          execution_provider: 'WebGPUExecutionProvider',
          reasoning_start: '<think>',
          reasoning_end: '</think>',
        },
        ints: { supports_tool_calling: 1, supports_reasoning: 1, context_length: 40960 },
      })}`,
      'load',
      'WebServiceStart',
    ])
    expect(JSON.parse(out.out[0] as string)).toEqual({
      ready: true,
      url: 'http://127.0.0.1:41987',
      base_path: '/catalogs/local',
      model_id: 'atomic-qwen3-0.6b-generic-gpu:1',
      execution_provider: 'WebGPUExecutionProvider',
    })
    expect(removed).toEqual([])
    stop()
    expect(await running).toBe(0)
    expect(fake.calls).toEqual(['shutdown', 'release'])
    expect(removed).toEqual(['/d/tmp/s1'])
    expect(disposed).toEqual(['dispose'])
  })

  it('registers no accelerator for a CPU variant and tells the library it has no tools or reasoning', async () => {
    const fake = serveLibrary()
    const out = io()
    expect(
      await runFoundryHost(
        SERVE.map((a) => (a === 'webgpu' ? 'cpu' : a)),
        {
          ...out,
          loadLibrary: async () => fake.library,
          watchStop: () => ({ stopped: Promise.resolve(), dispose: () => {} }),
          removeDir: async () => {},
        }
      )
    ).toBe(0)
    expect(fake.log[0]).toMatch(
      /"execution_provider":"CPUExecutionProvider".*"supports_tool_calling":0,"supports_reasoning":0/
    )
  })

  it('refuses to serve on an accelerator the library would not register, and cleans up', async () => {
    const fake = serveLibrary({ registers: false })
    const out = io()
    const removed: string[] = []
    expect(
      await runFoundryHost(SERVE, {
        ...out,
        loadLibrary: async () => fake.library,
        watchStop: () => ({ stopped: Promise.resolve(), dispose: () => {} }),
        removeDir: async (path) => void removed.push(path),
      })
    ).toBe(5)
    expect(out.err[0]).toMatch(/WebGpuExecutionProvider is not prepared/)
    expect(fake.log.some((line) => line.startsWith('RegisterModel'))).toBe(false)
    expect(fake.calls).toEqual(['shutdown', 'release'])
    expect(removed).toEqual(['/d/tmp/s1'])
  })

  it('exits 4 with the library error when the load fails, after shutting down and removing the cache', async () => {
    const fake = serveLibrary({ loadFails: true })
    const out = io()
    const removed: string[] = []
    expect(
      await runFoundryHost(SERVE, {
        ...out,
        loadLibrary: async () => fake.library,
        watchStop: () => ({ stopped: Promise.resolve(), dispose: () => {} }),
        removeDir: async (path) => void removed.push(path),
      })
    ).toBe(4)
    expect(out.err[0]).toBe('Model_Load: out of memory')
    expect(out.out).toEqual([])
    expect(fake.calls).toEqual(['shutdown', 'release'])
    expect(removed).toEqual(['/d/tmp/s1'])
  })
})

describe('lineIo', () => {
  it('ends every line it is given, on the stream it belongs to', () => {
    const out: string[] = []
    const err: string[] = []
    const lines = lineIo({ stdout: (t) => void out.push(t), stderr: (t) => void err.push(t) })
    lines.stdout('{"ready":true}')
    lines.stderr('boom')
    expect(out).toEqual(['{"ready":true}\n'])
    expect(err).toEqual(['boom\n'])
  })
})
