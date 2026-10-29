/**
 * `spawnAudioServer` against `test/helpers/fake-audiocpp-server.mjs`. Spawning a shell launcher is
 * POSIX-only.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { sampleAudioSpec } from '../../test/helpers/audio-fixtures.js'
import { writeFakeAudioLaunchers } from '../../test/helpers/fake-audiocpp-server.js'
import type { FakeAudioOptions } from '../../test/helpers/fake-audiocpp-server.js'
import { isProcessAlive } from '../runtime/shared/index.js'
import { createAudioHttpClient } from './http.js'
import { SERVER_CONFIG_FILE, spawnAudioServer } from './server-process.js'
import type { SpawnAudioServerDeps } from './server-process.js'
import type { AudioServerHandle, AudioServerSpec } from './types.js'

const posix = process.platform !== 'win32'
const http = createAudioHttpClient()

let dir: string
const handles: AudioServerHandle[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-audio-process-'))
})
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.terminate(0)))
  await rm(dir, { recursive: true, force: true })
})

async function engine(
  options: FakeAudioOptions = {},
  over: Partial<AudioServerSpec> = {}
): Promise<AudioServerSpec> {
  const binaryDir = join(dir, 'engine')
  await writeFakeAudioLaunchers(binaryDir, {
    pidFile: join(dir, 'pids'),
    argvFile: join(dir, 'argv.json'),
    envFile: join(dir, 'env.json'),
    ...options,
  })
  const modelPath = join(dir, 'kokoro.gguf')
  await writeFile(modelPath, 'GGUF fake')
  return sampleAudioSpec({ binaryDir, modelPath, backend: 'cpu', ...over })
}

/**
 * A port the OS hands out (its ephemeral range), so these fakes never land in `randomFreePort`'s
 * 3000–4000, where the diffusion and llama.cpp tests running in parallel pick theirs: a fake from
 * here answering on one of their ports reads as a foreign listener there.
 */
const ephemeralPort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number }
      probe.close(() => resolve(port))
    })
  })

const deps = (over: Partial<SpawnAudioServerDeps> = {}): SpawnAudioServerDeps => ({
  http,
  freePort: ephemeralPort,
  runDir: join(dir, 'run'),
  tmpDir: join(dir, 'tmp'),
  env: { ...process.env, HOME: '/home/someone' },
  readyPollIntervalMs: 30,
  ...over,
})

async function refusal(work: Promise<unknown>): Promise<AtomicCoreError> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AtomicCoreError)
  return error as AtomicCoreError
}

