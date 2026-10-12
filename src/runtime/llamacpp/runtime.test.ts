import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  fakeLlamaSpawn,
  fakeLlamaSpawnRaw,
  FAKE_LLAMA_SCRIPT,
} from '../../../test/helpers/fake-llama-server.js'
import { scriptSpawn } from '../../../test/helpers/script-spawn.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { CoreEvents } from '../../contracts/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import { ProcessJournal } from '../../lock/index.js'
import { ModelRegistry } from '../../models/index.js'
import { hostPid, spawnManaged } from '../shared/index.js'
import type { GpuClaim, ManagedProcess } from '../shared/index.js'
import { LlamacppRuntime } from './runtime.js'
import type { LlamacppRuntimeOptions, RuntimeSettings } from './runtime.js'

/**
 * The tests here build a llama.cpp runtime, several of them with real (fake-engine) child processes. Under the
 * full suite's parallel load some crossed vitest's 5 s default and failed at random (final review
 * T-282), so the whole file gets an explicit, longer per-test timeout.
 */
vi.setConfig({ testTimeout: 20_000 })

let data: TmpDataFolder
let journal: ProcessJournal
let events: Array<{ name: string; payload: unknown }>
const runtimes: LlamacppRuntime[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-runtime-')
  journal = await ProcessJournal.open(data.layout)
  events = []
})
afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((r) => r.dispose()))
  await data.cleanup()
})

const settings = (): RuntimeSettings => ({
  config: {
    version_backend: 'b6325/macos-arm64',
    ctx_size: 2048,
    n_gpu_layers: 100,
    flash_attn: 'auto',
    cache_type_k: 'f16',
    cache_type_v: 'f16',
    chat_template: '',
    device: '',
    split_mode: 'layer',
    main_gpu: 0,
    threads: 0,
    threads_batch: 0,
    n_predict: 0,
    batch_size: 0,
    ubatch_size: 0,
    defrag_thold: 0.1,
    rope_scaling: 'none',
    rope_scale: 1,
    rope_freq_base: 0,
    rope_freq_scale: 1,
    ctx_shift: false,
    cont_batching: false,
    no_mmap: false,
    mlock: false,
    no_kv_offload: false,
    offload_mmproj: true,
    cpu_moe: false,
    n_cpu_moe: 0,
    override_tensor_buffer_t: '',
    fit: false,
    fit_ctx: '',
    fit_target: '',
    auto_unload: false,
    timeout: 600,
    llamacpp_env: '',
  },
  engine: { timeout: 600, llamacpp_env: '' },
})

async function makeRuntime(over: Partial<LlamacppRuntimeOptions> = {}): Promise<LlamacppRuntime> {
  const exePath = await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
  const runtime = new LlamacppRuntime({
    layout: data.layout,
    registry: new ModelRegistry(data.layout),
    instanceId: 'owner-under-test',
    journal,
    emit: (name, payload) => events.push({ name, payload }),
    readSettings: async () => settings(),
    ensureBackendReady: async (backend, version) => ({ backend, version, exePath }),
    spawn: fakeLlamaSpawn(),
    probeDevicesWith: fakeLlamaSpawnRaw(),
    ...over,
  })
  runtimes.push(runtime)
  return runtime
}

const payloads = (name: keyof CoreEvents) => events.filter((e) => e.name === name).map((e) => e.payload)

/** A backend that prints while it loads, says it is ready, and keeps printing afterwards. */
const PRINTS_BEFORE_AND_AFTER_READY = [
  "console.error('before-ready: loading weights')",
  "console.error('main: server is listening on http://127.0.0.1:1')",
  "setTimeout(() => console.log('after-ready: still running'), 30)",
  'setInterval(() => {}, 1000)',
].join('; ')

