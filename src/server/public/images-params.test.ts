/**
 * Hand-ported from the tests of the app's `images_route.rs` (commit `767ff6350`).
 */
import { describe, expect, it } from 'vitest'
import type { DiffusionFamilyDefaults } from '../../contracts/index.js'
import {
  buildRequest,
  errorBody,
  errorKindFor,
  mapError,
  modelMatches,
  ParamError,
  parseParams,
  parseSize,
} from './images-params.js'

const defaults: DiffusionFamilyDefaults = {
  steps: 8,
  cfgScale: 1.0,
  guidance: 3.5,
  samplingMethod: 'euler',
  width: 1024,
  height: 768,
}

const refusal = (run: () => unknown): ParamError => {
  try {
    run()
  } catch (e) {
    expect(e).toBeInstanceOf(ParamError)
    return e as ParamError
  }
  throw new Error('expected a refusal')
}

describe('parseSize', () => {
  it('parses auto and dimensions within bounds', () => {
    expect(parseSize('auto')).toBeUndefined()
    expect(parseSize(' AUTO ')).toBeUndefined()
    expect(parseSize('')).toBeUndefined()
    expect(parseSize('1024x1024')).toEqual({ width: 1024, height: 1024 })
    expect(parseSize('512X768')).toEqual({ width: 512, height: 768 })
    expect(parseSize(' 512 x 768 ')).toEqual({ width: 512, height: 768 })
    expect(refusal(() => parseSize('500x512')).message).toBe('width must be a multiple of 16')
    expect(refusal(() => parseSize('128x512')).message).toBe('width must be between 256 and 2048')
    expect(refusal(() => parseSize('4096x512')).message).toBe('width must be between 256 and 2048')
    expect(refusal(() => parseSize('512x4096')).message).toBe('height must be between 256 and 2048')
    for (const bad of ['large', '512x', 'x512', '512x-16', '5.12x512', '512x99999999999'])
      expect(refusal(() => parseSize(bad)).param, bad).toBe('size')
  })
})

describe('parseParams', () => {
  it('takes defaults and rejects the url format', () => {
    expect(parseParams({ prompt: ' a cat ' })).toEqual({ prompt: 'a cat', n: 1 })
    expect(
      parseParams({
        model: 'z-image:q4_k_m',
        prompt: 'x',
        n: 4,
        size: '512x512',
        response_format: 'b64_json',
        seed: 7,
        negative_prompt: 'blurry',
      })
    ).toEqual({
      model: 'z-image:q4_k_m',
      prompt: 'x',
      n: 4,
      size: { width: 512, height: 512 },
      seed: 7,
      negativePrompt: 'blurry',
    })
    expect(refusal(() => parseParams({})).param).toBe('prompt')
    expect(refusal(() => parseParams({ prompt: '   ' })).message).toBe('prompt is required')
    expect(refusal(() => parseParams({ prompt: 'x', n: 5 })).param).toBe('n')
    expect(refusal(() => parseParams({ prompt: 'x', n: 0 })).param).toBe('n')
    expect(refusal(() => parseParams({ prompt: 'x', n: 1.5 })).message).toBe(
      'n must be an integer between 1 and 4'
    )
    const url = refusal(() => parseParams({ prompt: 'x', response_format: 'url' }))
    expect(url.param).toBe('response_format')
    expect(url.message).toContain('b64_json')
    expect(refusal(() => parseParams([1])).param).toBe('body')
    expect(refusal(() => parseParams(null)).param).toBe('body')
  })

  it('treats null like absent, blank strings as absent, and refuses wrong types', () => {
    expect(
      parseParams({ prompt: 'x', n: null, size: null, seed: null, negative_prompt: '  ', model: '' })
    ).toEqual({
      prompt: 'x',
      n: 1,
    })
    expect(parseParams({ prompt: 'x', size: 'auto', model: ' Z-Image Turbo ' })).toEqual({
      prompt: 'x',
      n: 1,
      model: 'Z-Image Turbo',
    })
    expect(refusal(() => parseParams({ prompt: 'x', size: 1024 })).message).toBe('size must be a string')
    expect(refusal(() => parseParams({ prompt: 'x', response_format: 1 })).message).toBe(
      'response_format must be a string'
    )
    expect(refusal(() => parseParams({ prompt: 'x', seed: 'seven' })).message).toBe('seed must be an integer')
    expect(refusal(() => parseParams({ prompt: 'x', seed: 1.5 })).param).toBe('seed')
    expect(refusal(() => parseParams({ prompt: 'x', negative_prompt: 5 })).message).toBe(
      'negative_prompt must be a string'
    )
    expect(refusal(() => parseParams({ prompt: 'x', model: {} })).message).toBe('model must be a string')
  })
})

describe('buildRequest', () => {
  it('binds the request to the family defaults', () => {
    const request = buildRequest(parseParams({ prompt: 'x', n: 2 }), defaults)
    expect(request).toEqual({
      prompt: 'x',
      width: 1024,
      height: 768,
      steps: 8,
      cfgScale: 1.0,
      guidance: 3.5,
      samplingMethod: 'euler',
      batchSize: 2,
    })
    const sized = buildRequest(
      parseParams({ prompt: 'x', size: '512x512', seed: 9, negative_prompt: 'blurry' }),
      {
        ...defaults,
        flowShift: 3,
      }
    )
    expect(sized).toMatchObject({ width: 512, height: 512, seed: 9, negativePrompt: 'blurry', flowShift: 3 })
    expect(
      buildRequest(parseParams({ prompt: 'x' }), { steps: 4, cfgScale: 1, width: 512, height: 512 })
    ).toEqual({
      prompt: 'x',
      width: 512,
      height: 512,
      steps: 4,
      cfgScale: 1,
      batchSize: 1,
    })
  })
})

describe('modelMatches', () => {
  it('accepts the id, the display name and the dot/underscore fold', () => {
    const loaded = { modelId: 'z-image:q4_k_m', displayName: 'Z-Image Turbo' }
    expect(modelMatches(undefined, loaded)).toBe(true)
    expect(modelMatches('z-image:q4_k_m', loaded)).toBe(true)
    expect(modelMatches('Z-Image Turbo', loaded)).toBe(true)
    expect(modelMatches('z-image:q4.k.m', loaded)).toBe(true)
    expect(modelMatches('gpt-image-1', loaded)).toBe(false)
  })
})

describe('the error envelope', () => {
  it('follows the OpenAI shape', () => {
    expect(JSON.parse(errorBody('nope', 'invalid_request_error', null, 'response_format'))).toEqual({
      error: { message: 'nope', type: 'invalid_request_error', param: 'response_format', code: null },
    })
    expect(mapError('INVALID_DIMENSIONS')).toEqual({
      status: 400,
      type: 'invalid_request_error',
      code: 'invalid_request',
    })
    expect(mapError('MODEL_NOT_LOADED').status).toBe(503)
    expect(mapError('NOT_CONFIGURED').code).toBe('model_not_loaded')
    expect(mapError('JOB_BUSY').status).toBe(429)
    expect(mapError('QUEUE_FULL').code).toBe('busy')
    expect(mapError('OUT_OF_MEMORY').code).toBe('insufficient_memory')
    expect(mapError('CANCELLED')).toEqual({ status: 500, type: 'server_error', code: 'cancelled' })
    expect(mapError('ENGINE_CRASHED')).toEqual({ status: 500, type: 'server_error', code: 'server_error' })
    expect([400, 429, 503, 500, 504].map(errorKindFor)).toEqual([
      'bad_request',
      'busy',
      'not_found',
      'upstream',
      'upstream',
    ])
  })
})
