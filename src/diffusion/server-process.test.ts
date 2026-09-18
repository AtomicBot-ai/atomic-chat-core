/**
 * Port of the `process.rs` tests of `tauri-plugin-atomic-diffusion` (app commit `767ff6350`), against
 * `test/helpers/fake-sd-server.mjs`. Spawning a shell launcher is POSIX-only, as it was in Rust.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import { sampleSpec } from '../../test/helpers/diffusion-fixtures.js'
import { writeFakeSdLaunchers } from '../../test/helpers/fake-sd-server.js'
import type { FakeSdOptions } from '../../test/helpers/fake-sd-server.js'
import { isGgmlUnsupportedOpAbort } from './args.js'
import { createSdHttpClient } from './http.js'
import { isProcessAlive } from '../runtime/shared/index.js'
import { describeExit, earlyExitError, exitCodeOf, parseCapabilities, spawnServer } from './server-process.js'
import type { ServerHandle } from './state.js'

const posix = process.platform !== 'win32'
const http = createSdHttpClient()

let dir: string
const handles: ServerHandle[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-sd-process-'))
})
afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.terminate(0)))
  await rm(dir, { recursive: true, force: true })
})

async function engine(options: FakeSdOptions = {}, timeoutMs = 10_000) {
  const binaryDir = join(dir, 'engine')
  await writeFakeSdLaunchers(binaryDir, { ...options, pidFile: join(dir, 'pids') })
  return sampleSpec({ binaryDir, startupTimeoutMs: timeoutMs })
}

const startedPids = async () =>
  (await readFile(join(dir, 'pids'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(Number)

async function refusal(work: Promise<unknown>): Promise<AtomicCoreError> {
  const error = await work.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(error).toBeInstanceOf(AtomicCoreError)
  return error as AtomicCoreError
}

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe.skipIf(!posix)('spawnServer', () => {
  it('brings the server up, journals it before it is ready, reads its capabilities and its lines', async () => {
    const spec = await engine({ loadMs: 300, cancel: true })
    const seen: string[] = []
    const log: string[] = []
    let journalled: { pid: number; port: number; exe: string; whenReady: boolean } | undefined
    let ready = false
    const handle = await spawnServer(spec, join(dir, 'scratch'), {
      http,
      log: (level, msg) => log.push(`${level}: ${msg}`),
      onSpawned: async (pid, port, exe) => {
        journalled = { pid, port, exe, whenReady: ready }
      },
    })
    ready = true
    handles.push(handle)
    expect(journalled).toEqual({
      pid: handle.pid,
      port: handle.port,
      exe: join(spec.binaryDir, 'sd-server'),
      whenReady: false,
    })
    expect(handle.capabilities).toEqual({
      cancelGenerating: true,
      imgGenDefaults: { width: 512, height: 512 },
    })
    expect(handle.exitStatus()).toBeUndefined()
    expect(isProcessAlive(handle.pid)).toBe(true)
    expect(await startedPids()).toEqual([handle.pid])
    // The loader's in-place redraws arrived as separate, cleaned lines.
    const tail = handle.tail()
    expect(tail).toContain('  |####      | 40/100 - 637.50MB/s')
    expect(tail).toContain('  |##########| 100/100 - 637.50MB/s')
    expect(tail.at(-1)).toBe(`[INFO   ] server.cpp:100 - listening on 127.0.0.1:${handle.port}`)
    expect(log[0]).toMatch(/^info: starting sd-server: model=z-image-turbo-Q4_K_M.gguf port=\d+$/)

    // A listener gets what the server prints from then on.
    handle.setLineListener((line) => seen.push(line))
    const submit = await http.post(
      `http://127.0.0.1:${handle.port}/sdcpp/v1/img_gen`,
      { prompt: 'a cat', width: 16, height: 16, batch_count: 1, seed: 1, sample_params: { sample_steps: 2 } },
      2_000
    )
    expect(submit.status).toBe(202)
    await waitFor(() => seen.some((line) => line.includes('2/2')))
    expect(seen.some((line) => line.startsWith('|=>') && line.includes('1/2 - '))).toBe(true)
    handle.setLineListener(undefined)

    const exit = await handle.terminate(2_000)
    expect(exit.signal).toBe('SIGTERM')
    expect(handle.exitStatus()).toEqual(exit)
    expect(isProcessAlive(handle.pid)).toBe(false)
    expect(await handle.exited).toEqual(exit)
  })

  it('reports an early exit with the marker lines first', async () => {
    const spec = await engine({ mode: 'exit-early' })
    const log: string[] = []
    const error = await refusal(
      spawnServer(spec, join(dir, 'scratch'), { http, log: (l, m) => log.push(`${l}: ${m}`) })
    )
    expect(error.code).toBe('MODEL_LOAD_FAILED')
    expect(error.message).toBe('sd-server exited with code 6 while loading.')
    expect(error.details?.startsWith('ggml_metal: error: unsupported op')).toBe(true)
    expect(error.details).toContain('GGML_ABORT')
    expect(isGgmlUnsupportedOpAbort(error.details ?? '')).toBe(true)
    expect(log.some((line) => line.startsWith('warn: sd-server exited early (code 6)'))).toBe(true)
  })

  it('classifies an out-of-memory exit', async () => {
    const spec = await engine({
      mode: 'exit-early',
      exitCode: 1,
      stderr: 'ggml_backend_cuda_buffer_type_alloc_buffer: failed to allocate 4096 MB\n',
    })
    const error = await refusal(spawnServer(spec, join(dir, 'scratch'), { http }))
    expect(error.code).toBe('OUT_OF_MEMORY')
    expect(error.message).toBe('The image model ran out of memory while loading.')
  })

  it('kills a server that does not finish loading in time', async () => {
    const spec = await engine({ mode: 'hang' }, 1_500)
    const error = await refusal(spawnServer(spec, join(dir, 'scratch'), { http }))
    expect(error.code).toBe('MODEL_LOAD_FAILED')
    expect(error.message).toBe('The image model did not finish loading within 2 seconds.')
    expect(error.details).toContain('load tensors from model')
    const [pid] = await startedPids()
    expect(pid).toBeGreaterThan(0)
    expect(isProcessAlive(pid as number)).toBe(false)
  })

  it('refuses a missing binary before spawning anything', async () => {
    const spec = sampleSpec({ binaryDir: join(dir, 'nowhere') })
    const error = await refusal(spawnServer(spec, join(dir, 'scratch'), { http }))
    expect(error.toJSON()).toEqual({
      code: 'ENGINE_MISSING',
      message: 'The image engine is not installed.',
      details: `missing binary: ${join(dir, 'nowhere', 'sd-server')}`,
    })
  })

  it('reports a binary that could not be started', async () => {
    await writeFakeSdLaunchers(join(dir, 'engine'))
    const { chmod } = await import('node:fs/promises')
    await chmod(join(dir, 'engine', 'sd-server'), 0o644)
    const spec = sampleSpec({ binaryDir: join(dir, 'engine'), startupTimeoutMs: 5_000 })
    const error = await refusal(spawnServer(spec, join(dir, 'scratch'), { http }))
    expect(error.code).toBe('MODEL_LOAD_FAILED')
    expect(error.message).toBe('sd-server could not be started.')
    expect(error.details).toContain('EACCES')
  })

  it('stops the server when another process answers on its port', async () => {
    const spec = await engine({ mode: 'foreign' })
    const error = await refusal(spawnServer(spec, join(dir, 'scratch'), { http }))
    expect(error.code).toBe('MODEL_LOAD_FAILED')
    expect(error.message).toBe("Another process answered on sd-server's port.")
    expect(error.details).toMatch(
      /\/sdcpp\/v1\/capabilities returned 404: the listener is not stable-diffusion.cpp$/
    )
    const [pid] = await startedPids()
    expect(isProcessAlive(pid as number)).toBe(false)
  })

  it('stops a load that is abandoned while the model is still loading', async () => {
    const spec = await engine({ loadMs: 5_000 })
    const controller = new AbortController()
    const started = spawnServer(spec, join(dir, 'scratch'), {
      http,
      signal: controller.signal,
      readyPollIntervalMs: 50,
    })
    await waitFor(() => true)
    setTimeout(() => controller.abort(), 200)
    const error = await refusal(started)
    expect(error.toJSON()).toEqual({ code: 'CANCELLED', message: 'The image model load was stopped.' })
    const [pid] = await startedPids()
    expect(isProcessAlive(pid as number)).toBe(false)
  })

  it('lets a failing journal write stop the load', async () => {
    const spec = await engine()
    await expect(
      spawnServer(spec, join(dir, 'scratch'), {
        http,
        onSpawned: async () => {
          throw new Error('journal unwritable')
        },
      })
    ).rejects.toThrow('journal unwritable')
    const [pid] = await startedPids()
    expect(isProcessAlive(pid as number)).toBe(false)
  })

  it('reports a scratch directory it cannot create, and a port it cannot find', async () => {
    const spec = await engine()
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'blocker'), 'x')
    const scratch = await refusal(spawnServer(spec, join(dir, 'blocker', 'scratch'), { http }))
    expect(scratch.message).toBe('Could not create the scratch directory.')
    const port = await refusal(
      spawnServer(spec, join(dir, 'scratch'), {
        http,
        freePort: () => Promise.reject(new Error('none left')),
      })
    )
    expect(port.toJSON()).toEqual({
      code: 'INTERNAL',
      message: 'No free port for sd-server.',
      details: 'none left',
    })
  })
})

describe('parseCapabilities', () => {
  it('reads cancel_generating and the img_gen defaults', () => {
    const caps = parseCapabilities({
      features_by_mode: { img_gen: { cancel_generating: true, cancel_queued: true } },
      defaults_by_mode: { img_gen: { width: 1024 } },
    })
    expect(caps).toEqual({ cancelGenerating: true, imgGenDefaults: { width: 1024 } })
    expect(parseCapabilities({})).toEqual({ cancelGenerating: false })
    expect(parseCapabilities(null)).toEqual({ cancelGenerating: false })
    expect(parseCapabilities({ features_by_mode: { img_gen: { cancel_generating: 'yes' } } })).toEqual({
      cancelGenerating: false,
    })
    expect(parseCapabilities({ features_by_mode: 'x', defaults_by_mode: { img_gen: 1 } })).toEqual({
      cancelGenerating: false,
    })
  })
})

describe('exit helpers', () => {
  it('turn a signal into the 128+n code the classifier reads', () => {
    expect(exitCodeOf({ code: 6, signal: null })).toBe(6)
    expect(exitCodeOf({ code: null, signal: 'SIGKILL' })).toBe(137)
    expect(exitCodeOf({ code: null, signal: null })).toBeUndefined()
    expect(describeExit({ code: 6, signal: null })).toBe('code 6')
    expect(describeExit({ code: null, signal: 'SIGABRT' })).toBe('signal SIGABRT')
    expect(describeExit({ code: null, signal: null })).toBe('unknown status')
  })

  it('words an early exit by what is known about it', () => {
    expect(earlyExitError({ code: null, signal: 'SIGKILL' }, []).toJSON()).toEqual({
      code: 'OUT_OF_MEMORY',
      message: 'The image model ran out of memory while loading.',
      details: '',
    })
    expect(earlyExitError({ code: null, signal: 'SIGSEGV' }, ['boom']).message).toBe(
      'sd-server was terminated by signal SIGSEGV while loading.'
    )
    expect(earlyExitError({ code: null, signal: null }, []).message).toBe('sd-server exited while loading.')
  })
})
