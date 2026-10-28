import { describe, expect, it } from 'vitest'
import { FakeGeniexLibrary } from '../../../../test/helpers/fake-geniex-library.js'
import { FakeGeniexWorker } from '../../../../test/helpers/fake-geniex-worker.js'
import { GeniexLibraryError } from './library.js'
import type { GeniexModelSettings } from './library.js'
import { GeniexWorkerGone, WorkerEngine } from './engine.js'

const SETTINGS: GeniexModelSettings = {
  plugin: 'llama_cpp',
  device: 'cpu',
  model: '/m/qwen3.gguf',
  mmproj: null,
  nCtx: 4096,
  threads: 0,
  powerMode: 'burst',
}
const CONFIG = { maxTokens: 64, stop: [], sampler: { grammar: null }, imagePaths: [] }

describe('WorkerEngine (task 5.1)', () => {
  it('probes, creates, templates and generates through the Worker, tokens as they come', async () => {
    const library = new FakeGeniexLibrary()
    const worker = new FakeGeniexWorker(library)
    const engine = new WorkerEngine(worker)
    expect(await engine.probe('/b/lib')).toEqual({
      version: '0.9.3',
      abi: 1,
      plugins: ['llama_cpp', 'qairt'],
      devices: ['HTP0', 'GPUOpenCL', 'CPU'],
    })
    expect(await engine.create('/b/lib', SETTINGS)).toEqual({ vision: false })
    const prompt = await engine.applyChatTemplate({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: null,
      enableThinking: false,
    })
    expect(prompt).toMatch(/^TEMPLATE /)
    const tokens: string[] = []
    const result = await engine.generate(
      prompt,
      CONFIG,
      (token) => tokens.push(token),
      new Int32Array(new SharedArrayBuffer(4))
    )
    expect(tokens).toEqual(['Hello', ' world', '!'])
    expect(result).toMatchObject({ stopReason: 'eos', generatedTokens: 3 })
    await engine.destroy()
    expect(worker.terminated).toBe(true)
    expect(library.closed).toBe(true)
  })

  it('answers the library refusals as GeniexLibraryError with the stage and code, and runs requests one after another', async () => {
    const library = new FakeGeniexLibrary()
    library.createFailure = { message: 'Model loading failed', code: -100201 }
    const engine = new WorkerEngine(new FakeGeniexWorker(library))
    await expect(engine.create('/b/lib', SETTINGS)).rejects.toMatchObject({
      name: 'GeniexLibraryError',
      operation: 'call',
      code: -100201,
    })
    library.createFailure = null
    const first = engine.create('/b/lib', SETTINGS)
    const second = engine.applyChatTemplate({ messages: [], tools: null, enableThinking: false })
    expect(await first).toEqual({ vision: false })
    expect(await second).toMatch(/^TEMPLATE/)
    await expect(engine.generate('P', CONFIG, () => {}, new Int32Array(4))).rejects.toBeInstanceOf(
      GeniexLibraryError
    )
  })

  it('rejects what was pending when the Worker dies, and everything after', async () => {
    const worker = new FakeGeniexWorker(new FakeGeniexLibrary())
    const engine = new WorkerEngine(worker)
    worker.crashOnNext = 'segmentation fault'
    await expect(engine.probe('/b/lib')).rejects.toBeInstanceOf(GeniexWorkerGone)
    await expect(engine.probe('/b/lib')).rejects.toMatchObject({
      message: expect.stringContaining('segmentation fault'),
    })
    await engine.destroy()
    expect(worker.terminated).toBe(true)
  })
})
