import { describe, expect, it } from 'vitest'
import type { AtomicCoreError } from '../contracts/index.js'
import {
  parseAudioConfig,
  parseAudioGalleryListOptions,
  parseAudioGenerateRequest,
  parseAudioJobSubmission,
  parseAudioMode,
  parseLoadAudioModelRequest,
  requireAudioString,
} from './parse.js'

const refusal = (work: () => unknown): AtomicCoreError => {
  try {
    work()
  } catch (error) {
    return error as AtomicCoreError
  }
  throw new Error('expected a refusal')
}

describe('parseAudioMode', () => {
  it('takes the three modes only', () => {
    expect(parseAudioMode('effects')).toBe('effects')
    expect(refusal(() => parseAudioMode('podcast'))).toMatchObject({
      code: 'INVALID_REQUEST',
      details: 'mode: expected one of speech, music, effects',
    })
  })
})

describe('parseAudioConfig', () => {
  it.each([
    [{}, {}],
    [
      { outputDir: '/sounds', idleUnloadSecs: 0 },
      { outputDir: '/sounds', idleUnloadSecs: 0 },
    ],
    [{ outputDir: null, idleUnloadSecs: null, extra: 1 }, { outputDir: null }],
  ])('%j → %j', (body, expected) => {
    expect(parseAudioConfig(body)).toEqual(expected)
  })

  it.each([
    [{ outputDir: 3 }, 'outputDir: expected a string'],
    [{ idleUnloadSecs: -1 }, 'idleUnloadSecs: expected a whole number, zero or more'],
    [[], 'config: expected an object'],
  ])('refuses %j', (body, details) => {
    expect(refusal(() => parseAudioConfig(body))).toMatchObject({ code: 'INVALID_REQUEST', details })
  })
})

describe('parseLoadAudioModelRequest', () => {
  const base = {
    modelId: 'kokoro-82m:q8_0',
    displayName: 'Kokoro 82M',
    mode: 'speech',
    file: 'kokoro/k.gguf',
    family: 'kokoro_tts',
    task: 'tts',
  }

  it('reads the required fields and the optional ones, null as absent', () => {
    expect(parseLoadAudioModelRequest({ ...base, threads: null, unknown: true })).toEqual(base)
    expect(
      parseLoadAudioModelRequest({
        ...base,
        loadOptions: { a: 1 },
        sessionOptions: { 'kokoro.x': true },
        defaultRequestOptions: { speed: 1.1 },
        defaultVoice: 'af_heart',
        threads: 4,
        startupTimeoutSecs: 30,
      })
    ).toEqual({
      ...base,
      loadOptions: { a: 1 },
      sessionOptions: { 'kokoro.x': true },
      defaultRequestOptions: { speed: 1.1 },
      defaultVoice: 'af_heart',
      threads: 4,
      startupTimeoutSecs: 30,
    })
  })

  it.each([
    [{ ...base, modelId: ' ' }, 'modelId: expected a non-empty string'],
    [{ ...base, task: 'stt' }, 'task: expected one of tts, gen'],
    [{ ...base, mode: 'radio' }, 'mode: expected one of speech, music, effects'],
    [{ ...base, loadOptions: { a: [] } }, 'loadOptions.a: expected a string, a number or true/false'],
    [{ ...base, threads: 0 }, 'threads: expected a whole number above zero'],
    [{ ...base, file: undefined }, 'file: expected a non-empty string'],
  ])('refuses %j', (body, details) => {
    expect(refusal(() => parseLoadAudioModelRequest(body))).toMatchObject({
      code: 'INVALID_REQUEST',
      details,
    })
  })
})

describe('parseAudioGenerateRequest', () => {
  it('reads every field of the wire type', () => {
    const full = {
      text: 'Hi',
      voice: 'af_heart',
      voiceRef: { base64: 'UklGRg==' },
      referenceText: 'ref',
      speed: 1.1,
      language: 'en',
      instruct: 'calm',
      lyrics: 'la',
      durationSec: -1,
      bpm: 120,
      seed: -1,
      steps: 8,
      negativePrompt: 'noise',
      options: { temperature: 0.5 },
    }
    expect(parseAudioGenerateRequest(full)).toEqual(full)
    expect(parseAudioGenerateRequest({ text: 'x', voiceRef: { path: '/r.wav' }, voice: null })).toEqual({
      text: 'x',
      voiceRef: { path: '/r.wav' },
    })
  })

  it.each([
    [{ text: '' }, 'text: expected a non-empty string'],
    [{ text: 'x', voiceRef: {} }, 'voiceRef: expected either a path or base64'],
    [{ text: 'x', voiceRef: { path: '/a', base64: 'b' } }, 'voiceRef: expected either a path or base64'],
    [{ text: 'x', voiceRef: { path: '' } }, 'voiceRef.path: expected a non-empty string'],
    [{ text: 'x', speed: 0 }, 'speed: expected a number above zero'],
    [{ text: 'x', durationSec: Number.NaN }, 'durationSec: expected a number'],
    [{ text: 'x', seed: 1.5 }, 'seed: expected a whole number'],
    [{ text: 'x', steps: -2 }, 'steps: expected a whole number above zero'],
  ])('refuses %j', (body, details) => {
    expect(refusal(() => parseAudioGenerateRequest(body))).toMatchObject({ code: 'INVALID_REQUEST', details })
  })
})

describe('parseAudioJobSubmission', () => {
  it('reads the mode and the request', () => {
    expect(parseAudioJobSubmission({ mode: 'music', request: { text: 'synthwave' } })).toEqual({
      mode: 'music',
      request: { text: 'synthwave' },
    })
    expect(refusal(() => parseAudioJobSubmission({ mode: 'music' }))).toMatchObject({
      details: 'request: expected an object',
    })
  })
})

describe('parseAudioGalleryListOptions', () => {
  it('takes whole numbers', () => {
    expect(parseAudioGalleryListOptions({ offset: 0, limit: 20 })).toEqual({ offset: 0, limit: 20 })
    expect(refusal(() => parseAudioGalleryListOptions({ offset: Number.NaN, limit: 1 }))).toMatchObject({
      details: 'offset: expected a whole number, zero or more',
    })
  })
})

describe('requireAudioString', () => {
  it('reads one string out of a body', () => {
    expect(requireAudioString({ relativePath: 'a/b.gguf' }, 'relativePath')).toBe('a/b.gguf')
    expect(refusal(() => requireAudioString({}, 'path'))).toMatchObject({
      details: 'path: expected a string',
    })
  })
})
