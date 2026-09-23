import { describe, expect, it } from 'vitest'
import { sampleVideoRecipe } from '../../test/helpers/diffusion-fixtures.js'
import { parseVideoRecipe, RECIPE_SIDECAR_SUFFIX, serializeVideoRecipe } from './video-recipe.js'

describe('serializeVideoRecipe', () => {
  it('writes every key in a fixed order with nulls, and round-trips', () => {
    const recipe = sampleVideoRecipe({ guidance: 3.5, flowShift: 3, negativePrompt: 'blurry' })
    const text = serializeVideoRecipe(recipe)
    expect(text.endsWith('\n')).toBe(true)
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'jobId',
      'prompt',
      'negativePrompt',
      'width',
      'height',
      'frames',
      'frameCount',
      'fps',
      'steps',
      'cfgScale',
      'guidance',
      'seed',
      'samplingMethod',
      'flowShift',
      'workflow',
      'outputFormat',
      'model',
      'engine',
      'createdAtMs',
      'durationMs',
    ])
    expect(parseVideoRecipe(text)).toEqual(recipe)
    // Absent optionals are written as null, never dropped.
    const bare = serializeVideoRecipe(sampleVideoRecipe())
    expect(JSON.parse(bare)).toMatchObject({ negativePrompt: null, guidance: null, flowShift: null })
    expect(parseVideoRecipe(bare)).toEqual(sampleVideoRecipe())
    expect(RECIPE_SIDECAR_SUFFIX).toBe('.json')
  })
})

describe('parseVideoRecipe', () => {
  const valid = () => JSON.parse(serializeVideoRecipe(sampleVideoRecipe())) as Record<string, unknown>
  const withField = (key: string, value: unknown) => JSON.stringify({ ...valid(), [key]: value })

  it('takes a seed past 2^53 as a double, like the image recipe', () => {
    expect(parseVideoRecipe(withField('seed', 2 ** 60))?.seed).toBe(2 ** 60)
    expect(parseVideoRecipe(withField('seed', -5))?.seed).toBe(-5)
  })

  it('refuses anything that is not a whole recipe', () => {
    const table: Array<[string, unknown]> = [
      ['jobId', 7],
      ['prompt', null],
      ['width', 1.5],
      ['frames', -1],
      ['frameCount', '25'],
      ['fps', null],
      ['steps', 8.5],
      ['cfgScale', 'one'],
      ['seed', 1.5],
      ['seed', 2 ** 64],
      ['workflow', 'transform'],
      ['outputFormat', 'mp4'],
      ['negativePrompt', 7],
      ['guidance', 'x'],
      ['samplingMethod', 1],
      ['flowShift', false],
      ['model', 'z'],
      ['engine', null],
      ['createdAtMs', -1],
      ['durationMs', 'long'],
    ]
    for (const [key, value] of table)
      expect(parseVideoRecipe(withField(key, value)), `${key}=${String(value)}`).toBeUndefined()
    expect(
      parseVideoRecipe(
        JSON.stringify({ ...valid(), model: { ...(valid()['model'] as object), filename: 1 } })
      )
    ).toBeUndefined()
    expect(
      parseVideoRecipe(
        JSON.stringify({ ...valid(), engine: { ...(valid()['engine'] as object), offload: 'all' } })
      )
    ).toBeUndefined()
    expect(parseVideoRecipe('not json')).toBeUndefined()
    expect(parseVideoRecipe('[]')).toBeUndefined()
    expect(parseVideoRecipe('null')).toBeUndefined()
  })
})