describe('load', () => {
  it('uses a no-op event sink when the embedding owner did not supply one', async () => {
    const runtime = await makeRuntime()
    const noEmitter = new LlamacppRuntime({
      layout: data.layout,
      registry: new ModelRegistry(data.layout),
      instanceId: 'without-events',
      readSettings: async () => settings(),
    })
    runtimes.push(noEmitter)

    expect(runtime.list()).toEqual([])
    expect(noEmitter.list()).toEqual([])
  })

  // The file's first real spawn pays the cold start: 3.5-5 s on the Windows runner under coverage.
  it(
    'starts a process, reports a usable session and journals it for the next owner',
    { timeout: 15_000 },
    async () => {
      await data.writeModel('demo')
      const runtime = await makeRuntime()
      const info = await runtime.load('demo')

      expect(info.model_id).toBe('demo')
      expect(info.pid).toBeGreaterThan(0)
      expect(info.port).toBeGreaterThanOrEqual(3000)
      expect(info.api_key).toMatch(/.+/)
      expect(info.is_embedding).toBe(false)

      const health = await fetch(`http://127.0.0.1:${info.port}/health`)
      expect(health.status).toBe(200)
      const models = await fetch(`http://127.0.0.1:${info.port}/v1/models`, {
        headers: { Authorization: `Bearer ${info.api_key}` },
      })
      expect(models.status).toBe(200)
      // `/v1/models` is public on the real server, like `/health`; `/props` is behind the key.
      const unauthorized = await fetch(`http://127.0.0.1:${info.port}/props`)
      expect(unauthorized.status).toBe(401)

      expect(runtime.getLoadedModels()).toEqual(['demo'])
      expect(runtime.findSession('demo')).toMatchObject({ pid: info.pid })
      expect(runtime.list()).toHaveLength(1)
      expect(journal.list()).toMatchObject([
        { instance_id: 'owner-under-test', pid: info.pid, model_id: 'demo', port: info.port },
      ])
      expect(journal.list()[0]?.process_start_id, 'identity is what makes cleanup safe').toBeTruthy()
      expect(payloads('session:started')).toMatchObject([{ model_id: 'demo', provider: 'llamacpp-upstream' }])
    }
  )

  it('records which device the backend actually used', async () => {
    await data.writeModel('gpu-model')
    const runtime = await makeRuntime({ spawn: fakeLlamaSpawn({ gpu: true }) })
    await runtime.load('gpu-model')
    const device = runtime.getRuntimeDeviceInfo('gpu-model')
    expect(device).toMatchObject({
      loaded_backends: ['CUDA', 'CPU'],
      primary_device: 'CUDA0',
      gpu_layers_offloaded: 33,
      total_layers: 33,
    })
    expect(payloads('backend:runtime-reported')).toMatchObject([{ modelId: 'gpu-model', mismatch: false }])
  })

  it('becomes ready through the health poll when the log line is late', async () => {
    await data.writeModel('slow')
    const runtime = await makeRuntime({ spawn: fakeLlamaSpawn({ delayMs: 400 }) })
    const info = await runtime.load('slow')
    expect(info.pid).toBeGreaterThan(0)
  })

  it('joins a load already in flight instead of starting a second process', async () => {
    await data.writeModel('once')
    const runtime = await makeRuntime()
    const [a, b] = await Promise.all([runtime.load('once'), runtime.load('once')])
    expect(a.pid).toBe(b.pid)
    expect(runtime.list()).toHaveLength(1)
    expect(await runtime.load('once')).toMatchObject({ pid: a.pid })
  })

  it('gives every session its own port', async () => {
    await data.writeModel('one')
    await data.writeModel('two')
    const runtime = await makeRuntime()
    const first = await runtime.load('one')
    const second = await runtime.load('two')
    expect(second.port).not.toBe(first.port)
  })

  it('surfaces a model that is not installed and a backend that cannot start', async () => {
    const runtime = await makeRuntime()
    await expect(runtime.load('missing')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
    await data.writeModel('present')
    const noBackend = await makeRuntime({ ensureBackendReady: undefined })
    await expect(noBackend.load('present')).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' })
  })

  it('relays verbose lines and appends process output to an explicitly opened log', async () => {
    await data.writeModel('logged')
    const logPath = join(data.layout.core.logsDir, 'serve.log')
    const runtime = await makeRuntime()
    await runtime.load('logged', { verbose: true, logPath })
    await waitFor(() => events.some((event) => event.name === 'core:log'))
    await waitFor(() => {
      try {
        return /server is listening|HTTP server listening/i.test(readFileSync(logPath, 'utf8'))
      } catch {
        return false
      }
    })
    const text = readFileSync(logPath, 'utf8')
    expect(text).toMatch(/server is listening|HTTP server listening/i)
    expect(payloads('core:log')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ level: 'debug', msg: expect.stringContaining('logged') }),
      ])
    )
  })

  it('writes the redacted start line to log before spawning, args including --override-tensor', async () => {
    await data.writeModel('override-tensor')
    const logged: Array<{ level: string; message: string }> = []
    const runtime = await makeRuntime({ log: (level, message) => logged.push({ level, message }) })
    await runtime.load('override-tensor', { overrides: { override_tensor_buffer_t: 'exps=CPU' } })

    const startLine = logged.find((entry) => entry.level === 'info')
    // The resolved executable is `llama-server.exe` on Windows.
    expect(startLine?.message).toMatch(
      /^starting llama-server(\.exe)? for llamacpp-upstream\/override-tensor: /
    )
    expect(startLine?.message).toContain('--override-tensor exps=CPU')
  })

  // The start line uses a platform-appropriate basename: a Windows-style exe path (backslashes,
  // drive letter) must still collapse to just the file name, even though this suite runs on
  // whatever OS is native to the CI runner — proves the fix does not regress to `node:path`'s
  // bare `basename`, which only splits on the host platform's own separator.
  it('reduces a Windows-style executable path to its basename in the start line', async () => {
    await data.writeModel('windows-exe')
    const logged: Array<{ level: string; message: string }> = []
    const runtime = await makeRuntime({ log: (level, message) => logged.push({ level, message }) })
    // On Windows the engine starts in its executable's folder, so there the path must be a real
    // folder (already drive-lettered and backslashed); elsewhere a made-up one does.
    const exePath =
      process.platform === 'win32'
        ? join(data.root, 'llama-server.exe')
        : 'C:\\Users\\me\\AppData\\Local\\atomic\\bin\\llama-server.exe'
    await runtime.load('windows-exe', { exePath })

    // Anchored: nothing of the folder may precede the file name. (The arguments after the colon
    // carry the model's own path, which on Windows has a drive letter and backslashes too.)
    const startLine = logged.find((entry) => entry.level === 'info')
    expect(startLine?.message).toMatch(/^starting llama-server\.exe for llamacpp-upstream\/windows-exe: /)
  })

  it('relays every line to backendOutput before and after readiness, in addition to logPath and verbose', async () => {
    await data.writeModel('backend-output')
    const logPath = join(data.layout.core.logsDir, 'backend-output.log')
    const received: Array<{ provider: string; model: string; stream: string; line: string }> = []
    const runtime = await makeRuntime({
      backendOutput: (line) => received.push(line),
      spawn: scriptSpawn(PRINTS_BEFORE_AND_AFTER_READY),
    })

    await runtime.load('backend-output', { verbose: true, logPath })
    await waitFor(() => received.length === 3)

    const tagged = { provider: 'llamacpp-upstream', model: 'backend-output' }
    expect(received).toEqual([
      { ...tagged, stream: 'stderr', line: 'before-ready: loading weights' },
      { ...tagged, stream: 'stderr', line: 'main: server is listening on http://127.0.0.1:1' },
      { ...tagged, stream: 'stdout', line: 'after-ready: still running' },
    ])
    // In addition to logPath and verbose, never instead of them: both get the late line too.
    await waitFor(() => readFileSync(logPath, 'utf8').includes('[stdout] after-ready: still running'))
    expect(readFileSync(logPath, 'utf8')).toContain('[stderr] before-ready: loading weights')
    expect(payloads('core:log')).toContainEqual({
      level: 'debug',
      msg: '[llamacpp-upstream/backend-output][stdout] after-ready: still running',
    })
  })

  it('keeps loading, serving and relaying when the backendOutput sink throws, and warns about it once', async () => {
    await data.writeModel('throwing-sink')
    const logPath = join(data.layout.core.logsDir, 'throwing-sink.log')
    const seen: string[] = []
    const logged: Array<{ level: string; message: string }> = []
    const runtime = await makeRuntime({
      backendOutput: ({ line }) => {
        seen.push(line)
        throw new Error('sink boom')
      },
      log: (level, message) => logged.push({ level, message }),
      spawn: scriptSpawn(PRINTS_BEFORE_AND_AFTER_READY),
    })

    await runtime.load('throwing-sink', { logPath })
    await waitFor(() => seen.length === 3)

    expect(seen).toEqual([
      'before-ready: loading weights',
      'main: server is listening on http://127.0.0.1:1',
      'after-ready: still running',
    ])
    expect(runtime.list().map((session) => session.model_id)).toEqual(['throwing-sink'])
    await waitFor(() => readFileSync(logPath, 'utf8').includes('[stdout] after-ready: still running'))
    // Three throws, one warning, and never the engine line itself.
    expect(logged.filter((entry) => entry.level === 'warn')).toEqual([
      {
        level: 'warn',
        message: 'backendOutput sink threw: sink boom; further sink errors for this session are ignored',
      },
    ])
    expect(logged.some((entry) => /before-ready|after-ready|listening/.test(entry.message))).toBe(false)
  })

  it('fails before spawning when the requested log cannot be opened', async () => {
    await data.writeModel('bad-log')
    const blocker = join(data.root, 'not-a-directory')
    await writeFile(blocker, 'file')
    let spawnCalled = false
    const runtime = await makeRuntime({
      spawn: async (spec, opts) => {
        spawnCalled = true
        return fakeLlamaSpawn()(spec, opts)
      },
    })
    await expect(runtime.load('bad-log', { logPath: join(blocker, 'serve.log') })).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
    expect(spawnCalled).toBe(false)
  })
})