const startedPids = async () =>
  (await readFile(join(dir, 'pids'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number)

describe.skipIf(!posix)('spawnAudioServer', () => {
  it('writes the config, starts the server from its folder, journals it before ready and reads what it declares', async () => {
    const spec = await engine({ loadMs: 200 }, { threads: 2 })
    let journalled: { pid: number; port: number; exe: string } | undefined
    const lines: string[] = []
    const handle = await spawnAudioServer(
      spec,
      deps({
        onSpawned: async (pid, port, exe) => {
          journalled = { pid, port, exe }
        },
        backendOutput: (line) => lines.push(`${line.provider} ${line.model} ${line.line}`),
      })
    )
    handles.push(handle)
    expect(journalled).toEqual({
      pid: handle.pid,
      port: handle.port,
      exe: join(spec.binaryDir, 'audiocpp_server'),
    })
    const config = JSON.parse(await readFile(join(dir, 'run', SERVER_CONFIG_FILE), 'utf8')) as Record<
      string,
      unknown
    >
    expect(config).toMatchObject({
      port: handle.port,
      backend: 'cpu',
      lazy_load: false,
      max_loaded_models: 1,
      idle_unload_ms: 0,
      models: [
        { id: 'kokoro-82m:q8_0', family: 'kokoro_tts', path: spec.modelPath, task: 'tts', mode: 'offline' },
      ],
    })
    const argv = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as string[]
    expect(argv).toEqual([
      '--config',
      join(dir, 'run', SERVER_CONFIG_FILE),
      '--no-ui',
      '--host',
      '127.0.0.1',
      '--port',
      String(handle.port),
      '--backend',
      'cpu',
      '--log',
      '--load-progress',
      '1',
      '--threads',
      '2',
    ])
    // The child keeps the caller's environment (eSpeak-ng's cache is under HOME) with TMPDIR moved.
    const childEnv = JSON.parse(await readFile(join(dir, 'env.json'), 'utf8')) as Record<string, unknown>
    expect(childEnv).toMatchObject({ TMPDIR: join(dir, 'tmp'), HOME: '/home/someone' })
    expect(await import('node:fs/promises').then((fs) => fs.realpath(childEnv['cwd'] as string))).toBe(
      await import('node:fs/promises').then((fs) => fs.realpath(spec.binaryDir))
    )
    expect(handle.capabilities).toEqual({
      modelId: 'kokoro-82m:q8_0',
      mode: 'speech',
      family: 'kokoro_tts',
      task: 'tts',
      params: expect.arrayContaining([expect.objectContaining({ name: 'voice_id' })]),
      voices: ['af_heart', 'am_adam'],
      supportsVoiceRef: false,
      requiresVoiceRef: false,
    })
    expect(lines).toContain(
      'audio-cpp kokoro-82m:q8_0 [TRACE ts=20261029-150000] runtime.model.variant Kokoro 82M'
    )
    expect(handle.tail().some((line) => line.includes('listening on'))).toBe(true)
    expect(handle.exitStatus()).toBeUndefined()
    await handle.terminate()
    expect(handle.exitStatus()).toBeDefined()
    expect(isProcessAlive(handle.pid)).toBe(false)
  })

  it('reads a clone-only voice model from the loader traces', async () => {
    const spec = await engine({}, { modelId: 'qwen', family: 'qwen3_tts' })
    const handle = await spawnAudioServer(spec, deps())
    handles.push(handle)
    expect(handle.capabilities).toMatchObject({ voices: [], supportsVoiceRef: true, requiresVoiceRef: true })
  })

  it('asks the voice list when the model declares no voice values', async () => {
    const spec = await engine({}, { modelId: 'other', family: 'other_tts' })
    const seen: string[] = []
    const handle = await spawnAudioServer(
      spec,
      deps({
        http: {
          get: (url, options) => {
            seen.push(new URL(url).pathname + new URL(url).search)
            return http.get(url, options)
          },
          post: http.post,
        },
      })
    )
    handles.push(handle)
    expect(seen).toContain('/v1/audio/voices?model=other')
    expect(handle.capabilities).toMatchObject({
      voices: [],
      supportsVoiceRef: false,
      params: [{ name: 'seed' }],
    })
  })

  it('reports a model that failed to load with the engine words, and forgets the child', async () => {
    const spec = await engine({ mode: 'load-fail' })
    const spawned: number[] = []
    const gone: number[] = []
    const error = await refusal(
      spawnAudioServer(
        spec,
        deps({ onSpawned: async (pid) => void spawned.push(pid), onGone: async (pid) => void gone.push(pid) })
      )
    )
    expect(error.code).toBe('MODEL_LOAD_FAILED')
    expect(error.details).toContain('unsupported model contract')
    expect(gone).toEqual(spawned)
    expect(gone).toHaveLength(1)
  })

  it('reports a missing model file the way the engine says it', async () => {
    const spec = await engine({}, {})
    const error = await refusal(spawnAudioServer({ ...spec, modelPath: join(dir, 'missing.gguf') }, deps()))
    expect(error).toMatchObject({ code: 'MODEL_LOAD_FAILED' })
    expect(error.details).toContain('model path does not exist')
  })

  it('reads an allocation failure while loading as out of memory', async () => {
    const error = await refusal(spawnAudioServer(await engine({ mode: 'oom' }), deps()))
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.details).toContain('cudaMalloc failed: out of memory')
  })

  it('refuses another server that answers on the port, and stops ours', async () => {
    let spawned: number | undefined
    const error = await refusal(
      spawnAudioServer(
        await engine({ mode: 'foreign-listener' }),
        deps({ onSpawned: async (pid) => void (spawned = pid) })
      )
    )
    expect(error).toMatchObject({
      code: 'MODEL_LOAD_FAILED',
      message: "Another process answered on the audio server's port.",
    })
    expect(isProcessAlive(spawned as number)).toBe(false)
  })

  it('refuses a model the engine serves as another family or task', async () => {
    const spec = await engine()
    const handle = spawnAudioServer(
      spec,
      deps({
        http: {
          get: async (url, options) => {
            const response = await http.get(url, options)
            if (!url.includes('/v1/models')) return response
            const body = JSON.parse(response.body.toString('utf8')) as {
              data: Array<Record<string, unknown>>
            }
            body.data[0] = { ...body.data[0], family: 'qwen3_tts' }
            return { ...response, body: Buffer.from(JSON.stringify(body)) }
          },
          post: http.post,
        },
      })
    )
    const error = await refusal(handle)
    expect(error).toMatchObject({
      code: 'MODEL_INCOMPATIBLE',
      details: 'family=qwen3_tts task=tts; wanted family=kokoro_tts task=tts',
    })
  })

  it('starts again on another port when its port was taken', async () => {
    const spec = await engine()
    const taken: Server = createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    const busyPort = (taken.address() as { port: number }).port
    const ports = [busyPort]
    const warnings: string[] = []
    try {
      const handle = await spawnAudioServer(
        spec,
        deps({
          freePort: async () => ports.shift() ?? ephemeralPort(),
          log: (level, msg) => level === 'warn' && warnings.push(msg),
        })
      )
      handles.push(handle)
      expect(handle.port).not.toBe(busyPort)
      expect(warnings.some((w) => w.includes('port was taken'))).toBe(true)
      expect(await startedPids()).toHaveLength(2)
    } finally {
      taken.close()
    }
  })

  it('gives up after the startup timeout and kills the child', async () => {
    const spec = await engine({ loadMs: 60_000 }, { startupTimeoutMs: 1_000 })
    let spawned: number | undefined
    const error = await refusal(
      spawnAudioServer(spec, deps({ onSpawned: async (pid) => void (spawned = pid) }))
    )
    expect(error).toMatchObject({
      code: 'MODEL_LOAD_FAILED',
      message: 'The audio model did not finish loading within 1 seconds.',
    })
    expect(spawned).toBeGreaterThan(0)
    expect(isProcessAlive(spawned as number)).toBe(false)
  })

  it('stops a load an unload asked to stop, killing the child', async () => {
    const spec = await engine({ loadMs: 60_000 })
    const controller = new AbortController()
    let spawned: number | undefined
    const started = spawnAudioServer(
      spec,
      deps({ signal: controller.signal, onSpawned: async (pid) => void (spawned = pid) })
    )
    setTimeout(() => controller.abort(), 150)
    expect((await refusal(started)).code).toBe('CANCELLED')
    expect(isProcessAlive(spawned as number)).toBe(false)
  })

  it('kills the child when the journal refuses it', async () => {
    const spec = await engine({ loadMs: 60_000 })
    let spawned: number | undefined
    await expect(
      spawnAudioServer(
        spec,
        deps({
          onSpawned: async (pid) => {
            spawned = pid
            throw new Error('journal is read-only')
          },
        })
      )
    ).rejects.toThrow('journal is read-only')
    expect(spawned).toBeDefined()
    expect(isProcessAlive(spawned as number)).toBe(false)
  })
})

describe('spawnAudioServer without a binary', () => {
  it('says the engine is not installed', async () => {
    const spec = sampleAudioSpec({ binaryDir: join(dir, 'nowhere') })
    const error = await refusal(spawnAudioServer(spec, deps()))
    expect(error.code).toBe('ENGINE_MISSING')
  })
})
