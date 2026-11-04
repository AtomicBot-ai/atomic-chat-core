import { describe, expect, it } from 'vitest'
import { FakeGeniexLibrary } from '../../../../test/helpers/fake-geniex-library.js'
import { GeniexLibraryError } from './library.js'
import type { GeniexModelSettings } from './library.js'
import { createGeniexWorkerHandler } from './worker-protocol.js'
import type { GeniexWorkerAnswer } from './worker-protocol.js'

const SETTINGS: GeniexModelSettings = {
  plugin: 'llama_cpp',
  device: 'npu',
  model: '/m/qwen3.gguf',
  mmproj: null,
  nCtx: 4096,
  threads: 0,
  powerMode: 'burst',
}
const CONFIG = { maxTokens: 64, stop: [], sampler: { grammar: null }, imagePaths: [] }

function harness(library = new FakeGeniexLibrary(), loadError?: string) {
  const answers: GeniexWorkerAnswer[] = []
  const loads: string[] = []
  const handle = createGeniexWorkerHandler({
    loadLibrary: async (libDir) => {
      loads.push(libDir)
      if (loadError) throw new GeniexLibraryError('load', loadError)
      return library
    },
    post: (answer) => answers.push(answer),
  })
  return { handle, answers, loads, library }
}

describe('geniex-host Worker protocol (task 5.1)', () => {
  it('probe loads the library once and answers its version, ABI, plugins and the llama_cpp devices', async () => {
    const h = harness()
    await h.handle({ type: 'probe', libDir: '/b/lib' })
    await h.handle({ type: 'probe', libDir: '/b/lib' })
    expect(h.loads).toEqual(['/b/lib'])
    expect(h.answers).toEqual([
      {
        type: 'probed',
        version: '0.9.3',
        abi: 1,
        plugins: ['llama_cpp', 'qairt'],
        devices: ['HTP0', 'GPUOpenCL', 'CPU'],
      },
      {
        type: 'probed',
        version: '0.9.3',
        abi: 1,
        plugins: ['llama_cpp', 'qairt'],
        devices: ['HTP0', 'GPUOpenCL', 'CPU'],
      },
    ])
  })

  it('says the library did not load, with the loader message, and whether a create was refused', async () => {
    const h = harness(new FakeGeniexLibrary(), 'LoadLibraryW geniex.dll: error 126')
    await h.handle({ type: 'probe', libDir: '/b/lib' })
    expect(h.answers).toEqual([
      { type: 'failed', stage: 'load', message: 'load: LoadLibraryW geniex.dll: error 126', code: null },
    ])
    const refused = harness()
    refused.library.createFailure = { message: 'Model loading failed', code: -100201 }
    await refused.handle({ type: 'create', libDir: '/b/lib', settings: SETTINGS })
    expect(refused.answers).toEqual([
      { type: 'failed', stage: 'call', message: 'llm_create: Model loading failed', code: -100201 },
    ])
  })

  it('creates the model, applies the chat template and streams a generation token by token, then done', async () => {
    const h = harness()
    await h.handle({ type: 'create', libDir: '/b/lib', settings: SETTINGS })
    expect(h.answers).toEqual([{ type: 'created', vision: false }])
    expect(h.library.models[0]?.settings).toEqual(SETTINGS)
    const input = {
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      tools: null,
      enableThinking: false,
    }
    await h.handle({ type: 'template', id: 1, input })
    expect(h.answers.at(-1)).toEqual({
      type: 'templated',
      id: 1,
      prompt: `TEMPLATE ${JSON.stringify(input)}`,
    })
    await h.handle({ type: 'generate', id: 2, prompt: 'P', config: CONFIG, cancel: new SharedArrayBuffer(4) })
    expect(h.answers.slice(2)).toEqual([
      { type: 'token', id: 2, text: 'Hello' },
      { type: 'token', id: 2, text: ' world' },
      { type: 'token', id: 2, text: '!' },
      { type: 'done', id: 2, result: { stopReason: 'eos', promptTokens: 1, generatedTokens: 3 } },
    ])
  })

  it('stops the generation when the shared flag is set, answering done with cancelled', async () => {
    const h = harness()
    const cancel = new SharedArrayBuffer(4)
    h.library.script = (_prompt, _config, model) => {
      // Set from "the main thread" after the second token.
      void model
      return ['a', 'b', 'c', 'd']
    }
    await h.handle({ type: 'create', libDir: '/b/lib', settings: SETTINGS })
    const flag = new Int32Array(cancel)
    const original = h.library.models[0]?.generate.bind(h.library.models[0])
    h.library.models[0]!.generate = (prompt, config, onToken) =>
      original!(prompt, config, (token) => {
        const go = onToken(token)
        if (token === 'b') Atomics.store(flag, 0, 1)
        return go
      })
    await h.handle({ type: 'generate', id: 3, prompt: 'P', config: CONFIG, cancel })
    expect(h.answers.slice(1)).toEqual([
      { type: 'token', id: 3, text: 'a' },
      { type: 'token', id: 3, text: 'b' },
      { type: 'done', id: 3, result: { stopReason: 'cancelled', promptTokens: 0, generatedTokens: 0 } },
    ])
  })

  it('reports a generation the library refused as an error with its code, and a template or generation without a model', async () => {
    const h = harness()
    await h.handle({ type: 'generate', id: 1, prompt: 'P', config: CONFIG, cancel: new SharedArrayBuffer(4) })
    expect(h.answers).toEqual([{ type: 'error', id: 1, message: 'no model', code: null }])
    await h.handle({ type: 'create', libDir: '/b/lib', settings: SETTINGS })
    h.library.script = () => ({ error: 'Input prompt too long', code: -200103 })
    await h.handle({ type: 'generate', id: 2, prompt: 'P', config: CONFIG, cancel: new SharedArrayBuffer(4) })
    expect(h.answers.at(-1)).toEqual({
      type: 'error',
      id: 2,
      message: 'llm_generate: Input prompt too long',
      code: -200103,
    })
  })

  it('destroy frees the model and the library and answers destroyed', async () => {
    const h = harness()
    await h.handle({ type: 'create', libDir: '/b/lib', settings: { ...SETTINGS, mmproj: '/m/mmproj.gguf' } })
    expect(h.answers).toEqual([{ type: 'created', vision: true }])
    await h.handle({ type: 'destroy' })
    expect(h.answers.at(-1)).toEqual({ type: 'destroyed' })
    expect(h.library.models[0]?.destroyed).toBe(true)
    expect(h.library.closed).toBe(true)
  })
})
