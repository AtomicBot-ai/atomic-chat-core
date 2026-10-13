import { describe, expect, it } from 'vitest'
import { MEDIA_CATALOG_BASELINE } from './catalog-baseline.js'
import {
  defaultDescriptor,
  describeModel,
  isMediaDialect,
  mergeLiveModels,
  parseCatalogModel,
  parseImageParams,
  parseMediaCatalog,
  parseVideoParams,
  providerDialect,
} from './catalog.js'
import type { MediaCatalog } from './catalog.js'

const doc = (providers: Record<string, unknown>, dialects: Record<string, unknown> = {}) => ({
  schema_version: 1,
  catalog_version: 3,
  updated_at: '2026-10-13T00:00:00Z',
  dialects,
  providers,
})

describe('parseMediaCatalog', () => {
  it('reads the bundled baseline', () => {
    expect(MEDIA_CATALOG_BASELINE.providers['openai']?.image?.api).toBe('openai-images')
    expect(MEDIA_CATALOG_BASELINE.providers['openrouter']?.video?.models.length).toBeGreaterThan(0)
  })

  it("speaks the A1111 API to the self-hosted servers the app ships, whose models are the server's own", () => {
    for (const provider of ['automatic1111', 'sdcpp-server']) {
      expect(providerDialect(MEDIA_CATALOG_BASELINE, provider, 'image'), provider).toBe('a1111')
      expect(MEDIA_CATALOG_BASELINE.providers[provider]?.image?.models, provider).toEqual([])
    }
  })

  it('refuses a document of another schema version or without a catalog version', () => {
    expect(parseMediaCatalog({ ...doc({}), schema_version: 2 })).toBeUndefined()
    expect(parseMediaCatalog({ ...doc({}), catalog_version: 0 })).toBeUndefined()
    expect(parseMediaCatalog('nope')).toBeUndefined()
  })

  it('drops what this core cannot read and keeps the rest', () => {
    const catalog = parseMediaCatalog(
      doc(
        {
          future: {
            image: {
              api: 'some-new-api',
              models: [{ id: 'x', name: 'X', workflows: ['create'], params: {} }],
            },
          },
          acme: {
            image: {
              api: 'openai-images',
              models: [
                {
                  id: 'a',
                  name: 'A',
                  default: true,
                  workflows: ['create', 'paint-by-voice'],
                  params: { n: { max: 99 } },
                },
                { id: 'a', name: 'dup', workflows: ['create'], params: {} },
                { id: 'b', name: 'B', default: true, workflows: ['edit'], params: {} },
                { id: 'c', name: 'C', workflows: ['nothing-known'], params: {} },
                { id: 'v', name: 'V', api: 'gemini-veo', workflows: ['create'], params: {} },
              ],
            },
          },
        },
        { 'openai-images': { kind: 'image', workflows: ['create'], params: {} }, 'unknown': {} }
      )
    ) as MediaCatalog
    expect(Object.keys(catalog.providers)).toEqual(['acme'])
    const models = catalog.providers['acme']?.image?.models ?? []
    expect(models.map((m) => [m.id, m.default ?? false, m.workflows])).toEqual([
      ['a', true, ['create']],
      ['b', false, ['edit']],
    ])
    expect(models[0]?.kind === 'image' && models[0].params.n).toEqual({ max: 10 })
    expect(Object.keys(catalog.dialects)).toEqual(['openai-images'])
  })
})

describe('params', () => {
  it('keep valid image controls only', () => {
    expect(
      parseImageParams({
        size: { kind: 'enum', values: ['auto', '1024x1024', 'huge'], default: 'huge' },
        aspect_ratios: { values: ['1:1'], default: '9:9' },
        steps: { min: 5, max: 1 },
        cfg: { min: 1, max: 9, default: 5, step: 0.5 },
        seed: true,
        sampler: 'yes',
        max_input_images: 40,
        unknown: 1,
      })
    ).toEqual({
      size: { kind: 'enum', values: ['auto', '1024x1024'] },
      aspect_ratios: { values: ['1:1'] },
      cfg: { min: 1, max: 9, default: 5, step: 0.5 },
      seed: true,
      max_input_images: 16,
    })
    expect(
      parseImageParams({ size: { kind: 'range', min: 256, max: 2048, multiple: 8, default_width: 4096 } })
    ).toEqual({
      size: { kind: 'range', min: 256, max: 2048, multiple: 8 },
    })
  })

  it('keep valid video controls only', () => {
    expect(
      parseVideoParams({
        durations: { values: [4, -1, 8], default: 8 },
        resolutions: { values: ['720p'] },
        audio: true,
        last_frame: false,
      })
    ).toEqual({ durations: { values: [4, 8], default: 8 }, resolutions: { values: ['720p'] }, audio: true })
    expect(parseVideoParams({ durations: { min: 4, max: 2 } })).toEqual({})
    expect(parseVideoParams({ durations: { min: 1, max: 15, default: 8 } })).toEqual({
      durations: { min: 1, max: 15, default: 8 },
    })
  })

  it('reads one model with its own adapter', () => {
    expect(
      parseCatalogModel('video', 'minimax-video', {
        id: 'H3',
        name: 'H3',
        api: 'minimax-video-v2',
        workflows: ['create'],
        params: {},
      })
    ).toMatchObject({
      api: 'minimax-video-v2',
      source: 'catalog',
    })
    expect(
      parseCatalogModel('video', 'minimax-video', {
        id: 'x',
        workflows: ['create'],
        api: 'openai-images',
        params: {},
      })
    ).toBeUndefined()
    expect(isMediaDialect('a1111')).toBe(true)
    expect(isMediaDialect('nope')).toBe(false)
  })
})

describe('resolution', () => {
  const catalog = MEDIA_CATALOG_BASELINE

  it('takes a registration override of the right kind first, then the catalog', () => {
    expect(providerDialect(catalog, 'openai', 'image')).toBe('openai-images')
    expect(providerDialect(catalog, 'my-server', 'image', 'a1111')).toBe('a1111')
    expect(providerDialect(catalog, 'openai', 'image', 'gemini-veo')).toBe('openai-images')
    expect(providerDialect(catalog, 'openai', 'video')).toBeUndefined()
  })

  it('describes a catalog model, and anything else by its adapter defaults', () => {
    expect(describeModel(catalog, 'openai', 'image', 'openai-images', 'gpt-image-2').source).toBe('catalog')
    const other = describeModel(catalog, 'my-server', 'image', 'a1111', 'sdxl.safetensors')
    expect(other).toMatchObject({ source: 'live', api: 'a1111', name: 'sdxl.safetensors' })
    expect(other.workflows).toEqual(['create', 'transform', 'inpaint'])
    expect(
      defaultDescriptor({ catalog_version: 1, dialects: {}, providers: {} }, 'video', 'xai-videos', 'x')
        .workflows
    ).toEqual(['create'])
  })

  it('merges a live listing after the catalog, keeping the catalog entry and taking live params for new ids', () => {
    const merged = mergeLiveModels(catalog, 'xai', 'image', 'xai-images', [
      { id: 'grok-imagine-image-2.0', samplers: ['x'] },
      { id: 'grok-imagine-image-3.0', name: 'Grok 3', workflows: ['create'], params: { n: { max: 2 } } },
    ])
    expect(merged.map((m) => [m.id, m.source])).toEqual([
      ['grok-imagine-image-2.0', 'catalog'],
      ['grok-imagine-image-3.0', 'live'],
    ])
    expect(merged[1]).toMatchObject({ name: 'Grok 3', workflows: ['create'], params: { n: { max: 2 } } })
  })
})
