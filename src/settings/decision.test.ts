import { describe, expect, it } from 'vitest'
import { DEFAULT_DECISION_SETTINGS } from '../contracts/index.js'
import { decisionSettingsOf, parseDecisionSettingsPatch } from './decision.js'

describe('decisionSettingsOf', () => {
  it('fills every key with its default', () => {
    expect(decisionSettingsOf(undefined)).toEqual(DEFAULT_DECISION_SETTINGS)
    expect(decisionSettingsOf([])).toEqual(DEFAULT_DECISION_SETTINGS)
  })

  it('pins the defaults: off, a 500 ms budget, resident once started', () => {
    expect(DEFAULT_DECISION_SETTINGS).toEqual({
      enabled: false,
      model_path: '',
      model_id: '',
      spec_path: '',
      threads: 0,
      timeout_ms: 500,
      idle_unload_secs: 0,
      startup_timeout_secs: 60,
      allow_uncalibrated: false,
      engine_path: '',
    })
  })

  it('coerces what a hand edit may leave and keeps the default for anything unusable', () => {
    expect(
      decisionSettingsOf({
        enabled: 'true',
        model_path: '  /m/laya.gguf ',
        threads: '6',
        timeout_ms: 0,
        idle_unload_secs: -1,
        allow_uncalibrated: 1,
        extra: 'dropped here',
      })
    ).toEqual({ ...DEFAULT_DECISION_SETTINGS, enabled: true, model_path: '/m/laya.gguf', threads: 6 })
  })
})

describe('parseDecisionSettingsPatch', () => {
  it('passes known keys through, coerced, and skips undefined', () => {
    expect(parseDecisionSettingsPatch({ enabled: false, timeout_ms: '750', spec_path: undefined })).toEqual({
      enabled: false,
      timeout_ms: 750,
    })
  })

  it.each([
    [null, 'JSON object'],
    [[], 'JSON object'],
    [{ modelPath: '/x' }, "Unknown decision setting 'modelPath'"],
    [{ timeout_ms: 60_001 }, 'an integer from 1 to 60000'],
    [{ threads: 1.5 }, 'an integer from 0 to 256'],
    [{ enabled: 'yes' }, 'a boolean'],
    [{ model_path: 7 }, 'a string'],
  ])('refuses %j', (patch, message) => {
    expect(() => parseDecisionSettingsPatch(patch)).toThrow(message)
  })
})
