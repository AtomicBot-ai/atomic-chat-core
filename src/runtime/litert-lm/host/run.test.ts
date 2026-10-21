import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeLiteRtLibrary, GEMMA_INFO } from '../../../../test/helpers/fake-litert-library.js'
import { LiteRtLibraryError } from './library.js'
import { EXIT, runLiteRtHost } from './run.js'
import type { LiteRtHostDeps } from './run.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-litert-run-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function harness(library = new FakeLiteRtLibrary()) {
  const out: string[] = []
  const err: string[] = []
  let stop: () => void = () => {}
  const loads: Array<{ libDir: string; ovLibsDir?: string }> = []
  const deps: LiteRtHostDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    loadLibrary: async (libDir, options) => {
      loads.push({ libDir, ...(options?.ovLibsDir ? { ovLibsDir: options.ovLibsDir } : {}) })
      return library
    },
    watchStop: () => ({ stopped: new Promise<void>((resolve) => (stop = resolve)), dispose: () => {} }),
  }
  return { deps, out, err, library, loads, stop: () => stop() }
}

const serveArgs = (over: Record<string, string> = {}, flags: string[] = []) => {
  const values: Record<string, string> = {
    'lib': join(dir, 'build'),
    'engine-version': '0.18.1',
    'model': '/m/gemma.litertlm',
    'backend': 'cpu',
    'max-tokens': '65536',
    'port': '0',
    'cache': join(dir, 'cache'),
    'id': 'gemma-e2b',
    ...over,
  }
  return ['serve', ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]), ...flags]
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('runLiteRtHost probe and inspect (task 5.2)', () => {
  it('probe prints the version, the ABI and the backends of the build', async () => {
    const h = harness()
    expect(await runLiteRtHost(['probe', '--lib', '/b'], h.deps)).toBe(EXIT.ok)
    expect(h.out.map((line) => JSON.parse(line) as unknown)).toEqual([
      { version: '0.18.1', abi: 1, backends: ['cpu', 'gpu'] },
    ])
    expect(h.loads).toEqual([{ libDir: join('/b', 'lib') }])
  })

  it('inspect prints the file metadata as JSON', async () => {
    const h = harness()
    h.library.files.set('/m/gemma.litertlm', GEMMA_INFO)
    expect(await runLiteRtHost(['inspect', '--lib', '/b', '/m/gemma.litertlm'], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0] ?? '')).toEqual(GEMMA_INFO)
  })

  it('exits 4 with the library message for a broken file, 3 when the library does not load, 2 on usage', async () => {
    const h = harness()
    expect(await runLiteRtHost(['inspect', '--lib', '/b', '/m/cut.litertlm'], h.deps)).toBe(EXIT.libraryCall)
    expect(h.err.join('\n')).toMatch(/cut\.litertlm is not a LiteRT-LM file/)
    expect(h.out).toEqual([])

    const unloadable = harness()
    unloadable.deps.loadLibrary = async () => {
      throw new LiteRtLibraryError('load', 'dlopen: image not found')
    }
    expect(await runLiteRtHost(['probe', '--lib', '/b'], unloadable.deps)).toBe(EXIT.load)
    expect(unloadable.err.join('\n')).toMatch(/image not found/)

    expect(await runLiteRtHost(['serve'], h.deps)).toBe(EXIT.usage)
  })
})

