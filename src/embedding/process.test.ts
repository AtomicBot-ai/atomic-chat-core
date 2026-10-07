import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { fakeEmbeddingSpawn } from '../../test/helpers/fake-llama-server.js'
import type { FakeLlamaOptions } from '../../test/helpers/fake-llama-server.js'
import { createDecisionHttp } from '../decision/index.js'
import type { AtomicCoreError } from '../contracts/index.js'
import { isProcessAlive } from '../runtime/shared/index.js'
import type { SpawnSpec } from '../runtime/shared/index.js'
import { embeddingEarlyExitError, spawnEmbeddingServer } from './process.js'
import type { EmbeddingProcessHandle, EmbeddingServerSpec, SpawnEmbeddingDeps } from './process.js'

const rejection = <T>(p: Promise<unknown>): Promise<T> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: unknown) => e as T
  )

/** The pack directory must exist: on Windows it is the child's working directory. */
const PACK_DIR = mkdtempSync(join(tmpdir(), 'atomic-embedding-pack-'))
afterAll(() => rmSync(PACK_DIR, { recursive: true, force: true }))

const handles: EmbeddingProcessHandle[] = []
afterEach(async () => {
  for (const h of handles.splice(0)) await h.terminate(0)
})

const spec = (over: Partial<EmbeddingServerSpec> = {}): EmbeddingServerSpec => ({
  engine: {
    path: join(PACK_DIR, 'llama-server'),
    version_backend: 'b11463/macos-arm64',
    provider: 'llamacpp-upstream',
  },
  modelPath: '/models/embeddinggemma-2-Q8_0.gguf',
  modelId: 'embeddinggemma-2',
  ctxSize: 4096,
  startupTimeoutMs: 4_000,
  ...over,
})

function start(
  options: FakeLlamaOptions = {},
  over: Partial<EmbeddingServerSpec> = {},
  extra: Partial<SpawnEmbeddingDeps> = {}
) {
  const events: string[] = []
  const lines: Array<{ provider: string; model: string }> = []
  const run = spawnEmbeddingServer(spec(over), {
    http: createDecisionHttp(),
    spawn: fakeEmbeddingSpawn(options),
    pollIntervalMs: 25,
    onSpawned: async (pid, port) => void events.push(`spawned ${pid > 0} ${port > 0}`),
    onGone: async () => void events.push('gone'),
    backendOutput: (line) => lines.push(line),
    ...extra,
  }).then((handle) => {
    handles.push(handle)
    return handle
  })
  return { run, events, lines }
}

