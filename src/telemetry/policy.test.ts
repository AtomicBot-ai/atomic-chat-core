import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../contracts/index.js'
import {
  APP_TAG_KEYS,
  errorCodeOf,
  isCancellation,
  isClientAbort,
  markerLines,
  oomSubtype,
  quantOf,
  sanitizeTags,
} from './policy.js'

describe('sanitizeTags', () => {
  it('keeps valid keys, stringifies scalars and drops the rest', () => {
    expect(
      sanitizeTags({
        'gpu_model': ' Apple M3 Max ',
        'vram_mb': 36864,
        'cpu_avx': true,
        'Bad Key': 'x',
        'empty': '',
        'missing': undefined,
        'nothing': null,
        'nested': { a: 1 },
        'multi': 'a\nb\tc',
      })
    ).toEqual({ gpu_model: 'Apple M3 Max', vram_mb: '36864', cpu_avx: 'true', multi: 'a b c' })
  })

  it('applies an allow-list, scrubs and cuts long values', () => {
    expect(
      sanitizeTags(
        { gpu_model: '/Users/misha/x', os: 'x'.repeat(150), secret_thing: 'no' },
        { allow: APP_TAG_KEYS }
      )
    ).toEqual({ gpu_model: '/Users/<redacted>/x', os: 'x'.repeat(100) })
  })
})

describe('markerLines', () => {
  it('keeps the error lines and drops what may quote the user', () => {
    const stderr = [
      'llama_model_loader: loaded meta data',
      'prompt eval: "tell me about my secret project"',
      'GGML_ASSERT(n_tokens > 0) failed',
      '{"messages":[{"role":"user","content":"error in my code"}]}',
      'ggml_metal_graph_compute: command buffer 0 failed with status 5',
      'error: out of memory at /Users/misha/models/a.gguf',
    ].join('\n')
    expect(markerLines(stderr)).toBe(
      [
        'GGML_ASSERT(n_tokens > 0) failed',
        'ggml_metal_graph_compute: command buffer 0 failed with status 5',
        'error: out of memory at /Users/<redacted>/models/a.gguf',
      ].join('\n')
    )
  })

  it('keeps the newest lines within the caps', () => {
    const many = Array.from({ length: 30 }, (_, i) => `error ${i}`).join('\n')
    const kept = markerLines(many, { maxLines: 3 })
    expect(kept).toBe('error 27\nerror 28\nerror 29')
    expect(markerLines(many, { maxBytes: 10 })).toBe('error 29')
    expect(markerLines(`error ${'x'.repeat(400)}`)?.length).toBe(300)
  })

  it('answers nothing when nothing marks an error', () => {
    expect(markerLines(undefined)).toBeUndefined()
    expect(markerLines('loading model\nready')).toBeUndefined()
  })
})

describe('errorCodeOf / isCancellation / isClientAbort', () => {
  it.each([
    [new AtomicCoreError('OUT_OF_MEMORY', 'x'), 'OUT_OF_MEMORY'],
    [Object.assign(new Error('x'), { code: 'ENOENT' }), 'ENOENT'],
    [Object.assign(new Error('x'), { code: 'lowercase' }), undefined],
    [Object.assign(new Error('x'), { code: 42 }), undefined],
    [null, undefined],
  ])('errorCodeOf(%s) = %s', (error, code) => {
    expect(errorCodeOf(error)).toBe(code)
  })

  it('knows a cancellation', () => {
    expect(isCancellation(new AtomicCoreError('MODEL_LOAD_CANCELLED', 'x'))).toBe(true)
    expect(isCancellation(new AtomicCoreError('CANCELLED', 'x'))).toBe(true)
    expect(isCancellation(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isCancellation(new AtomicCoreError('OUT_OF_MEMORY', 'x'))).toBe(false)
    expect(isCancellation(undefined)).toBe(false)
  })

  it('knows a client that went away', () => {
    expect(isClientAbort(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true)
    expect(isClientAbort(Object.assign(new Error('x'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }))).toBe(true)
    expect(isClientAbort(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true)
    expect(isClientAbort(new TypeError('x is undefined'))).toBe(false)
  })
})

describe('oomSubtype / quantOf', () => {
  it.each([
    ['CUDA error: out of memory', 'cuda'],
    ['vk_error_out_of_device_memory', 'vulkan'],
    ['Insufficient Memory (kIOGPUCommandBufferCallbackErrorOutOfMemory)', 'metal'],
    ['requires more RAM than available', 'host_ram'],
    ['something else', 'unknown'],
  ])('oomSubtype(%s) = %s', (text, subtype) => {
    expect(oomSubtype(text)).toBe(subtype)
  })

  it('reads the quantisation of a model id', () => {
    expect(oomSubtype(undefined)).toBeUndefined()
    expect(quantOf('unsloth/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M')).toBe('Q4_K_M')
    expect(quantOf('mlx-community/Llama-3-8B-4bit')).toBe('4bit')
    expect(quantOf('llama3.2:3b')).toBeUndefined()
    expect(quantOf(undefined)).toBeUndefined()
  })
})
