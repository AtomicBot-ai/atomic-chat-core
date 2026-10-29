import { describe, expect, it } from 'vitest'
import {
  audioCrashError,
  audioEarlyExitError,
  describeAudioExit,
  engineErrorMessage,
  engineRejection,
  exitedOnTakenAudioPort,
  readModelFact,
} from './output.js'
import type { AudioModelFacts } from './output.js'

describe('readModelFact', () => {
  it('folds the loader traces of the real server into the facts and ignores the rest', () => {
    const facts: AudioModelFacts = {}
    for (const line of [
      '[TRACE ts=20261029-144906] runtime.model.family qwen3_tts',
      '[TRACE ts=20261029-144906] runtime.model.variant 0b6-base',
      '[TRACE ts=20261029-144906] runtime.model.supports_speaker_reference 1',
      '[TRACE ts=20261029-144906] runtime.model.supports_style_condition 0',
      'ggml_metal_init: found device: Apple M4 Pro',
    ])
      readModelFact(facts, line)
    expect(facts).toEqual({ variant: '0b6-base', supportsSpeakerReference: true })
    readModelFact(facts, '[TRACE ts=1] runtime.model.variant Kokoro 82M')
    readModelFact(facts, '[TRACE ts=1] runtime.model.supports_speaker_reference 0')
    expect(facts).toEqual({ variant: 'Kokoro 82M', supportsSpeakerReference: false })
  })
})

describe('exitedOnTakenAudioPort', () => {
  it.each([
    ['audiocpp_server failed: could not bind 127.0.0.1:18752', true],
    ['listen EADDRINUSE: address already in use', true],
    ['audiocpp_server failed: model path does not exist: /m.gguf', false],
    [undefined, false],
  ])('%j → %s', (details, expected) => {
    expect(exitedOnTakenAudioPort(details)).toBe(expected)
  })
})

describe('describeAudioExit', () => {
  it.each([
    [{ code: 1, signal: null }, 'code 1'],
    [{ code: null, signal: 'SIGKILL' }, 'signal SIGKILL'],
    [{ code: null, signal: null }, 'unknown status'],
  ])('%j → %s', (exit, expected) => {
    expect(describeAudioExit(exit)).toBe(expected)
  })
})

describe('audioEarlyExitError', () => {
  it('names the load failure with the marked lines first', () => {
    const error = audioEarlyExitError({ code: 1, signal: null }, [
      '[TRACE ts=1] server.model.id x',
      'audiocpp_server failed: model path does not exist: /nonexistent/k.gguf',
    ])
    expect(error.code).toBe('MODEL_LOAD_FAILED')
    expect(error.message).toBe('audiocpp_server exited with code 1 while loading.')
    expect(error.details).toContain('model path does not exist')
  })

  it.each([
    ['a CUDA allocation', { code: 1, signal: null }, ['cudaMalloc failed: out of memory']],
    [
      'a Metal buffer',
      { code: 1, signal: null },
      ['ggml_backend_metal_buffer_type_alloc_buffer: error: failed to allocate buffer'],
    ],
    [
      'a Vulkan allocation',
      { code: 1, signal: null },
      ['vk::Device::allocateMemory: ErrorOutOfDeviceMemory'],
    ],
    ['the OOM killer', { code: null, signal: 'SIGKILL' }, []],
    ['the OOM killer by number', { code: null, signal: 9 }, []],
  ])('reads %s as out of memory', (_name, exit, lines) => {
    expect(audioEarlyExitError(exit, lines).code).toBe('OUT_OF_MEMORY')
  })
})

describe('audioCrashError', () => {
  it('is a crash with the engine lines, or out of memory when ggml said so', () => {
    const crash = audioCrashError({ code: 134, signal: null }, ['GGML_ASSERT(x) failed'])
    expect(crash).toMatchObject({ code: 'ENGINE_CRASHED', details: 'GGML_ASSERT(x) failed' })
    expect(crash.message).toContain('code 134')
    expect(audioCrashError({ code: 1, signal: null }, ['failed to allocate buffer']).code).toBe(
      'OUT_OF_MEMORY'
    )
  })
})

describe('engineErrorMessage', () => {
  it.each([
    ['{"error":{"message":"unknown model id: nope","type":"server_error"}}', 'unknown model id: nope'],
    ['{"error":"plain"}', 'plain'],
    ['{"message":"top"}', 'top'],
    ['  not json  ', 'not json'],
    ['{"error":{"type":"x"}}', '{"error":{"type":"x"}}'],
  ])('%j → %j', (body, expected) => {
    expect(engineErrorMessage(body)).toBe(expected)
  })

  it('keeps at most 1000 characters', () => {
    expect(engineErrorMessage('x'.repeat(5000))).toHaveLength(1000)
  })
})

describe('engineRejection', () => {
  it('is a rejection in the engine words, or out of memory', () => {
    expect(
      engineRejection(500, '{"error":{"message":"Qwen3 base TTS requires voice clone reference audio"}}')
    ).toMatchObject({
      code: 'REQUEST_REJECTED',
      details: 'Qwen3 base TTS requires voice clone reference audio',
    })
    expect(engineRejection(400, '')).toMatchObject({ code: 'REQUEST_REJECTED', details: 'HTTP 400' })
    expect(engineRejection(500, '{"error":{"message":"failed to allocate compute buffer"}}').code).toBe(
      'OUT_OF_MEMORY'
    )
  })
})
