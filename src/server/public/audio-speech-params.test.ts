import { describe, expect, it } from 'vitest'
import type { AudioErrorCode } from '../../contracts/index.js'
import { AUDIO_ERROR_CODES } from '../../contracts/index.js'
import {
  buildSpeechRequest,
  MAX_SPEECH_INPUT_CHARS,
  mapSpeechError,
  parseSpeechParams,
  SPEECH_CONTENT_TYPES,
  wavPcmData,
} from './audio-speech-params.js'
import { ParamError } from './images-params.js'

const refusal = (run: () => unknown): ParamError => {
  try {
    run()
  } catch (e) {
    expect(e).toBeInstanceOf(ParamError)
    return e as ParamError
  }
  throw new Error('expected a refusal')
}

/** A RIFF/WAVE of `chunks` after the header. */
function riff(...chunks: Buffer[]): Buffer {
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(12)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(4 + body.length, 4)
  head.write('WAVE', 8, 'latin1')
  return Buffer.concat([head, body])
}

function chunk(id: string, data: Buffer, size = data.length): Buffer {
  const head = Buffer.alloc(8)
  head.write(id, 0, 'latin1')
  head.writeUInt32LE(size, 4)
  return Buffer.concat([head, data, data.length % 2 === 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

function fmt(tag: number, channels: number, sampleRate: number, bits: number, size = 16): Buffer {
  const data = Buffer.alloc(size)
  data.writeUInt16LE(tag, 0)
  data.writeUInt16LE(channels, 2)
  data.writeUInt32LE(sampleRate, 4)
  data.writeUInt32LE((sampleRate * channels * bits) / 8, 8)
  data.writeUInt16LE((channels * bits) / 8, 12)
  data.writeUInt16LE(bits, 14)
  return chunk('fmt ', data)
}

const SAMPLES = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])

describe('parseSpeechParams', () => {
  it('takes the OpenAI body with audio.cpp extras, and ignores what it does not know', () => {
    expect(parseSpeechParams({ input: ' Hello ' })).toEqual({ input: 'Hello', format: 'wav' })
    expect(
      parseSpeechParams({
        model: ' kokoro-82m:q8_0 ',
        input: 'Hello',
        voice: 'am_adam',
        speed: 1.5,
        instructions: 'Calm',
        response_format: 'pcm',
        stream_format: 'audio',
        seed: 11,
        language: 'en',
        voice_ref: 'ignored',
        temperature: 2,
      })
    ).toEqual({
      model: 'kokoro-82m:q8_0',
      input: 'Hello',
      voice: 'am_adam',
      speed: 1.5,
      instructions: 'Calm',
      format: 'pcm',
      seed: 11,
      language: 'en',
    })
    // Blank and null optional fields are absent.
    expect(
      parseSpeechParams({
        input: 'x',
        model: ' ',
        voice: '',
        instructions: null,
        language: '  ',
        speed: null,
        seed: null,
        response_format: null,
        stream_format: null,
      })
    ).toEqual({ input: 'x', format: 'wav' })
    // OpenAI's names reach the engine as they are.
    expect(parseSpeechParams({ input: 'x', voice: 'alloy' }).voice).toBe('alloy')
  })

  it('counts characters, not UTF-16 units, against the input limit', () => {
    expect(parseSpeechParams({ input: 'a'.repeat(MAX_SPEECH_INPUT_CHARS) }).input).toHaveLength(4096)
    expect(parseSpeechParams({ input: '😀'.repeat(MAX_SPEECH_INPUT_CHARS) }).input).toHaveLength(8192)
    expect(refusal(() => parseSpeechParams({ input: 'a'.repeat(4097) })).message).toBe(
      'input must be at most 4096 characters'
    )
    expect(refusal(() => parseSpeechParams({ input: '😀'.repeat(4097) })).param).toBe('input')
  })

  it.each([
    ['a list', [], 'body', 'request body must be a JSON object'],
    ['null', null, 'body', 'request body must be a JSON object'],
    ['no input', {}, 'input', 'input is required'],
    ['blank input', { input: '  ' }, 'input', 'input is required'],
    ['input not a string', { input: 7 }, 'input', 'input is required'],
    [
      'mp3',
      { input: 'x', response_format: 'mp3' },
      'response_format',
      "response_format 'mp3' is not supported by the local engine; use 'wav' or 'pcm'",
    ],
    [
      'opus',
      { input: 'x', response_format: 'opus' },
      'response_format',
      "response_format 'opus' is not supported by the local engine; use 'wav' or 'pcm'",
    ],
    [
      'aac',
      { input: 'x', response_format: 'aac' },
      'response_format',
      "response_format 'aac' is not supported by the local engine; use 'wav' or 'pcm'",
    ],
    [
      'flac',
      { input: 'x', response_format: 'flac' },
      'response_format',
      "response_format 'flac' is not supported by the local engine; use 'wav' or 'pcm'",
    ],
    [
      'an unknown format',
      { input: 'x', response_format: 'ogg' },
      'response_format',
      'response_format must be one of mp3, opus, aac, flac, wav, pcm',
    ],
    [
      'a format not a string',
      { input: 'x', response_format: 1 },
      'response_format',
      'response_format must be a string',
    ],
    [
      'sse',
      { input: 'x', stream_format: 'sse' },
      'stream_format',
      "stream_format 'sse' is not supported by the local server; leave it out or use 'audio'",
    ],
    [
      'an unknown stream format',
      { input: 'x', stream_format: 'chunks' },
      'stream_format',
      "stream_format must be 'audio' or 'sse'",
    ],
    ['a slow speed', { input: 'x', speed: 0.2 }, 'speed', 'speed must be a number between 0.25 and 4'],
    ['a fast speed', { input: 'x', speed: 4.5 }, 'speed', 'speed must be a number between 0.25 and 4'],
    [
      'a speed not a number',
      { input: 'x', speed: '1' },
      'speed',
      'speed must be a number between 0.25 and 4',
    ],
    [
      'an infinite speed',
      { input: 'x', speed: Infinity },
      'speed',
      'speed must be a number between 0.25 and 4',
    ],
    ['a fractional seed', { input: 'x', seed: 1.5 }, 'seed', 'seed must be an integer'],
    ['a seed not a number', { input: 'x', seed: '7' }, 'seed', 'seed must be an integer'],
    ['a model not a string', { input: 'x', model: 3 }, 'model', 'model must be a string'],
    ['a voice object', { input: 'x', voice: { id: 'v' } }, 'voice', 'voice must be a string'],
    [
      'instructions not a string',
      { input: 'x', instructions: [] },
      'instructions',
      'instructions must be a string',
    ],
    ['a language not a string', { input: 'x', language: 1 }, 'language', 'language must be a string'],
  ])('refuses %s', (_name, body, param, message) => {
    const error = refusal(() => parseSpeechParams(body))
    expect([error.param, error.message]).toEqual([param, message])
  })

  it('takes the speed bounds themselves', () => {
    expect(parseSpeechParams({ input: 'x', speed: 0.25 }).speed).toBe(0.25)
    expect(parseSpeechParams({ input: 'x', speed: 4 }).speed).toBe(4)
  })
})

describe('buildSpeechRequest', () => {
  it.each([
    ['the words alone', { input: 'Hi', format: 'wav' as const }, { text: 'Hi' }],
    [
      'every field',
      {
        input: 'Hi',
        voice: 'ryan',
        speed: 1.25,
        instructions: 'Whisper',
        language: 'en',
        seed: 3,
        model: 'm',
        format: 'pcm' as const,
      },
      { text: 'Hi', voice: 'ryan', speed: 1.25, instruct: 'Whisper', language: 'en', seed: 3 },
    ],
    ["OpenAI's default speed left out", { input: 'Hi', speed: 1, format: 'wav' as const }, { text: 'Hi' }],
  ])('binds %s', (_name, params, request) => {
    expect(buildSpeechRequest(params)).toEqual(request)
  })
})

describe('wavPcmData', () => {
  it('strips the header of a 16-bit PCM WAV, past other chunks', () => {
    expect(wavPcmData(riff(fmt(1, 1, 24000, 16), chunk('data', SAMPLES)))).toEqual({
      pcm: SAMPLES,
      sampleRate: 24000,
      channels: 1,
    })
    const odd = riff(chunk('LIST', Buffer.from('abc')), fmt(0xfffe, 2, 44100, 16, 40), chunk('data', SAMPLES))
    expect(wavPcmData(odd)).toEqual({ pcm: SAMPLES, sampleRate: 44100, channels: 2 })
  })

  it('reads a streamed or cut data chunk to the end of the file', () => {
    expect(wavPcmData(riff(fmt(1, 1, 24000, 16), chunk('data', SAMPLES, 0xffff_ffff)))?.pcm).toEqual(SAMPLES)
    expect(wavPcmData(riff(fmt(1, 1, 24000, 16), chunk('data', SAMPLES, 64)))?.pcm).toEqual(SAMPLES)
  })

  it.each([
    ['too short', Buffer.from('RIFF')],
    ['not RIFF', Buffer.concat([Buffer.from('RIFX'), Buffer.alloc(8)])],
    ['not WAVE', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI ')])],
    ['no data chunk', riff(fmt(1, 1, 24000, 16))],
    ['data before fmt', riff(chunk('data', SAMPLES), fmt(1, 1, 24000, 16))],
    ['a short fmt', riff(chunk('fmt ', Buffer.alloc(8)), chunk('data', SAMPLES))],
    ['a fmt cut by the end of the file', riff(chunk('fmt ', Buffer.alloc(4), 16))],
    ['float samples', riff(fmt(3, 1, 24000, 32), chunk('data', SAMPLES))],
    ['8-bit samples', riff(fmt(1, 1, 24000, 8), chunk('data', SAMPLES))],
    ['no channels', riff(fmt(1, 0, 24000, 16), chunk('data', SAMPLES))],
    ['no sample rate', riff(fmt(1, 1, 0, 16), chunk('data', SAMPLES))],
  ])('refuses %s', (_name, bytes) => {
    expect(wavPcmData(bytes)).toBeUndefined()
  })

  it('names the content type of each format', () => {
    expect(SPEECH_CONTENT_TYPES).toEqual({ wav: 'audio/wav', pcm: 'audio/pcm' })
  })
})

describe('mapSpeechError', () => {
  const table: Record<AudioErrorCode, [number, string, string]> = {
    INVALID_REQUEST: [400, 'invalid_request_error', 'invalid_request'],
    REQUEST_REJECTED: [400, 'invalid_request_error', 'invalid_request'],
    MODEL_NOT_LOADED: [503, 'server_error', 'model_not_loaded'],
    UNSUPPORTED_MODE: [503, 'server_error', 'model_not_loaded'],
    ENGINE_MISSING: [503, 'server_error', 'model_not_loaded'],
    MODEL_MISSING: [503, 'server_error', 'model_not_loaded'],
    JOB_BUSY: [429, 'server_error', 'busy'],
    AUDIO_UNAVAILABLE: [503, 'server_error', 'busy'],
    OUT_OF_MEMORY: [500, 'server_error', 'insufficient_memory'],
    CANCELLED: [500, 'server_error', 'cancelled'],
    ENGINE_INSTALL_FAILED: [500, 'server_error', 'server_error'],
    ENGINE_CRASHED: [500, 'server_error', 'server_error'],
    MODEL_LOAD_FAILED: [500, 'server_error', 'server_error'],
    MODEL_INCOMPATIBLE: [500, 'server_error', 'server_error'],
    UNSUPPORTED_BACKEND: [500, 'server_error', 'server_error'],
    INVALID_OUTPUT: [500, 'server_error', 'server_error'],
    JOB_NOT_FOUND: [500, 'server_error', 'server_error'],
    DISK_FULL: [500, 'server_error', 'server_error'],
    BACKEND_IN_USE: [500, 'server_error', 'server_error'],
    INTERNAL: [500, 'server_error', 'server_error'],
  }

  it('covers every audio error code', () => {
    expect(Object.keys(table).sort()).toEqual([...AUDIO_ERROR_CODES].sort())
  })

  it.each(Object.entries(table))('maps %s to %j', (code, [status, type, mapped]) => {
    expect(mapSpeechError(code as AudioErrorCode)).toEqual({ status, type, code: mapped })
  })
})