describe('spawnEmbeddingServer', () => {
  it('starts the engine and reads the vector length and the text-only modality', async () => {
    const { run, events, lines } = start()
    const handle = await run
    expect(handle).toMatchObject({ modelId: 'embeddinggemma-2', dims: 3, modalities: ['text'] })
    expect(handle.apiKey.length).toBeGreaterThan(20)
    expect(events).toEqual(['spawned true true'])
    expect(lines.every((l) => l.provider === 'embedding' && l.model === 'embeddinggemma-2')).toBe(true)
    // The key is the process's own: a request without it is refused.
    const open = await fetch(`${handle.baseUrl}/v1/embeddings`, { method: 'POST', body: '{"input":"x"}' })
    expect(open.status).toBe(401)
  })

  it('offers video only when ffmpeg is there to decode it, and puts it on the PATH', async () => {
    const envs: Array<Record<string, string>> = []
    const base = fakeEmbeddingSpawn({ embedding: { video: true } })
    const capture: SpawnEmbeddingDeps['spawn'] = (s, onLine) => {
      envs.push(s.env as Record<string, string>)
      return base(s, onLine)
    }
    const projector = { mmprojPath: '/models/mmproj-Q8_0.gguf' }
    const withFfmpeg = await start({}, projector, {
      spawn: capture,
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      findFfmpeg: async () => '/opt/homebrew/bin',
    }).run
    expect(withFfmpeg.modalities).toEqual(['text', 'image', 'video'])
    expect(envs[0]?.['PATH']?.split(':')[0]).toBe('/opt/homebrew/bin')

    const without = await start({}, projector, {
      spawn: capture,
      findFfmpeg: async () => undefined,
    }).run
    expect(without.modalities).toEqual(['text', 'image'])
    // A search that fails is no ffmpeg, not a failed start.
    const failing = await start({}, projector, {
      spawn: capture,
      findFfmpeg: async () => {
        throw new Error('EACCES')
      },
    }).run
    expect(failing.modalities).toEqual(['text', 'image'])
  })

  it('reads image and audio from a projector', async () => {
    const vision = await start({}, { mmprojPath: '/models/mmproj-Q8_0.gguf', imageMaxTokens: 280 }).run
    expect(vision.modalities).toEqual(['text', 'image'])
    const both = await start({ embedding: { audio: true } }, { mmprojPath: '/models/mmproj-Q8_0.gguf' }).run
    expect(both.modalities).toEqual(['text', 'image', 'audio'])
  })

  it('fails a model the engine will not make vectors of, and leaves no process', async () => {
    const { run, events } = start({ embedding: { refuse: true } })
    const error = await rejection<AtomicCoreError>(run)
    expect(error.code).toBe('MODEL_LOAD_FAILED')
    expect(error.details).toContain("Pooling type 'none'")
    expect(events).toEqual(['spawned true true', 'gone'])
  })

  it('calls a server without embeddings unsupported', async () => {
    // A build that ignored `--embedding`: the fake answers 501 then, as llama.cpp does.
    const base = fakeEmbeddingSpawn()
    const strip: SpawnEmbeddingDeps['spawn'] = (s: SpawnSpec, onLine) =>
      base({ ...s, args: s.args.filter((a) => a !== '--embedding') }, onLine)
    const error = await rejection<AtomicCoreError>(start({}, {}, { spawn: strip }).run)
    expect(error).toMatchObject({
      code: 'EMBEDDING_ENGINE_UNSUPPORTED',
      message: expect.stringContaining('does not serve embeddings'),
    })
  })

  it('reports an exit while loading with the last lines', async () => {
    const error = await rejection<AtomicCoreError>(start({ mode: 'exit-3' }).run)
    expect(error).toMatchObject({ code: 'MODEL_LOAD_FAILED', message: expect.stringContaining('code 3') })
    expect(error.details).toContain('something went wrong')
  })

  it('times out a server that never gets ready, and kills it', async () => {
    let pid = 0
    const error = await rejection<AtomicCoreError>(
      start({ mode: 'no-ready' }, { startupTimeoutMs: 300 }, { onSpawned: async (p) => void (pid = p) }).run
    )
    expect(error.code).toBe('MODEL_LOAD_TIMED_OUT')
    expect(error.details).toContain('/health answered 503')
    expect(isProcessAlive(pid)).toBe(false)
  })

  it('stops a start the owner gave up on, and a start the journal refused', async () => {
    const stopped = await rejection<AtomicCoreError>(
      start({ mode: 'no-ready' }, {}, { signal: AbortSignal.abort() }).run
    )
    expect(stopped.code).toBe('EMBEDDING_UNAVAILABLE')
    const refused = await rejection<Error>(
      start(
        {},
        {},
        {
          onSpawned: async () => {
            throw new Error('journal is read-only')
          },
        }
      ).run
    )
    expect(refused.message).toBe('journal is read-only')
  })

  it('names a port it could not get, and an engine that could not start', async () => {
    const noPort = await rejection<AtomicCoreError>(
      start(
        {},
        {},
        {
          freePort: async () => {
            throw new Error('every port is taken')
          },
        }
      ).run
    )
    expect(noPort).toMatchObject({ code: 'MODEL_LOAD_FAILED', details: 'every port is taken' })
    const missing = await rejection<AtomicCoreError>(
      spawnEmbeddingServer(
        spec({ engine: { path: join(PACK_DIR, 'nope'), version_backend: null, provider: null } }),
        {
          http: createDecisionHttp(),
          pollIntervalMs: 25,
        }
      )
    )
    expect(missing).toMatchObject({
      code: 'MODEL_LOAD_FAILED',
      message: 'The embedding engine could not be started.',
    })
  })
})

describe('embeddingEarlyExitError', () => {
  it('carries the code or signal and the tail', () => {
    expect(embeddingEarlyExitError({ code: null, signal: 'SIGSEGV' }, ['a', 'b'])).toMatchObject({
      message: expect.stringContaining('signal SIGSEGV'),
      details: 'a\nb',
    })
    expect(embeddingEarlyExitError({ code: null, signal: null }, []).details).toBeUndefined()
  })
})