describe('failure paths', () => {
  it('refuses a decision model before it unloads the chat model or spawns anything', async () => {
    await data.writeModel('demo')
    await data.writeModel('router', { model_path: 'llamacpp/models/router/laya.gguf' })
    const folder = join(data.root, 'decision', 'models', 'laya-multilingual')
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, 'rl_agent_config.json'), '{}')
    const folderYml = join(data.layout.provider('llamacpp-upstream').modelsDir, 'folder')
    await mkdir(folderYml, { recursive: true })
    await writeFile(
      join(folderYml, 'model.yml'),
      'model_path: decision/models/laya-multilingual\nname: folder\nsize_bytes: 1\n'
    )
    let spawned = 0
    const spawn = fakeLlamaSpawn()
    const runtime = await makeRuntime({
      readGgufMetadata: async (path) =>
        path.endsWith('laya.gguf') ? { 'general.architecture': 'laya' } : { 'general.architecture': 'llama' },
      spawn: (spec, opts) => {
        spawned++
        return spawn(spec, opts)
      },
    })
    await runtime.load('demo')

    for (const id of ['router', 'folder'])
      await expect(runtime.load(id, { overrides: { auto_unload: true } })).rejects.toMatchObject({
        code: 'DECISION_MODEL_NOT_CHAT',
      })
    expect(spawned).toBe(1)
    expect(runtime.getLoadedModels()).toEqual(['demo'])
  })

  it('asks the compatibility gate with the resolved path and sha256 before it unloads or spawns', async () => {
    await data.writeModel('demo')
    await data.writeModel('bonsai', {
      model_path: 'llamacpp/models/bonsai/b.gguf',
      model_sha256: 'f'.repeat(64),
    })
    const asked: unknown[] = []
    let spawned = 0
    const spawn = fakeLlamaSpawn()
    const runtime = await makeRuntime({
      checkCompatibility: async (target) => {
        asked.push(target)
        if (target.modelId === 'bonsai')
          throw new AtomicCoreError('MODEL_ENGINE_INCOMPATIBLE', 'needs PrismML')
      },
      spawn: (spec, opts) => {
        spawned++
        return spawn(spec, opts)
      },
    })
    await runtime.load('demo')
    await expect(runtime.load('bonsai', { overrides: { auto_unload: true } })).rejects.toMatchObject({
      code: 'MODEL_ENGINE_INCOMPATIBLE',
    })
    expect(spawned).toBe(1)
    expect(runtime.getLoadedModels()).toEqual(['demo'])
    expect(asked[1]).toEqual({
      modelId: 'bonsai',
      modelPath: join(data.root, 'llamacpp', 'models', 'bonsai', 'b.gguf'),
      sha256: 'f'.repeat(64),
    })
  })

  it('classifies an out-of-memory crash and leaves no session or journal entry behind', async () => {
    await data.writeModel('oom')
    const runtime = await makeRuntime({ spawn: fakeLlamaSpawn({ mode: 'oom' }) })
    await expect(runtime.load('oom')).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' })
    expect(runtime.list()).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('delivers every line printed before an early exit to backendOutput, tagged with the runtime provider', async () => {
    await data.writeModel('oom-output')
    const received: Array<{ provider: string; model: string; stream: string; line: string }> = []
    const runtime = await makeRuntime({
      provider: 'llamacpp',
      backendOutput: (line) => received.push(line),
      spawn: fakeLlamaSpawn({ mode: 'oom' }),
    })
    await expect(runtime.load('oom-output')).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' })

    const tagged = { provider: 'llamacpp', model: 'oom-output', stream: 'stderr' }
    expect(received).toEqual([
      { ...tagged, line: expect.stringMatching(/^build: /) },
      { ...tagged, line: expect.stringMatching(/^llama_model_loader: loaded meta data/) },
      { ...tagged, line: expect.stringContaining('failed to allocate 4096.00 MiB') },
      { ...tagged, line: expect.stringContaining('error loading model') },
    ])
  })

  // `ps` only ever shows a process that is still alive, so the argv of a backend that failed to
  // load is unreadable from outside. The fake records its own, which is what the app's desktop
  // suite reads to prove a setting reached the process it was meant for.
  it('records the argv and inference environment of a backend that died', async () => {
    await data.writeModel('oom')
    const argvFile = join(data.root, 'spawned-argv.jsonl')
    const runtime = await makeRuntime({
      spawn: fakeLlamaSpawn({ mode: 'oom', argvFile, label: 'llamacpp-upstream:b6325/macos-arm64' }),
    })

    await expect(runtime.load('oom')).rejects.toMatchObject({ code: 'OUT_OF_MEMORY' })

    const records = readFileSync(argvFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { label: string; argv: string[]; env: Record<string, string> })
    expect(records).toHaveLength(1)
    const [record] = records as [(typeof records)[number]]
    expect(record.label).toBe('llamacpp-upstream:b6325/macos-arm64')
    expect(record.argv).toContain('-m')
    expect(record.env['LLAMA_API_KEY']).toMatch(/\S/)
  })

  // TurboQuant's `error.rs` (app commit ec1fd3ea7): the fork reads a tensor-count mismatch as an
  // unsupported layout, upstream as a damaged file; the runtime classifies with its own provider.
  it('classifies a tensor-count mismatch by the provider that loaded it', async () => {
    await data.writeModel('layout')
    const upstream = await makeRuntime({ spawn: fakeLlamaSpawn({ mode: 'tensor-count' }) })
    await expect(upstream.load('layout')).rejects.toMatchObject({ code: 'MODEL_FILE_CORRUPT' })
    const turboquant = await makeRuntime({
      provider: 'llamacpp',
      spawn: fakeLlamaSpawn({ mode: 'tensor-count' }),
    })
    await expect(turboquant.load('layout')).rejects.toMatchObject({ code: 'MODEL_ARCH_NOT_SUPPORTED' })
  })

  it('times out when the backend never becomes ready', async () => {
    await data.writeModel('stuck')
    // The production readiness floor is 30 minutes (`modelLoadReadyTimeoutSecs`), so the wait itself
    // is shortened here; what is under test is how the runtime reports a backend that never arrives.
    const runtime = await makeRuntime({
      spawn: (spec, opts) => fakeLlamaSpawn({ mode: 'no-ready' })(spec, { ...opts, timeoutMs: 400 }),
    })
    await expect(runtime.load('stuck')).rejects.toMatchObject({ code: 'MODEL_LOAD_TIMED_OUT' })
    expect(runtime.list()).toEqual([])
    expect(journal.list()).toEqual([])
  })

  it('retries without the projector when the projector is what failed', async () => {
    await data.writeModel('vision', { mmproj_path: 'llamacpp/models/vision/model.gguf' })
    let attempt = 0
    const runtime = await makeRuntime({
      spawn: (spec, opts) => {
        attempt++
        return fakeLlamaSpawn({ mode: attempt === 1 ? 'projector-fail' : 'ready' })(spec, opts)
      },
    })
    const info = await runtime.load('vision')
    expect(attempt).toBe(2)
    expect(info.mmproj_path ?? null).toBeNull()
  })

  it('reports a session that dies after it was ready, and forgets it', async () => {
    await data.writeModel('dies')
    const runtime = await makeRuntime()
    const info = await runtime.load('dies')
    process.kill(hostPid(info), 'SIGKILL')
    await waitFor(() => events.some((e) => e.name === 'session:died'))
    expect(runtime.list()).toEqual([])
    expect(runtime.findSession('dies')).toBeUndefined()
    expect(journal.list()).toEqual([])
    expect(payloads('session:died')).toMatchObject([{ model_id: 'dies', provider: 'llamacpp-upstream' }])
  })

  it('terminates a ready process when writing its journal entry fails', async () => {
    await data.writeModel('journal-fails')
    let spawned: Awaited<ReturnType<ReturnType<typeof fakeLlamaSpawn>>>['process'] | undefined
    const baseSpawn = fakeLlamaSpawn()
    const brokenJournal = Object.create(journal) as ProcessJournal
    brokenJournal.add = async () => {
      throw new Error('disk is read-only')
    }
    const runtime = await makeRuntime({
      journal: brokenJournal,
      spawn: async (spec, opts) => {
        const result = await baseSpawn(spec, opts)
        spawned = result.process
        return result
      },
    })
    await expect(runtime.load('journal-fails')).rejects.toThrow(/disk is read-only/)
    expect(runtime.list()).toEqual([])
    if (!spawned) throw new Error('expected a spawned process')
    await waitFor(() => !isAlive((spawned as { pid: number }).pid))
  })

  it('can apply the projector fallback and then the MTP fallback in one load', async () => {
    const modelDir = await data.writeModel('both', {
      mmproj_path: 'llamacpp/models/both/mmproj.gguf',
      mtp_draft_path: 'llamacpp/models/both/mtp.gguf',
    })
    await Promise.all([
      writeFile(join(modelDir, 'mmproj.gguf'), Buffer.alloc(16, 0x47)),
      writeFile(join(modelDir, 'mtp.gguf'), Buffer.alloc(16, 0x47)),
    ])
    let attempt = 0
    const runtime = await makeRuntime({
      readSettings: async () => ({
        ...settings(),
        config: { ...settings().config, mtp: true },
      }),
      spawn: (spec, opts) => {
        attempt++
        const mode = attempt === 1 ? 'projector-fail' : attempt === 2 ? 'mtp-fail' : 'ready'
        return fakeLlamaSpawn({ mode })(spec, opts)
      },
    })
    const info = await runtime.load('both')
    expect(attempt).toBe(3)
    expect(info.mmproj_path).toBeNull()
  })
})

