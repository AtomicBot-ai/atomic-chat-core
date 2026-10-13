import { describe, expect, it } from 'vitest'
import type { MediaDialect } from '../contracts/index.js'
import type { RemoteProvider } from '../router/index.js'
import { fakeMediaFetch } from '../../test/helpers/media-fetch.js'
import type { ImageAdapter, MediaAdapter, VideoAdapter } from './adapters/types.js'
import { MEDIA_CATALOG_BASELINE } from './catalog-baseline.js'
import type { MediaCatalogService } from './catalog-service.js'
import { remoteError } from './http.js'
import { abortableSleep, MediaService } from './service.js'

const provider = (name: string, overrides: Partial<RemoteProvider> = {}): RemoteProvider => ({
  provider: name,
  apiKey: 'k',
  baseUrl: `https://${name}.example/v1/`,
  customHeaders: [],
  models: [],
  ...overrides,
})

const image = (listModels?: ImageAdapter['listModels']): ImageAdapter => ({
  dialect: 'openai-images',
  kind: 'image',
  generate: async () => [],
  ...(listModels ? { listModels } : {}),
})

const video: VideoAdapter = {
  dialect: 'xai-videos',
  kind: 'video',
  submit: async () => ({ id: 'x' }),
  poll: async () => ({ state: 'running' }),
  download: async () => ({ bytes: Buffer.alloc(0), mime: 'video/mp4' }),
}

function media(
  providers: RemoteProvider[],
  adapters: Partial<Record<MediaDialect, MediaAdapter>>
): MediaService {
  const catalog = {
    catalog: async () => ({ catalog: MEDIA_CATALOG_BASELINE, origin: 'baseline' as const }),
  } as unknown as MediaCatalogService
  return new MediaService({
    catalog,
    providers: () => new Map(providers.map((p) => [p.provider, p])),
    adapters,
    fetch: fakeMediaFetch([]).fetch,
    log: () => {},
  })
}

describe('MediaService', () => {
  it('answers the catalog with where it came from', async () => {
    const view = await media([], {}).catalogView()
    expect(view.origin).toBe('baseline')
    expect(view.providers['openai']?.image?.api).toBe('openai-images')
  })

  it('resolves a catalog model with its adapter and a context on the registered base URL', async () => {
    const service = media([provider('openai')], { 'openai-images': image() })
    const resolved = await service.image({ provider: 'openai', model: 'gpt-image-2' })
    expect(resolved.descriptor).toMatchObject({ id: 'gpt-image-2', source: 'catalog' })
    const ctx = resolved.context(new AbortController().signal)
    expect(ctx.baseUrl).toBe('https://openai.example/v1')
    expect(ctx.apiKey).toBe('k')
  })

  it('takes a custom server adapter from its registration', async () => {
    const service = media([provider('my-a1111', { media: { image_api: 'a1111', models: [] } })], {
      a1111: { ...image(), dialect: 'a1111' },
    })
    const resolved = await service.image({ provider: 'my-a1111', model: 'sdxl' })
    expect(resolved.descriptor).toMatchObject({ api: 'a1111', source: 'live' })
  })

  it('refuses a provider that is not connected, one without media of that kind, or an adapter it lacks', async () => {
    const service = media([provider('openai'), provider('groq')], {})
    await expect(service.image({ provider: 'nope', model: 'x' })).rejects.toMatchObject({
      code: 'REMOTE_NOT_CONFIGURED',
    })
    await expect(service.video({ provider: 'openai', model: 'x' })).rejects.toMatchObject({
      code: 'REMOTE_NOT_CONFIGURED',
    })
    await expect(service.image({ provider: 'openai', model: 'gpt-image-2' })).rejects.toMatchObject({
      code: 'REMOTE_UNSUPPORTED',
    })
  })

  it('resolves a video model the same way', async () => {
    const service = media([provider('xai')], { 'xai-videos': video })
    expect((await service.video({ provider: 'xai', model: 'grok-imagine-video-1.5' })).adapter).toBe(video)
  })

  it('finds a public model among the enabled media models only', () => {
    const service = media(
      [provider('openai', { media: { models: [{ id: 'gpt-image-2', kind: 'image' }] } })],
      {}
    )
    expect(service.find('gpt-image-2', 'image')).toEqual({ provider: 'openai', model: 'gpt-image-2' })
    expect(service.find('gpt-image-2', 'video')).toBeUndefined()
  })

  it('merges the live listing, and keeps the catalog when the listing fails', async () => {
    const live = media([provider('openai')], {
      'openai-images': image(async () => [{ id: 'gpt-image-9' }]),
    })
    const listed = await live.providerModels('openai', 'image')
    expect(listed.live).toBe(true)
    expect(listed.models.at(-1)).toMatchObject({ id: 'gpt-image-9', source: 'live' })

    const failing = media([provider('openai')], {
      'openai-images': image(async () => Promise.reject(remoteError('REMOTE_AUTH_FAILED', 'bad key'))),
    })
    const fallback = await failing.providerModels('openai', 'image')
    expect(fallback).toMatchObject({ live: false, error: { code: 'REMOTE_AUTH_FAILED' } })
    expect(fallback.models.length).toBeGreaterThan(0)

    expect(await live.providerModels('openai', 'video')).toEqual({
      provider: 'openai',
      kind: 'video',
      api: null,
      models: [],
      live: false,
    })
  })
})

describe('abortableSleep', () => {
  it('waits, or stops with CANCELLED when the signal fires', async () => {
    await abortableSleep(1, new AbortController().signal)
    const controller = new AbortController()
    const waiting = abortableSleep(10_000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
