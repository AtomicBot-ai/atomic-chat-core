import { describe, expect, it } from 'vitest'
import { buildSpeechBody, buildTaskBody, decodeTaskAudio, extraOptions } from './request.js'

describe('extraOptions', () => {
  it.each([
    [
      'speech: a named field wins over its option, the seed always',
      'speech' as const,
      {
        text: 't',
        voice: 'a',
        language: 'en',
        options: { voice_id: 'b', language: 'fr', seed: 1, temperature: 0.5 },
      },
      { temperature: 0.5 },
    ],
    [
      'speech: an option without its named field stays',
      'speech' as const,
      { text: 't', options: { language: 'fr', speed: 1.2 } },
      { language: 'fr', speed: 1.2 },
    ],
    [
      'music: steps, duration, lyrics, bpm, negative prompt',
      'music' as const,
      {
        text: 't',
        steps: 8,
        durationSec: 30,
        lyrics: 'la',
        bpm: 120,
        negativePrompt: 'noise',
        options: {
          num_inference_steps: 4,
          duration_sec: 10,
          lyrics: 'x',
          bpm: 90,
          negative_prompt: 'y',
          guidance_scale: 3,
        },
      },
      { guidance_scale: 3 },
    ],
    ['no options', 'effects' as const, { text: 't' }, {}],
  ])('%s', (_name, mode, request, expected) => {
    expect(extraOptions(mode, request)).toEqual(expected)
  })
})

describe('buildSpeechBody', () => {
  it('sends only what the request sets, the seed always', () => {
    expect(buildSpeechBody('kokoro', { text: 'Hello' }, 7)).toEqual({
      model: 'kokoro',
      input: 'Hello',
      seed: 7,
    })
  })

  it('carries every speech field, the reference voice as base64 and the instruction as the instruct option', () => {
    expect(
      buildSpeechBody(
        'qwen',
        {
          text: 'Привет',
          voice: 'ryan',
          speed: 1.1,
          language: 'ru',
          instruct: 'whisper',
          referenceText: 'the reference words',
          voiceRef: { path: '/ref.wav' },
          options: { temperature: 0.7, instruct: 'shout' },
        },
        42,
        'UklGRg=='
      )
    ).toEqual({
      model: 'qwen',
      input: 'Привет',
      seed: 42,
      voice: 'ryan',
      speed: 1.1,
      language: 'ru',
      voice_ref: { type: 'base64', data: 'UklGRg==' },
      reference_text: 'the reference words',
      options: { temperature: 0.7, instruct: 'whisper' },
    })
  })
})

describe('buildTaskBody', () => {
  it('puts the seed and the named fields into the options, over the request options', () => {
    expect(
      buildTaskBody(
        'ace',
        {
          text: 'synthwave',
          lyrics: '[verse] la',
          durationSec: -1,
          bpm: 120,
          steps: 8,
          options: { bpm: 90, shift: 3, seed: 1 },
        },
        5
      )
    ).toEqual({
      model: 'ace',
      request: {
        text: 'synthwave',
        options: {
          shift: 3,
          seed: 5,
          duration_sec: -1,
          lyrics: '[verse] la',
          bpm: 120,
          num_inference_steps: 8,
        },
      },
    })
  })

  it('sends an effect with the negative prompt', () => {
    expect(buildTaskBody('sfx', { text: 'door slam', durationSec: 5, negativePrompt: 'music' }, 3)).toEqual({
      model: 'sfx',
      request: { text: 'door slam', options: { seed: 3, duration_sec: 5, negative_prompt: 'music' } },
    })
  })
})

describe('decodeTaskAudio', () => {
  it('reads the base64 WAV and ignores its duplicate', () => {
    const wav = Buffer.from('RIFF....WAVE')
    const body = { audio: wav.toString('base64'), named_audio_outputs: [{ id: 7, audio: 'ignored' }] }
    expect(decodeTaskAudio(Buffer.from(JSON.stringify(body)))).toEqual(wav)
  })

  it.each([
    ['not JSON', 'nope', 'not JSON'],
    ['no audio', '{"sample_rate":44100}', 'without audio'],
    ['empty audio', '{"audio":""}', 'without audio'],
  ])('refuses %s', (_name, text, message) => {
    expect(() => decodeTaskAudio(Buffer.from(text))).toThrow(message)
  })
})
