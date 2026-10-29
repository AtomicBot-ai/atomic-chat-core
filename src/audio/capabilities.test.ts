import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { sampleAudioSpec } from '../../test/helpers/audio-fixtures.js'
import { buildCapabilities, parseModelParam, parseServedModels, parseVoiceList } from './capabilities.js'

const QWEN = JSON.parse(
  readFileSync(new URL('../../test/fixtures/audiocpp/v0.9.3/models-qwen3-tts.json', import.meta.url), 'utf8')
) as unknown

describe('parseModelParam', () => {
  it.each([
    [
      'an enum',
      { name: 'voice_id', type: 'enum', required: false, default: 'a', values: ['a', 'b', 3] },
      { name: 'voice_id', type: 'enum', required: false, default: 'a', values: ['a', 'b'] },
    ],
    [
      'a bounded number',
      { name: 'top_p', type: 'float', required: true, default: 1, min: 0, max: 1, description: 'nucleus' },
      { name: 'top_p', type: 'float', required: true, default: 1, min: 0, max: 1, description: 'nucleus' },
    ],
    ['no type', { name: 'x', default: null, min: 'no' }, { name: 'x', type: 'string', required: false }],
  ])('reads %s', (_name, raw, expected) => {
    expect(parseModelParam(raw)).toEqual(expected)
  })

  it.each([[null], ['x'], [{ type: 'int' }], [{ name: '' }]])('drops %j', (raw) => {
    expect(parseModelParam(raw)).toBeUndefined()
  })
})

describe('parseServedModels', () => {
  it('reads the real Qwen3-TTS listing', () => {
    const [model] = parseServedModels(QWEN)
    expect(model).toMatchObject({ id: 'qwen', family: 'qwen3_tts', task: 'tts', loaded: true })
    expect(model?.params.map((p) => p.name)).toContain('reference_text')
    expect(model?.params.find((p) => p.name === 'voice_id')?.values).toHaveLength(9)
  })

  it('skips what is not a model and answers nothing for what is not a listing', () => {
    expect(parseServedModels({ data: [{ object: 'model' }, 'x', { id: 'm' }] })).toEqual([
      { id: 'm', family: '', task: '', loaded: false, params: [] },
    ])
    expect(parseServedModels({ object: 'list' })).toEqual([])
    expect(parseServedModels(null)).toEqual([])
  })
})

describe('parseVoiceList', () => {
  it.each([
    [{ voices: [] }, []],
    [
      { voices: ['af_heart', 3, { id: 'am_adam' }, { voice_id: 'x' }, { name: 'n' }, {}] },
      ['af_heart', 'am_adam', 'x', 'n'],
    ],
    [{}, []],
    ['x', []],
  ])('%j → %j', (body, expected) => {
    expect(parseVoiceList(body)).toEqual(expected)
  })
})

describe('buildCapabilities', () => {
  const kokoro = sampleAudioSpec()
  const kokoroServed = {
    id: kokoro.modelId,
    family: 'kokoro_tts',
    task: 'tts',
    loaded: true,
    params: [
      { name: 'voice_id', type: 'enum', required: false, values: ['af_heart', 'am_adam'] },
      { name: 'seed', type: 'int', required: false },
    ],
  }

  it('lists built-in voices of a speech model without voice cloning', () => {
    expect(
      buildCapabilities(kokoro, kokoroServed, { variant: 'Kokoro 82M', supportsSpeakerReference: false })
    ).toEqual({
      modelId: 'kokoro-82m:q8_0',
      mode: 'speech',
      family: 'kokoro_tts',
      task: 'tts',
      params: kokoroServed.params,
      voices: ['af_heart', 'am_adam'],
      supportsVoiceRef: false,
      requiresVoiceRef: false,
    })
  })

  it('takes the voice list route when the declaration has no values', () => {
    const served = { ...kokoroServed, params: [{ name: 'voice_id', type: 'string', required: false }] }
    expect(buildCapabilities(kokoro, served, {}, ['v1']).voices).toEqual(['v1'])
  })

  it('makes Qwen3-TTS Base clone-only: no built-in voices, a reference required', () => {
    const spec = sampleAudioSpec({ modelId: 'qwen', family: 'qwen3_tts' })
    const [served] = parseServedModels(QWEN)
    const base = buildCapabilities(spec, served!, { variant: '0b6-base', supportsSpeakerReference: true })
    expect(base).toMatchObject({ voices: [], supportsVoiceRef: true, requiresVoiceRef: true })
    const custom = buildCapabilities(spec, served!, {
      variant: '1b7-customvoice',
      supportsSpeakerReference: true,
    })
    expect(custom.voices).toHaveLength(9)
    expect(custom).toMatchObject({ supportsVoiceRef: true, requiresVoiceRef: false })
  })

  it('reads voice cloning from a reference_text parameter when the loader said nothing', () => {
    const served = { ...kokoroServed, params: [{ name: 'reference_text', type: 'string', required: false }] }
    expect(buildCapabilities(kokoro, served, {}).supportsVoiceRef).toBe(true)
  })

  it('gives music and effects no voices and no voice cloning', () => {
    const spec = sampleAudioSpec({ mode: 'effects', family: 'stable_audio', task: 'gen' })
    const served = {
      id: spec.modelId,
      family: 'stable_audio',
      task: 'gen',
      loaded: true,
      params: kokoroServed.params,
    }
    expect(buildCapabilities(spec, served, { supportsSpeakerReference: true })).toMatchObject({
      voices: [],
      supportsVoiceRef: false,
      requiresVoiceRef: false,
    })
  })
})