describe('unload', () => {
  it('stops the process, clears the journal and is a no-op for an unloaded model', async () => {
    await data.writeModel('demo')
    const runtime = await makeRuntime()
    const info = await runtime.load('demo')
    expect(await runtime.unload('demo')).toEqual({ success: true })
    expect(runtime.list()).toEqual([])
    expect(journal.list()).toEqual([])
    await waitFor(() => !isAlive(hostPid(info)))
    expect(isAlive(hostPid(info))).toBe(false)
    expect(payloads('session:unloaded')).toMatchObject([{ model_id: 'demo', pid: info.pid }])
    expect(await runtime.unload('demo')).toEqual({ success: true })
  })

  it('unloadAll stops every session', async () => {
    await data.writeModel('a')
    await data.writeModel('b')
    const runtime = await makeRuntime()
    const [first, second] = [await runtime.load('a'), await runtime.load('b')]
    await runtime.unloadAll()
    expect(runtime.list()).toEqual([])
    await waitFor(() => !isAlive(hostPid(first)) && !isAlive(hostPid(second)))
  })

  it('auto-unloads another text model before starting the next one', async () => {
    await data.writeModel('first')
    await data.writeModel('second')
    const runtime = await makeRuntime({
      readSettings: async () => ({
        ...settings(),
        config: { ...settings().config, auto_unload: true },
      }),
    })
    const first = await runtime.load('first')
    const second = await runtime.load('second')
    expect(runtime.getLoadedModels()).toEqual(['second'])
    await waitFor(() => !isAlive(hostPid(first)))
    expect(isAlive(hostPid(second))).toBe(true)
  })

  it('honours a per-load auto_unload override', async () => {
    await data.writeModel('first')
    await data.writeModel('second')
    const runtime = await makeRuntime({
      readSettings: async () => ({
        ...settings(),
        config: { ...settings().config, auto_unload: true },
      }),
    })
    await runtime.load('first')
    await runtime.load('second', { overrides: { auto_unload: false } })
    expect(runtime.getLoadedModels()).toEqual(['first', 'second'])
  })

  it('asks core for every GPU before spawning, with the load signal, and reports the session it started', async () => {
    await data.writeModel('chat')
    const order: string[] = []
    const claims: Array<{ claim: GpuClaim; signal: AbortSignal | undefined }> = []
    const baseSpawn = fakeLlamaSpawn()
    const runtime = await makeRuntime({
      claimGpu: async (claim, signal) => {
        order.push('claim')
        claims.push({ claim, signal })
        // Not an occupant yet while its claim is pending: nothing has been started.
        expect(runtime.gpuOccupancy()).toEqual([])
      },
      spawn: async (spec, opts) => {
        order.push('spawn')
        expect(runtime.gpuOccupancy()).toEqual([
          { model_id: 'chat', cards: 'all', auxiliary: false, state: 'loading' },
        ])
        return baseSpawn(spec, opts)
      },
    })
    const controller = new AbortController()
    await runtime.load('chat', { signal: controller.signal })
    expect(order).toEqual(['claim', 'spawn'])
    expect(claims).toEqual([
      { claim: { model_id: 'chat', cards: 'all', auxiliary: false }, signal: controller.signal },
    ])
    expect(runtime.gpuOccupancy()).toEqual([
      { model_id: 'chat', cards: 'all', auxiliary: false, state: 'ready' },
    ])
  })

  it('keeps a session it is stopping on the GPU as stopping until its process has exited, and a second unload waits for that exit', async () => {
    await data.writeModel('chat')
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const baseSpawn = fakeLlamaSpawn()
    const runtime = await makeRuntime({
      spawn: async (spec, opts) => {
        const started = await baseSpawn(spec, opts)
        const terminate = started.process.terminate
        started.process.terminate = async (graceMs) => {
          await gate
          return terminate(graceMs)
        }
        return started
      },
    })
    const info = await runtime.load('chat')
    const first = runtime.unload('chat')
    await new Promise((resolve) => setImmediate(resolve))
    expect(runtime.gpuOccupancy()).toEqual([
      { model_id: 'chat', cards: 'all', auxiliary: false, state: 'stopping' },
    ])
    let joined = false
    const second = runtime.unload('chat').then((result) => {
      joined = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(joined).toBe(false)
    expect(isAlive(hostPid(info))).toBe(true)

    release()
    expect(await first).toEqual({ success: true })
    expect(await second).toEqual({ success: true })
    expect(isAlive(hostPid(info))).toBe(false)
    expect(runtime.gpuOccupancy()).toEqual([])
  })

  it('a stop whose cleanup itself throws answers the caller, and leaves no unhandled rejection behind (final review M-8)', async () => {
    await data.writeModel('chat')
    const baseSpawn = fakeLlamaSpawn()
    let restore: (() => Promise<void>) | undefined
    const runtime = await makeRuntime({
      spawn: async (spec, opts) => {
        const started = await baseSpawn(spec, opts)
        const { terminate } = started.process
        const child = started.process.child
        restore = async () => {
          Object.defineProperty(started.process, 'child', { value: child, configurable: true })
          await terminate(0)
        }
        started.process.terminate = async () => {
          // The stop fails, and so does reading whether the process is still there.
          Object.defineProperty(started.process, 'child', {
            configurable: true,
            get: () => {
              throw new Error('child handle gone')
            },
          })
          throw new Error('terminate failed')
        }
        return started
      },
    })
    await runtime.load('chat')
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(runtime.unload('chat')).rejects.toThrow('child handle gone')
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      await restore?.()
    }
  })

  it('starts nothing when core refuses the GPU, and holds nothing afterwards', async () => {
    await data.writeModel('chat')
    let spawned = false
    const runtime = await makeRuntime({
      claimGpu: async () => {
        throw new AtomicCoreError('GPU_BUSY', 'busy', 'holder=tensorrt-llm/x')
      },
      spawn: async () => {
        spawned = true
        throw new Error('must not spawn')
      },
    })
    const error = (await runtime.load('chat').catch((e: unknown) => e)) as AtomicCoreError
    expect(error.code).toBe('GPU_BUSY')
    expect(spawned).toBe(false)
    expect(runtime.gpuOccupancy()).toEqual([])
  })

  it('reports a CPU build as holding no GPU, and embeddings and the transcription companion as auxiliary', async () => {
    await data.writeModel('cpu-chat')
    await data.writeModel('emb')
    await data.writeModel('voice')
    const claims: GpuClaim[] = []
    const cpuExe = await data.writeBackend('llamacpp-upstream', 'b6325', 'linux-cpu-x64')
    const runtime = await makeRuntime({
      claimGpu: async (claim) => void claims.push(claim),
      transcriptionModelId: 'voice',
    })
    await runtime.load('emb', { isEmbedding: true })
    await runtime.load('voice')
    const cpu = await makeRuntime({
      claimGpu: async (claim) => void claims.push(claim),
      readSettings: async () => ({
        ...settings(),
        config: { ...settings().config, version_backend: 'b6325/linux-cpu-x64' },
      }),
      ensureBackendReady: async (backend, version) => ({ backend, version, exePath: cpuExe }),
    })
    await cpu.load('cpu-chat')
    expect(claims).toEqual([
      { model_id: 'emb', cards: 'all', auxiliary: true },
      { model_id: 'voice', cards: 'all', auxiliary: true },
      { model_id: 'cpu-chat', cards: [], auxiliary: false },
    ])
    expect(runtime.gpuOccupancy()).toEqual([
      { model_id: 'emb', cards: 'all', auxiliary: true, state: 'ready' },
      { model_id: 'voice', cards: 'all', auxiliary: true, state: 'ready' },
    ])
    expect(cpu.gpuOccupancy()).toEqual([
      { model_id: 'cpu-chat', cards: [], auxiliary: false, state: 'ready' },
    ])
  })

  it('keeps a live session registered when terminating it fails', async () => {
    await data.writeModel('stubborn')
    const baseSpawn = fakeLlamaSpawn()
    let rejectTerminate = true
    const runtime = await makeRuntime({
      spawn: async (spec, opts) => {
        const result = await baseSpawn(spec, opts)
        const terminate = result.process.terminate
        result.process.terminate = (graceMs) =>
          rejectTerminate ? Promise.reject(new Error('process would not stop')) : terminate(graceMs)
        return result
      },
    })
    const info = await runtime.load('stubborn')

    await expect(runtime.unload('stubborn')).resolves.toEqual({
      success: false,
      error: 'process would not stop',
    })
    expect(runtime.findSession('stubborn')).toMatchObject({ pid: info.pid })
    expect(journal.list()).toHaveLength(1)

    rejectTerminate = false
    await expect(runtime.unload('stubborn')).resolves.toEqual({ success: true })
  })
})

describe('cancelling a load', () => {
  const pidsIn = (file: string): number[] => {
    try {
      return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number)
    } catch {
      return []
    }
  }

  it('kills the child that is starting, leaves nothing behind and never retries', async () => {
    await data.writeModel('huge', { mmproj_path: 'llamacpp/models/huge/model.gguf' })
    const pidFile = join(data.root, 'pids')
    let attempts = 0
    const runtime = await makeRuntime({
      spawn: (spec, opts) => {
        attempts++
        return fakeLlamaSpawn({ mode: 'hang', pidFile })(spec, opts)
      },
    })
    const cancel = new AbortController()
    const load = runtime.load('huge', { signal: cancel.signal })
    await waitFor(() => pidsIn(pidFile).length === 1)
    const [pid] = pidsIn(pidFile) as [number]
    expect(runtime.isLoading('huge')).toBe(true)

    cancel.abort()
    await expect(load).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
      message: 'The model load was cancelled.',
    })
    // The error is raised only once the child is gone, so there is nothing to wait for here.
    expect(isAlive(pid)).toBe(false)
    expect(runtime.list()).toEqual([])
    expect(runtime.isLoading('huge')).toBe(false)
    expect(journal.list()).toEqual([])
    expect(payloads('session:started')).toEqual([])
    // A projector was configured, and a failed spawn normally retries without it. Not a cancel.
    expect(attempts).toBe(1)
  })

  it('never spawns for a load cancelled while it waits its turn, and keeps loads one at a time', async () => {
    await data.writeModel('first')
    await data.writeModel('queued')
    await data.writeModel('third')
    const pidFile = join(data.root, 'pids')
    const started: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
    const runtime = await makeRuntime({
      spawn: async (spec, opts) => {
        const alias = spec.args[spec.args.indexOf('-a') + 1] ?? spec.args.join(' ')
        started.push(alias)
        if (started.length === 1) await firstGate
        return fakeLlamaSpawn({ pidFile })(spec, opts)
      },
    })
    const first = runtime.load('first')
    const cancel = new AbortController()
    const queued = runtime.load('queued', { signal: cancel.signal })
    const third = runtime.load('third')
    await waitFor(() => started.length === 1)

    cancel.abort()
    await expect(queued).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(runtime.isLoading('queued')).toBe(false)
    // The cancelled load settled early; the one behind it must still wait for the load ahead.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(started).toHaveLength(1)

    releaseFirst()
    await first
    await third
    expect(started).toHaveLength(2)
    expect(runtime.getLoadedModels().sort()).toEqual(['first', 'third'])
    expect(pidsIn(pidFile)).toHaveLength(2)
  })

  it('lets a cancel that raced the ready signal win: the process is killed and no session is published', async () => {
    await data.writeModel('raced')
    const cancel = new AbortController()
    let spawnedPid = 0
    const runtime = await makeRuntime({
      spawn: async (spec, opts) => {
        const ready = await fakeLlamaSpawn()(spec, opts)
        spawnedPid = ready.process.pid
        // The server is up; the cancel lands before the runtime has published anything.
        cancel.abort()
        return ready
      },
    })
    await expect(runtime.load('raced', { signal: cancel.signal })).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    expect(spawnedPid).toBeGreaterThan(0)
    await waitFor(() => !isAlive(spawnedPid))
    expect(runtime.list()).toEqual([])
    expect(journal.list()).toEqual([])
    expect(payloads('session:started')).toEqual([])
  })

  it('does not wait for a backend install or a draft download the plan is blocked on', async () => {
    await data.writeModel('waiting')
    const runtime = await makeRuntime({ ensureBackendReady: () => new Promise(() => {}) })
    const cancel = new AbortController()
    const load = runtime.load('waiting', { signal: cancel.signal })
    await new Promise((resolve) => setTimeout(resolve, 30))
    cancel.abort()
    await expect(load).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect(runtime.isLoading('waiting')).toBe(false)
  })

  it('rejects a caller that joined a load when it cancels, while the load it joined finishes', async () => {
    await data.writeModel('shared')
    const runtime = await makeRuntime({ spawn: fakeLlamaSpawn({ delayMs: 150 }) })
    const owner = runtime.load('shared')
    const cancel = new AbortController()
    const joiner = runtime.load('shared', { signal: cancel.signal })
    cancel.abort()
    await expect(joiner).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    expect((await owner).model_id).toBe('shared')
    expect(runtime.getLoadedModels()).toEqual(['shared'])
  })

  it('refuses an already cancelled load before it reads settings or touches another model', async () => {
    await data.writeModel('resident')
    await data.writeModel('never')
    let settingsReads = 0
    const runtime = await makeRuntime({
      readSettings: async () => {
        settingsReads++
        return { ...settings(), config: { ...settings().config, auto_unload: true } }
      },
    })
    await runtime.load('resident')
    const readsAfterFirst = settingsReads
    await expect(runtime.load('never', { signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'MODEL_LOAD_CANCELLED',
    })
    expect(settingsReads).toBe(readsAfterFirst)
    // Auto-unload is on; a cancelled load must not have evicted the model that was there.
    expect(runtime.getLoadedModels()).toEqual(['resident'])
  })
})

