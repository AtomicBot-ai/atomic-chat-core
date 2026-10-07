import { describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  GENERATION_DEFAULT_KEYS,
  readGenerationDefaults,
  withGenerationDefaults,
} from './generation-defaults.js'

describe('readGenerationDefaults', () => {
  it('reads every stored default, from numbers and from their text', () => {
    expect(
      readGenerationDefaults('vllm', {
        default_temperature: 0.7,
        default_top_p: '0.9',
        default_top_k: '40',
        default_min_p: 0.05,
        default_repetition_penalty: '1.1',
      })
    ).toEqual({ temperature: 0.7, top_p: 0.9, top_k: 40, min_p: 0.05, repetition_penalty: 1.1 })
  })

  it("leaves a default out when it is not stored, null, or '' — the model's own default stands", () => {
    expect(
      readGenerationDefaults('vllm', {
        default_temperature: '',
        default_top_p: '   ',
        default_top_k: null,
        other_setting: 3,
      })
    ).toEqual({})
  })

  it('accepts the edges of each range', () => {
    expect(
      readGenerationDefaults('tensorrt-llm', {
        default_temperature: 0,
        default_top_p: 1,
        default_top_k: -1,
        default_min_p: 1,
        default_repetition_penalty: 10,
      })
    ).toEqual({ temperature: 0, top_p: 1, top_k: -1, min_p: 1, repetition_penalty: 10 })
  })

  const refused: Array<[string, unknown]> = [
    ['default_temperature', 2.5],
    ['default_temperature', -0.1],
    ['default_top_p', 0],
    ['default_top_k', 1.5],
    ['default_top_k', -2],
    ['default_min_p', 1.2],
    ['default_repetition_penalty', 0],
    ['default_temperature', 'warm'],
    ['default_temperature', Number.NaN],
    ['default_top_p', true],
  ]
  it.each(refused)('refuses %s = %j with INVALID_ARGUMENT naming the provider and the key', (key, value) => {
    let thrown: unknown
    try {
      readGenerationDefaults('vllm', { [key]: value })
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(AtomicCoreError)
    expect((thrown as AtomicCoreError).code).toBe('INVALID_ARGUMENT')
    expect((thrown as AtomicCoreError).message).toContain(`vllm setting ${key} must be`)
  })

  it('names every default by its stored key', () => {
    expect(Object.values(GENERATION_DEFAULT_KEYS)).toEqual([
      'default_temperature',
      'default_top_p',
      'default_top_k',
      'default_min_p',
      'default_repetition_penalty',
    ])
  })
})

describe('withGenerationDefaults', () => {
  it('adds the defaults a request does not set', () => {
    expect(withGenerationDefaults({ model: 'm', messages: [] }, { temperature: 0.7, top_k: 40 })).toEqual({
      model: 'm',
      messages: [],
      temperature: 0.7,
      top_k: 40,
    })
  })

  it("keeps the request's own value, and treats null as not set", () => {
    expect(
      withGenerationDefaults({ temperature: 0.2, top_p: null }, { temperature: 0.7, top_p: 0.9 })
    ).toEqual({
      temperature: 0.2,
      top_p: 0.9,
    })
  })

  it('returns the same body when there is nothing to add', () => {
    const body = { temperature: 0.2 }
    expect(withGenerationDefaults(body, {})).toBe(body)
    expect(withGenerationDefaults(body, { temperature: 0.7 })).toBe(body)
  })
})
