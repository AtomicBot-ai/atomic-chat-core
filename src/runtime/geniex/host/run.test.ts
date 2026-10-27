import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeGeniexLibrary } from '../../../../test/helpers/fake-geniex-library.js'
import { FakeGeniexWorker } from '../../../../test/helpers/fake-geniex-worker.js'
import { buildGguf } from '../../../../test/helpers/gguf-builder.js'
import { WorkerEngine } from './engine.js'
import { GeniexLibraryError } from './library.js'
import { EXIT, runGeniexHost } from './run.js'
import type { GeniexHostDeps } from './run.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-geniex-run-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

function harness(library = new FakeGeniexLibrary(), over: Partial<GeniexHostDeps> = {}) {
  const out: string[] = []
  const err: string[] = []
  let stop: () => void = () => {}
  const worker = new FakeGeniexWorker(library)
  const deps: GeniexHostDeps = {
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    startEngine: () => new WorkerEngine(worker),
    watchStop: () => ({ stopped: new Promise<void>((resolve) => (stop = resolve)), dispose: () => {} }),
    ...over,
  }
  return { deps, out, err, library, worker, stop: () => stop() }
}

async function ggufFile(
  name = 'qwen3.gguf',
  metadata: Record<string, string | number> = {}
): Promise<string> {
  const file = join(dir, name)
  await writeFile(
    file,
    buildGguf({
      metadata: {
        'general.architecture': 'qwen3',
        'general.file_type': 2,
        'qwen3.context_length': 8192,
        ...metadata,
      },
      tensors: [{ name: 'token_embd.weight', type: 2, dims: [64, 8], bitsPerWeight: 4.5 }],
    })
  )
  return file
}

const serveArgs = (over: Record<string, string> = {}, flags: string[] = []) => {
  const values: Record<string, string> = {
    'lib': join(dir, 'build'),
    'engine-version': '0.9.3',
    'model': join(dir, 'qwen3.gguf'),
    'plugin': 'llama_cpp',
    'device': 'npu',
    'nctx': '65536',
    'max-tokens': '4096',
    'power-mode': 'burst',
    'port': '0',
    'tmp': join(dir, 'tmp'),
    'id': 'qwen3-4b',
    ...over,
  }
  return ['serve', ...Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]), ...flags]
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 5))
}

describe('runGeniexHost probe and inspect (task 5.2)', () => {
  it('probe prints the version, the ABI, the plugins and the devices of the build, loading from <build>/lib', async () => {
    const h = harness()
    expect(await runGeniexHost(['probe', '--lib', 'build'], h.deps)).toBe(EXIT.ok)
    expect(h.out.map((line) => JSON.parse(line) as unknown)).toEqual([
      { version: '0.9.3', abi: 1, plugins: ['llama_cpp', 'qairt'], devices: ['HTP0', 'GPUOpenCL', 'CPU'] },
    ])
    expect(h.worker.loads).toEqual([resolve('build', 'lib')])
    expect(h.worker.terminated).toBe(true)
  })

  it('inspect prints a GGUF file or a bundle as JSON, without the library; a broken path exits 4', async () => {
    const h = harness()
    const file = await ggufFile()
    expect(await runGeniexHost(['inspect', file], h.deps)).toBe(EXIT.ok)
    expect(JSON.parse(h.out[0] ?? '')).toEqual({
      kind: 'gguf',
      architecture: 'qwen3',
      max_context_tokens: 8192,
      quantization: 'Q4_0',
      chat_template: false,
      vision: false,
    })
    expect(h.worker.loads).toEqual([])
    expect(await runGeniexHost(['inspect', join(dir, 'cut.gguf')], h.deps)).toBe(EXIT.libraryCall)
    expect(h.err.join('\n')).toMatch(/cut\.gguf does not exist/)
  })

  it('exits 3 when the library does not load, 4 when a call fails, 2 on usage', async () => {
    const h = harness(new FakeGeniexLibrary(), {
      startEngine: () => {
        throw new GeniexLibraryError('load', 'geniex-host runs only inside a compiled binary (no Worker)')
      },
    })
    expect(await runGeniexHost(['probe', '--lib', '/b'], h.deps)).toBe(EXIT.load)
    expect(h.err[0]).toMatch(/^GenieX does not load from \/b: load: geniex-host runs only/)
    const refused = harness()
    refused.library.pluginList = []
    refused.library.plugins = () => {
      throw new GeniexLibraryError('get_plugin_list', 'Library not initialized', -100007)
    }
    expect(await runGeniexHost(['probe', '--lib', '/b'], refused.deps)).toBe(EXIT.libraryCall)
    expect(refused.err[0]).toMatch(/Library not initialized/)
    expect(await runGeniexHost(['nope'], harness().deps)).toBe(EXIT.usage)
  })
})