describe('shutdown', () => {
  it('waits for an in-flight load, kills the child, and rejects the late publication', async () => {
    await data.writeModel('slow')
    let spawned: ManagedProcess | undefined
    const runtime = await makeRuntime({
      spawn: (_spec, opts) => {
        spawned = spawnManaged({
          exe: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          env: { ...process.env } as Record<string, string>,
        })
        return new Promise((_resolve, reject) => {
          opts.signal?.addEventListener(
            'abort',
            () => {
              void spawned
                ?.terminate(200)
                .then(() => reject(new AtomicCoreError('CORE_NOT_RUNNING', 'runtime stopping')))
            },
            { once: true }
          )
        })
      },
    })
    const load = runtime.load('slow')
    await new Promise((resolve) => setTimeout(resolve, 30))
    const shutdown = runtime.shutdown()
    await expect(load).rejects.toBeInstanceOf(AtomicCoreError)
    await shutdown
    expect(runtime.list()).toEqual([])
    if (!spawned) throw new Error('expected a spawned process')
    await waitFor(() => !isAlive((spawned as ManagedProcess).pid))
    await expect(runtime.load('late')).rejects.toMatchObject({ code: 'CORE_NOT_RUNNING' })
  })
})

describe('getDevices', () => {
  it('parses the device list of an installed backend', async () => {
    const runtime = await makeRuntime()
    const devices = await runtime.getDevices(FAKE_LLAMA_SCRIPT)
    expect(devices).toEqual([
      { id: 'CUDA0', name: 'NVIDIA GeForce RTX 4090', mem: 24_564, free: 23_875 },
      { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 4090', mem: 24_564, free: 23_875 },
    ])
  })

  it('reports a backend that cannot be executed', async () => {
    const runtime = await makeRuntime({ probeDevicesWith: undefined })
    await expect(runtime.getDevices('/definitely/missing/llama-server')).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
  })
})

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('recreateSession', () => {
  it('restarts a poisoned engine at the context it already had', async () => {
    await data.writeModel('demo')
    const runtime = await makeRuntime()
    const before = await runtime.load('demo')

    const result = await runtime.recreateSession('demo')

    expect(result.ok && result.session.pid).not.toBe(before.pid)
    expect(runtime.getCtxSize('demo')).toBe(2048)
    // Recovery is not a context change; the UI must not be told the window grew.
    expect(payloads('session:ctx-increased')).toEqual([])
  })

  it('declines for a model that is not loaded', async () => {
    const runtime = await makeRuntime()

    expect(await runtime.recreateSession('nothing')).toEqual({ ok: false, reason: 'not-loaded' })
  })

  it('logs an unload that fails and does not let it stop the recovery', async () => {
    await data.writeModel('stubborn')
    const baseSpawn = fakeLlamaSpawn()
    const runtime = await makeRuntime({
      spawn: async (spec, opts) => {
        const result = await baseSpawn(spec, opts)
        const terminate = result.process.terminate
        let refusals = 1
        result.process.terminate = (graceMs) =>
          refusals-- > 0 ? Promise.reject(new Error('process would not stop')) : terminate(graceMs)
        return result
      },
    })
    await runtime.load('stubborn')

    expect(await runtime.recreateSession('stubborn')).toMatchObject({ ok: true })
    expect(payloads('core:log')).toContainEqual({
      level: 'warn',
      msg: 'compute_error_recovery: unload of stubborn failed, reloading anyway: process would not stop',
    })
  })
})

describe('autoIncreaseCtx', () => {
  it('reloads the model one step up the ladder and reports the move', async () => {
    await data.writeModel('demo')
    const runtime = await makeRuntime()
    const before = await runtime.load('demo')

    const result = await runtime.autoIncreaseCtx('demo', 'proxy-overflow')

    expect(result).toMatchObject({ ok: true, new_ctx_len: 8192 })
    expect(runtime.getCtxSize('demo')).toBe(8192)
    expect(runtime.findSession('demo')?.pid).not.toBe(before.pid)
    expect(payloads('session:ctx-increased')).toEqual([
      {
        provider: 'llamacpp-upstream',
        modelId: 'demo',
        oldCtx: 2048,
        newCtx: 8192,
        reason: 'proxy-overflow',
      },
    ])
  })

  it('publishes the new port through session:started, which is what a mirror follows', async () => {
    await data.writeModel('demo')
    const runtime = await makeRuntime()
    await runtime.load('demo')

    const result = await runtime.autoIncreaseCtx('demo')

    const started = payloads('session:started') as Array<{ port: number }>
    expect(started).toHaveLength(2)
    expect(result.ok && result.session.port).toBe(started[1]?.port)
  })

  it('declines for a model that is not loaded', async () => {
    const runtime = await makeRuntime()

    expect(await runtime.autoIncreaseCtx('nothing')).toEqual({ ok: false, reason: 'not-loaded' })
  })

  it('declines when fit is on, because the engine sizes the window itself', async () => {
    // Under fit, `--ctx-size` is not even emitted, so the reload would cost a model load and change
    // nothing at all.
    await data.writeModel('demo')
    const runtime = await makeRuntime({
      readSettings: async () => {
        const s = settings()
        return { ...s, config: { ...s.config, fit: true } }
      },
    })
    await runtime.load('demo')

    expect(await runtime.autoIncreaseCtx('demo')).toEqual({ ok: false, reason: 'fit' })
    expect(payloads('session:ctx-increased')).toEqual([])
  })

  it('declines once the ladder reaches what the model was trained for', async () => {
    // A 8192-context model already loaded at 8192: the ladder caps at the trained context, so the
    // next step is the size it is already running. Reloading would loop — the next request would
    // overflow again and ask again.
    await data.writeModel('small')
    const runtime = await makeRuntime({
      readGgufMetadata: async () => ({ 'general.architecture': 'llama', 'llama.context_length': '8192' }),
      readSettings: async () => {
        const s = settings()
        return { ...s, config: { ...s.config, ctx_size: 8192 } }
      },
    })
    await runtime.load('small')
    expect(runtime.getCtxSize('small')).toBe(8192)
    const pidBefore = runtime.findSession('small')?.pid

    const result = await runtime.autoIncreaseCtx('small')

    expect(result).toEqual({ ok: false, reason: 'at_max', current_ctx_len: 8192, max_ctx_len: 8192 })
    expect(runtime.findSession('small')?.pid, 'nothing was reloaded').toBe(pidBefore)
    expect(payloads('session:ctx-increased')).toEqual([])
  })
})

describe('builds in use and the exclusive turn', () => {
  it('names the pack directory a session runs from, until it is unloaded', async () => {
    await data.writeModel('demo')
    const runtime = await makeRuntime()
    expect(runtime.buildDirsInUse()).toEqual([])
    await runtime.load('demo')
    expect(runtime.buildDirsInUse()).toEqual([
      join(data.layout.provider('llamacpp-upstream').backendsDir, 'b6325', 'macos-arm64'),
    ])
    await runtime.unload('demo')
    expect(runtime.buildDirsInUse()).toEqual([])
  })

  it('waits for the load in flight and holds the next one until it is done', async () => {
    await data.writeModel('first')
    await data.writeModel('second')
    const exePath = await data.writeBackend('llamacpp-upstream', 'b6325', 'macos-arm64')
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const runtime = await makeRuntime({
      ensureBackendReady: async (backend, version) => {
        await gate
        return { backend, version, exePath }
      },
    })
    const order: string[] = []
    const first = runtime.load('first').then(() => order.push('first loaded'))
    let finish!: () => void
    const held = new Promise<void>((resolve) => (finish = resolve))
    const turn = runtime.exclusive(async () => {
      order.push(`exclusive with ${runtime.getLoadedModels().join(',')}`)
      await held
      order.push('exclusive done')
      return 7
    })
    const second = runtime.load('second').then(() => order.push('second loaded'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toEqual([])
    release()
    await first
    await new Promise((resolve) => setTimeout(resolve, 50))
    // The turn began once the first load was a session, and the second load has not started.
    expect([...order].sort()).toEqual(['exclusive with first', 'first loaded'])
    expect(runtime.getLoadedModels()).toEqual(['first'])
    finish()
    expect(await turn).toBe(7)
    await second
    expect(order.slice(2)).toEqual(['exclusive done', 'second loaded'])
  })

  it('lets the next load run after a turn that failed', async () => {
    await data.writeModel('demo')
    const runtime = await makeRuntime()
    await expect(runtime.exclusive(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(runtime.load('demo')).resolves.toMatchObject({ model_id: 'demo' })
  })
})
