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
  knob,
  knobOk,
  orderedEngine,
  PARAMETERS_KEYWORD,
  parseRecipe,
  parseRecipeEngine,
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

describe('remote recipes', () => {
  const remote = (): ImageRecipe =>
    recipe({
      model: { modelId: 'gpt-image-2', family: 'openai', displayName: 'GPT Image 2', filename: '' },
      engine: { kind: 'remote', provider: 'openai', api: 'openai-images' },
      remote: { quality: 'high', size: '1024x1024' },
    })

  it('round-trip with the provider and the remote options, and name the model in parameters', () => {
    const text = serializeRecipe(remote())
    expect(JSON.parse(text)).toMatchObject({
      engine: { kind: 'remote', provider: 'openai', api: 'openai-images' },
      remote: { size: '1024x1024', quality: 'high' },
    })
    expect(parseRecipe(text)).toEqual(remote())
    expect(a1111Parameters(remote())).toContain('Model: gpt-image-2')
  })

  it('leave out the knobs a provider was not sent, and read them back absent', () => {
    const { steps: _steps, cfgScale: _cfg, seed: _seed, batchSeed: _batchSeed, ...rest } = remote()
    const bare: ImageRecipe = rest
    const text = serializeRecipe(bare)
    const keys = Object.keys(JSON.parse(text) as object)
    for (const key of ['steps', 'cfgScale', 'seed', 'batchSeed']) expect(keys).not.toContain(key)
    expect(keys.slice(0, 7)).toEqual([
      'jobId',
      'index',
      'prompt',
      'negativePrompt',
      'width',
      'height',
      'guidance',
    ])
    expect(parseRecipe(text)).toEqual(bare)
    expect(a1111Parameters(bare)).toBe(
      'a cat, photo\nNegative prompt: blurry\nSampler: euler, Distilled Guidance: 3.5, Size: 64x48, Model: gpt-image-2'
    )
  })

  it('still read a remote recipe written with the old 0 / 0 / -1 placeholders', () => {
    const old = { ...remote(), steps: 0, cfgScale: 0, seed: -1, batchSeed: -1 }
    expect(parseRecipe(serializeRecipe(old))).toEqual(old)
  })

  it('take a knob that passes, or no key only from a provider', () => {
    const whole = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
    for (const [value, remote, ok] of [
      [8, false, true],
      [8, true, true],
      [undefined, true, true],
      [undefined, false, false],
      [null, true, false],
      [1.5, true, false],
    ] as const) {
      expect(knobOk(value, remote, whole)).toBe(ok)
    }
    expect(knob('seed', 0)).toEqual({ seed: 0 })
    expect(knob('seed', undefined)).toEqual({})
  })

  it('still require every knob of a local recipe', () => {
    for (const key of ['steps', 'cfgScale', 'seed', 'batchSeed']) {
      const raw = JSON.parse(serializeRecipe(recipe())) as Record<string, unknown>
      delete raw[key]
      expect(parseRecipe(JSON.stringify(raw))).toBeUndefined()
    }
  })

  it('keep a local recipe without a remote key', () => {
    expect(Object.keys(JSON.parse(serializeRecipe(recipe())) as object)).not.toContain('remote')
  })

  it('refuse an adapter this core does not have, or a malformed remote block', () => {
    expect(parseRecipeEngine({ kind: 'remote', provider: 'x', api: 'not-an-api' })).toBeUndefined()
    expect(parseRecipeEngine({ kind: 'remote', provider: '', api: 'openai-images' })).toBeUndefined()
    expect(
      parseRecipe(JSON.stringify({ ...JSON.parse(serializeRecipe(remote())), remote: { quality: 3 } }))
    ).toBeUndefined()
    const base = JSON.parse(serializeRecipe(remote())) as Record<string, unknown>
    expect(parseRecipe(JSON.stringify({ ...base, remote: 'x' }))).toBeUndefined()
    expect(parseRecipe(JSON.stringify({ ...base, remote: { quality: null, size: 'auto' } }))?.remote).toEqual(
      {
        size: 'auto',
      }
    )
  })

  it('orders an engine of either kind', () => {
    expect(Object.keys(orderedEngine({ api: 'a1111', provider: 'p', kind: 'remote' }))).toEqual([
      'kind',
      'provider',
      'api',
    ])
    expect(Object.keys(orderedEngine(recipe().engine))).toEqual([
      'kind',
      'backend',
      'tag',
      'offload',
      'cpuFallback',
    ])
  })
})