describe('runLiteRtHost serve (task 5.3)', () => {
  it('creates the engine from the file facts, prints the readiness line, serves, and stops on a signal', async () => {
    const h = harness()
    h.library.files.set('/m/gemma.litertlm', GEMMA_INFO)
    const exit = runLiteRtHost(serveArgs({}, ['--speculative', '--reasoning']), h.deps)
    await until(() => h.out.length > 0)
    const ready = JSON.parse(h.out[0] ?? '{}') as { url: string }
    expect(ready).toEqual({
      ready: true,
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      model_id: 'gemma-e2b',
      backend: 'cpu',
      max_num_tokens: 32003,
      vision: true,
      speculative: true,
    })
    expect((await stat(join(dir, 'cache'))).isDirectory()).toBe(true)
    expect(h.library.engines[0]?.settings).toEqual({
      model: '/m/gemma.litertlm',
      backend: 'cpu',
      visionBackend: 'cpu',
      maxNumTokens: 32003,
      cacheDir: join(dir, 'cache'),
      speculative: true,
    })
    const models = (await (await fetch(`${ready.url}/v1/models`)).json()) as { data: Array<{ id: string }> }
    expect(models.data[0]?.id).toBe('gemma-e2b')

    h.stop()
    expect(await exit).toBe(EXIT.ok)
    expect(h.library.engines[0]?.closed).toBe(true)
    await expect(fetch(`${ready.url}/v1/models`)).rejects.toThrow()
  })

  it('keeps the asked length under the file maximum, sets no vision backend without an encoder, no draft without one', async () => {
    const h = harness()
    h.library.files.set('/m/text.litertlm', {
      ...GEMMA_INFO,
      max_context_tokens: null,
      modalities: ['text'],
      vision_backends: [],
      speculative_decoding: false,
    })
    const exit = runLiteRtHost(
      serveArgs({ 'model': '/m/text.litertlm', 'max-tokens': '4096', 'backend': 'gpu' }, ['--speculative']),
      h.deps
    )
    await until(() => h.out.length > 0)
    expect(JSON.parse(h.out[0] ?? '{}')).toMatchObject({
      max_num_tokens: 4096,
      vision: false,
      speculative: false,
      backend: 'gpu',
    })
    expect(h.library.engines[0]?.settings).toMatchObject({
      visionBackend: null,
      maxNumTokens: 4096,
      speculative: false,
    })
    h.stop()
    expect(await exit).toBe(EXIT.ok)
  })

  it('refuses a file that needs a newer LiteRT-LM before creating an engine', async () => {
    const h = harness()
    h.library.files.set('/m/new.litertlm', { ...GEMMA_INFO, min_runtime_version: '0.19' })
    expect(await runLiteRtHost(serveArgs({ model: '/m/new.litertlm' }), h.deps)).toBe(
      EXIT.requiresNewerEngine
    )
    expect(JSON.parse(h.err.at(-1) ?? '{}')).toEqual({
      code: 'LITERT_LM_MODEL_REQUIRES_NEWER_ENGINE',
      required: '0.19',
      engine: '0.18.1',
    })
    expect(h.library.engines).toEqual([])
    h.library.files.set('/m/same.litertlm', { ...GEMMA_INFO, min_runtime_version: '0.18' })
    const ok = runLiteRtHost(serveArgs({ model: '/m/same.litertlm' }), h.deps)
    await until(() => h.out.length > 0)
    h.stop()
    expect(await ok).toBe(EXIT.ok)
  })

  it('refuses a backend the file does not run on, and reports an engine the library cannot create', async () => {
    const h = harness()
    h.library.files.set('/m/gemma.litertlm', GEMMA_INFO)
    expect(
      await runLiteRtHost(serveArgs({ 'backend': 'npu', 'dispatch': '/d', 'ov-libs': '/ov' }), h.deps)
    ).toBe(EXIT.variantUnsupported)
    expect(JSON.parse(h.err.at(-1) ?? '{}')).toMatchObject({ code: 'LITERT_LM_VARIANT_UNSUPPORTED' })
    expect(h.loads.at(-1)).toEqual({ libDir: join(dir, 'build', 'lib'), ovLibsDir: '/ov' })

    h.library.failEngine = 'INTERNAL: Failed to create Metal device'
    expect(await runLiteRtHost(serveArgs(), h.deps)).toBe(EXIT.libraryCall)
    expect(h.err.join('\n')).toMatch(/Failed to create Metal device/)
  })

  it('passes the dispatch library to an NPU engine', async () => {
    const h = harness()
    h.library.files.set('/m/npu.litertlm', {
      ...GEMMA_INFO,
      backends: ['npu'],
      npu: { brand: 'intel', soc: 'LNL' },
    })
    const exit = runLiteRtHost(
      serveArgs({ 'model': '/m/npu.litertlm', 'backend': 'npu', 'dispatch': '/d', 'ov-libs': '/ov' }),
      h.deps
    )
    await until(() => h.out.length > 0)
    expect(h.library.engines[0]?.settings).toMatchObject({ backend: 'npu', dispatchLibDir: '/d' })
    h.stop()
    expect(await exit).toBe(EXIT.ok)
  })
})
