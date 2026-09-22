/**
 * The recipe half of `gallery.rs` in `tauri-plugin-atomic-diffusion` (app commit `767ff6350`):
 * `spliced_png_decodes_with_both_text_chunks_intact`, `splice_rejects_non_png_input`.
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AtomicCoreError } from '../contracts/index.js'
import type { ImageRecipe } from '../contracts/index.js'
import { sampleRecipe } from '../../test/helpers/diffusion-fixtures.js'
import { decodePng, makeChunk, parseHeader, PNG_SIGNATURE } from './png.js'
import {
  a1111Parameters,
  fmtFloat,
  PARAMETERS_KEYWORD,
  parseRecipe,
  RECIPE_KEYWORD,
  serializeRecipe,
  spliceRecipe,
} from './recipe.js'

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`../../test/fixtures/png/${name}`, import.meta.url)))

const recipe = sampleRecipe

describe('a1111Parameters', () => {
  it('writes the line other tools read', () => {
    expect(a1111Parameters(recipe())).toBe(
      'a cat, photo\nNegative prompt: blurry\n' +
        'Steps: 8, Sampler: euler, CFG scale: 1, Distilled Guidance: 3.5, Seed: 100, Size: 64x48, Model: z-image-turbo-Q4_K_M.gguf'
    )
  })

  it('leaves out what the recipe does not have, and adds what an img2img one does', () => {
    const bare = recipe({ negativePrompt: null, guidance: null, samplingMethod: null })
    expect(a1111Parameters(bare)).toBe(
      'a cat, photo\nSteps: 8, Sampler: default, CFG scale: 1, Seed: 100, Size: 64x48, Model: z-image-turbo-Q4_K_M.gguf'
    )
    expect(a1111Parameters(recipe({ negativePrompt: '' }))).not.toContain('Negative prompt')
    const img2img = recipe({ flowShift: 3, strength: 0.35, cfgScale: 4.5 })
    expect(a1111Parameters(img2img)).toContain('CFG scale: 4.5, ')
    expect(a1111Parameters(img2img).endsWith('Flow shift: 3, Denoising strength: 0.35')).toBe(true)
  })

  it('formats numbers the way Rust did', () => {
    expect(fmtFloat(1)).toBe('1')
    expect(fmtFloat(-0)).toBe('0')
    expect(fmtFloat(3.5)).toBe('3.5')
    expect(fmtFloat(0.0000001)).toBe('0.0000001')
    expect(fmtFloat(1e21)).toBe('9223372036854775807')
    expect(fmtFloat(-1e21)).toBe('-9223372036854775808')
    expect(fmtFloat(Number.NaN)).toBe('NaN')
    expect(fmtFloat(Number.POSITIVE_INFINITY)).toBe('inf')
    expect(fmtFloat(Number.NEGATIVE_INFINITY)).toBe('-inf')
  })
})

describe('spliceRecipe', () => {
  it('embeds both chunks after IHDR and leaves the picture alone', async () => {
    const png = await fixture('rgb-all-filters.png')
    const spliced = spliceRecipe(png, recipe({ prompt: 'кот, фото' }))
    const parsed = parseHeader(spliced)
    if (parsed === 'not-png' || !parsed.header) throw new Error('header expected')
    expect([...parsed.header.texts.keys()]).toEqual([RECIPE_KEYWORD, PARAMETERS_KEYWORD])
    expect(parseRecipe(parsed.header.texts.get(RECIPE_KEYWORD) as string)).toEqual(
      recipe({ prompt: 'кот, фото' })
    )
    expect(parsed.header.texts.get(PARAMETERS_KEYWORD)).toBe(a1111Parameters(recipe({ prompt: 'кот, фото' })))
    expect((await decodePng(spliced)).data.equals((await decodePng(png)).data)).toBe(true)
  })

  it('refuses what is not a PNG', () => {
    const error = (run: () => unknown) => {
      try {
        run()
      } catch (e) {
        return (e as AtomicCoreError).toJSON()
      }
      throw new Error('expected a refusal')
    }
    expect(error(() => spliceRecipe(Buffer.from('not a png'), recipe()))).toEqual({
      code: 'INTERNAL',
      message: 'The engine returned something that is not a PNG.',
    })
    const headless = Buffer.concat([PNG_SIGNATURE, makeChunk('IDAT', Buffer.alloc(2))])
    expect(error(() => spliceRecipe(headless, recipe()))).toEqual({
      code: 'INTERNAL',
      message: 'The engine returned a PNG without an IHDR chunk.',
    })
  })
})

describe('the embedded JSON', () => {
  it('is camelCase with every key present, in the order the plugin wrote them', () => {
    const json = serializeRecipe(recipe())
    expect(json).toContain('"batchSeed":100')
    expect(json).toContain('"cpuFallback":false')
    expect(json).toContain('"flowShift":null')
    expect(Object.keys(JSON.parse(json) as object)).toEqual([
      'jobId',
      'index',
      'prompt',
      'negativePrompt',
      'width',
      'height',
      'steps',
      'cfgScale',
      'guidance',
      'seed',
      'batchSeed',
      'batchSize',
      'samplingMethod',
      'flowShift',
      'workflow',
      'strength',
      'model',
      'engine',
      'createdAtMs',
      'durationMs',
    ])
    // Key order does not depend on how the caller built the object.
    const shuffled = Object.fromEntries(Object.entries(recipe()).reverse()) as unknown as ImageRecipe
    expect(serializeRecipe(shuffled)).toBe(json)
  })

  it('round-trips, and reads a recipe whose optional values are missing altogether', () => {
    expect(parseRecipe(serializeRecipe(recipe()))).toEqual(recipe())
    const sparse = JSON.parse(serializeRecipe(recipe())) as Record<string, unknown>
    for (const key of ['negativePrompt', 'guidance', 'samplingMethod', 'flowShift', 'strength'])
      delete sparse[key]
    expect(parseRecipe(JSON.stringify(sparse))).toEqual(
      recipe({ negativePrompt: null, guidance: null, samplingMethod: null, flowShift: null, strength: null })
    )
  })

  it("reads a seed above 2^53, which the plugin's i64 allowed, as the nearest double", () => {
    // 2.0.40's `/v1/images/generations` took any i64 seed and wrote it into the recipe verbatim.
    const text = serializeRecipe(recipe())
      .replace('"seed":100', '"seed":9223372036854775807')
      .replace('"batchSeed":100', '"batchSeed":9223372036854775807')
    expect(text).toContain('"seed":9223372036854775807,"batchSeed":9223372036854775807')
    expect(parseRecipe(text)).toEqual(recipe({ seed: 2 ** 63, batchSeed: 2 ** 63 }))
    const unsafe = serializeRecipe(recipe()).replace('"seed":100', '"seed":9007199254740993')
    expect(parseRecipe(unsafe)?.seed).toBe(2 ** 53)
    expect(
      parseRecipe(serializeRecipe(recipe()).replace('"seed":100', '"seed":-9223372036854775808'))?.seed
    ).toBe(-(2 ** 63))
    // Still whole numbers in i64's range only, as serde read them; a JSON number too large for a
    // double is not one either.
    expect(parseRecipe(serializeRecipe(recipe()).replace('"seed":100', '"seed":100.5'))).toBeUndefined()
    expect(parseRecipe(serializeRecipe(recipe()).replace('"seed":100', '"seed":1e19'))).toBeUndefined()
    expect(
      parseRecipe(serializeRecipe(recipe()).replace('"batchSeed":100', '"batchSeed":1e400'))
    ).toBeUndefined()
  })

  it('reads back any seed past 2^53 as the double it serialized', () => {
    const past = recipe({ index: 3, seed: 2 ** 53 + 2, batchSeed: Number.MAX_SAFE_INTEGER, batchSize: 4 })
    const text = serializeRecipe(past)
    expect(text).toContain('"seed":9007199254740994,"batchSeed":9007199254740991')
    expect(parseRecipe(text)).toEqual(past)
  })

  it('does not take anything else for a recipe', () => {
    const broken = (change: (r: Record<string, unknown>) => void): string => {
      const raw = JSON.parse(serializeRecipe(recipe())) as Record<string, unknown>
      change(raw)
      return JSON.stringify(raw)
    }
    expect(parseRecipe('not json')).toBeUndefined()
    expect(parseRecipe('[]')).toBeUndefined()
    expect(parseRecipe('{}')).toBeUndefined()
    expect(parseRecipe(broken((r) => delete r['jobId']))).toBeUndefined()
    expect(parseRecipe(broken((r) => (r['index'] = -1)))).toBeUndefined()
    expect(parseRecipe(broken((r) => (r['steps'] = 8.5)))).toBeUndefined()
    expect(parseRecipe(broken((r) => (r['seed'] = 'x')))).toBeUndefined()
    expect(parseRecipe(broken((r) => (r['workflow'] = 'animate')))).toBeUndefined()
    expect(parseRecipe(broken((r) => (r['guidance'] = 'high')))).toBeUndefined()
    expect(parseRecipe(broken((r) => (r['model'] = null)))).toBeUndefined()
    expect(
      parseRecipe(broken((r) => ((r['model'] as Record<string, unknown>)['filename'] = 1)))
    ).toBeUndefined()
    expect(
      parseRecipe(broken((r) => ((r['engine'] as Record<string, unknown>)['kind'] = 'comfy')))
    ).toBeUndefined()
    expect(
      parseRecipe(broken((r) => ((r['engine'] as Record<string, unknown>)['backend'] = 'opencl')))
    ).toBeUndefined()
    expect(
      parseRecipe(broken((r) => ((r['engine'] as Record<string, unknown>)['offload'] = 'all')))
    ).toBeUndefined()
    expect(
      parseRecipe(broken((r) => ((r['engine'] as Record<string, unknown>)['cpuFallback'] = 'no')))
    ).toBeUndefined()
  })
})