describe('runGeniexHost serve (task 5.3)', () => {
  it('creates the model in the Worker with the context cut to the file, prints readiness with the port, and stops on the stop signal', async () => {
    const h = harness()
    await ggufFile()
    const run = runGeniexHost(serveArgs({}, ['--reasoning']), h.deps)
    await until(() => h.out.length > 0)
    const ready = JSON.parse(h.out[0] ?? '{}') as {
      ready: boolean
      url: string
      n_ctx: number
      vision: boolean
      plugin: string
      device: string
    }
    expect(ready).toMatchObject({
      ready: true,
      model_id: 'qwen3-4b',
      plugin: 'llama_cpp',
      device: 'npu',
      n_ctx: 8192,
      vision: false,
    })
    expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(h.library.models[0]?.settings).toEqual({
      plugin: 'llama_cpp',
      device: 'npu',
      model: join(dir, 'qwen3.gguf'),
      mmproj: null,
      nCtx: 8192,
      powerMode: 'burst',
    })
    expect(h.worker.loads).toEqual([join(dir, 'build', 'lib')])
    const models = (await (await fetch(`${ready.url}/v1/models`)).json()) as { data: Array<{ id: string }> }
    expect(models.data[0]?.id).toBe('qwen3-4b')
    expect((await stat(join(dir, 'tmp'))).isDirectory()).toBe(true)
    h.stop()
    expect(await run).toBe(EXIT.ok)
    expect(h.library.models[0]?.destroyed).toBe(true)
    expect(h.worker.terminated).toBe(true)
    await expect(stat(join(dir, 'tmp'))).rejects.toThrow()
    await expect(fetch(`${ready.url}/v1/models`)).rejects.toThrow()
  })

  it('creates a VLM with --mmproj and says so in the readiness line', async () => {
    const h = harness()
    await ggufFile()
    const run = runGeniexHost(serveArgs({ mmproj: join(dir, 'mmproj.gguf') }), h.deps)
    await until(() => h.out.length > 0)
    expect(JSON.parse(h.out[0] ?? '{}')).toMatchObject({ vision: true })
    expect(h.library.models[0]?.settings.mmproj).toBe(join(dir, 'mmproj.gguf'))
    h.stop()
    expect(await run).toBe(EXIT.ok)
  })

  it('exits 7 for a qairt bundle on a device other than the NPU, and for a plugin that does not match the model', async () => {
    const h = harness()
    const bundle = join(dir, 'bundle')
    await mkdir(bundle)
    await writeFile(
      join(bundle, 'geniex.json'),
      JSON.stringify({ chipset: 'qualcomm-snapdragon-x-elite', context_length: 4096 })
    )
    expect(await runGeniexHost(serveArgs({ model: bundle, plugin: 'qairt', device: 'gpu' }), h.deps)).toBe(
      EXIT.variantUnsupported
    )
    expect(JSON.parse(h.err[0] ?? '{}')).toMatchObject({
      code: 'GENIEX_VARIANT_UNSUPPORTED',
      device: 'gpu',
      message: /NPU only/,
    })
    const mismatch = harness()
    await ggufFile()
    expect(await runGeniexHost(serveArgs({ plugin: 'qairt' }), mismatch.deps)).toBe(EXIT.variantUnsupported)
    expect(JSON.parse(mismatch.err[0] ?? '{}')).toMatchObject({
      code: 'GENIEX_VARIANT_UNSUPPORTED',
      message: /llama_cpp/,
    })
    expect(h.library.models).toEqual([])
  })

  it('exits 6 for a bundle that needs a newer GenieX, naming the version, and 4 for a model file that cannot be read', async () => {
    const h = harness()
    const bundle = join(dir, 'bundle')
    await mkdir(bundle)
    await writeFile(
      join(bundle, 'geniex.json'),
      JSON.stringify({ chipset: 'x-elite', min_runtime_version: '0.10.0' })
    )
    expect(await runGeniexHost(serveArgs({ model: bundle, plugin: 'qairt', device: 'npu' }), h.deps)).toBe(
      EXIT.requiresNewerEngine
    )
    expect(JSON.parse(h.err[0] ?? '{}')).toEqual({
      code: 'GENIEX_MODEL_REQUIRES_NEWER_ENGINE',
      required: '0.10.0',
      engine: '0.9.3',
    })
    const broken = harness()
    expect(await runGeniexHost(serveArgs({ model: join(dir, 'missing.gguf') }), broken.deps)).toBe(
      EXIT.libraryCall
    )
    expect(broken.err[0]).toMatch(/does not exist/)
    expect(broken.out).toEqual([])
  })

  it('exits 4 with the library message when the model cannot be created, and 3 when the library does not load', async () => {
    const h = harness()
    await ggufFile()
    h.library.createFailure = { message: 'Model loading failed', code: -100201 }
    expect(await runGeniexHost(serveArgs(), h.deps)).toBe(EXIT.libraryCall)
    expect(h.err[0]).toMatch(/could not create the model .*Model loading failed/)
    expect(h.out).toEqual([])
    const noLib = harness()
    noLib.worker.crashOnNext = 'LoadLibraryW: error 126'
    expect(await runGeniexHost(serveArgs(), noLib.deps)).toBe(EXIT.libraryCall)
  })
})
