import { describe, expect, it } from 'vitest'
import { sampleAudioSpec } from '../../test/helpers/audio-fixtures.js'
import { buildAudioRecipe, parseAudioRecipe, serializeAudioRecipe } from './recipe.js'

const speech = buildAudioRecipe({
  jobId: 'a'.repeat(32),
  request: {
    text: 'Hello',
    voice: 'af_heart',
    speed: 1.2,
    language: 'en-us',
    voiceRef: { base64: '' },
    lyrics: 'ignored for speech',
    durationSec: 9,
  },
  spec: sampleAudioSpec(),
  seed: 42,
  options: { temperature: 0.5 },
  createdAtMs: 10,
  durationMs: 250,
})

describe('buildAudioRecipe', () => {
  it('keeps the speech fields of a speech job and nulls the music ones', () => {
    expect(speech).toEqual({
      jobId: 'a'.repeat(32),
      mode: 'speech',
      text: 'Hello',
      voice: 'af_heart',
      voiceRef: true,
      speed: 1.2,
      language: 'en-us',
      instruct: null,
      lyrics: null,
      durationSec: null,
      bpm: null,
      seed: 42,
      steps: null,
      negativePrompt: null,
      options: { temperature: 0.5 },
      model: {
        modelId: 'kokoro-82m:q8_0',
        family: 'kokoro_tts',
        task: 'tts',
        displayName: 'Kokoro 82M',
        filename: 'kokoro-82m-q8_0.gguf',
      },
      engine: { kind: 'audio-cpp', backend: 'metal', tag: 'v0.9.3-a1b2c3d4' },
      createdAtMs: 10,
      durationMs: 250,
    })
  })

  it('keeps the music fields of a music job and nulls the speech ones', () => {
    const recipe = buildAudioRecipe({
      jobId: 'b'.repeat(32),
      request: {
        text: 'synthwave',
        voice: 'x',
        lyrics: 'la',
        durationSec: 30,
        bpm: 120,
        steps: 8,
        negativePrompt: 'n',
      },
      spec: sampleAudioSpec({ mode: 'music', family: 'ace_step', task: 'gen', modelPath: 'C:\\m\\ace.gguf' }),
      seed: 1,
      options: {},
      createdAtMs: 1,
      durationMs: 2,
    })
    expect(recipe).toMatchObject({
      voice: null,
      voiceRef: false,
      lyrics: 'la',
      durationSec: 30,
      bpm: 120,
      steps: 8,
      negativePrompt: 'n',
      model: { filename: 'ace.gguf', task: 'gen' },
    })
  })
})

describe('parseAudioRecipe', () => {
  it('round-trips through the sidecar text, two-space indented with every key', () => {
    const text = serializeAudioRecipe(speech)
    expect(text).toContain('\n  "instruct": null,\n')
    expect(parseAudioRecipe(text)).toEqual(speech)
  })

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['a missing seed', JSON.stringify({ ...speech, seed: undefined })],
    ['an unknown mode', JSON.stringify({ ...speech, mode: 'podcast' })],
    ['another engine', JSON.stringify({ ...speech, engine: { ...speech.engine, kind: 'sd-cpp' } })],
    ['an unknown backend', JSON.stringify({ ...speech, engine: { ...speech.engine, backend: 'rocm' } })],
    ['an option that is an object', JSON.stringify({ ...speech, options: { a: {} } })],
    ['a model without a task', JSON.stringify({ ...speech, model: { ...speech.model, task: 'stt' } })],
    ['a string speed', JSON.stringify({ ...speech, speed: '1' })],
  ])('refuses %s', (_name, text) => {
    expect(parseAudioRecipe(text)).toBeUndefined()
  })
})
