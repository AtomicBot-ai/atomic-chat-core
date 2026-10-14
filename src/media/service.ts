/**
 * The remote media service: what the control routes answer (the catalog, a provider's models) and
 * what the job runner resolves a target with (`RemoteMediaGateway`). A provider is usable here once
 * the app registered it (`cloud.routing()`, which already drops a key bound to another URL); its
 * adapter is the registration's own (a custom server) or the catalog's.
 */

import { MEDIA_DIALECT_KIND } from '../contracts/index.js'
import type {
  ImageModelDescriptor,
  MediaCatalogView,
  MediaDialect,
  MediaKind,
  MediaModelDescriptor,
  MediaProviderModels,
  MediaTarget,
  VideoModelDescriptor,
} from '../contracts/index.js'
import { diffusionError } from '../diffusion/index.js'
import type { RemoteMediaGateway, ResolvedRemote } from '../diffusion/index.js'
import { resolveRemoteMedia } from '../router/index.js'
import type { RemoteProvider } from '../router/index.js'
import type { ImageAdapter, MediaAdapter, VideoAdapter } from './adapters/types.js'
import { describeModel, mergeLiveModels, providerDialect } from './catalog.js'
import type { MediaCatalogService } from './catalog-service.js'
import type { MediaContext, MediaLog } from './http.js'
import { SHORT_TIMEOUT_MS } from './http.js'

export interface MediaServiceDeps {
  catalog: MediaCatalogService
  /** The registered providers, as the router sees them. */
  providers: () => ReadonlyMap<string, RemoteProvider>
  adapters: Partial<Record<MediaDialect, MediaAdapter>>
  fetch: typeof fetch
  now?: () => number
  log: MediaLog
}

/** A wait that ends early, with `CANCELLED`, when `signal` fires. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => reject(diffusionError('CANCELLED', 'Generation was cancelled.'))
    if (signal.aborted) return cancelled()
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      cancelled()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class MediaService implements RemoteMediaGateway {
  constructor(private readonly deps: MediaServiceDeps) {}

  /** `GET /media/catalog`. */
  async catalogView(): Promise<MediaCatalogView> {
    const { catalog, origin } = await this.deps.catalog.catalog()
    return {
      catalog_version: catalog.catalog_version,
      origin,
      dialects: structuredClone(catalog.dialects),
      providers: structuredClone(catalog.providers),
    }
  }

  private provider(name: string): RemoteProvider {
    const provider = this.deps.providers().get(name)
    if (!provider)
      throw diffusionError(
        'REMOTE_NOT_CONFIGURED',
        `${name} is not connected. Connect it on the Cloud page.`,
        name
      )
    if (!provider.baseUrl) throw diffusionError('REMOTE_NOT_CONFIGURED', `${name} has no base URL.`, name)
    return provider
  }

  /** A context for `provider`'s adapter calls under `signal`. */
  context(provider: RemoteProvider, signal: AbortSignal): MediaContext {
    return {
      provider: provider.provider,
      baseUrl: (provider.baseUrl ?? '').trim().replace(/\/+$/, ''),
      apiKey: provider.apiKey ?? null,
      customHeaders: provider.customHeaders,
      signal,
      fetch: this.deps.fetch,
      now: this.deps.now ?? Date.now,
      sleep: (ms) => abortableSleep(ms, signal),
      log: this.deps.log,
    }
  }

  private async dialectOf(provider: RemoteProvider, kind: MediaKind): Promise<MediaDialect | undefined> {
    const { catalog } = await this.deps.catalog.catalog()
    const override = kind === 'image' ? provider.media?.image_api : provider.media?.video_api
    return providerDialect(catalog, provider.provider, kind, override)
  }

  private async resolve<D extends MediaModelDescriptor, A extends MediaAdapter>(
    kind: MediaKind,
    target: MediaTarget
  ): Promise<ResolvedRemote<D, A>> {
    const provider = this.provider(target.provider)
    const dialect = await this.dialectOf(provider, kind)
    if (!dialect)
      throw diffusionError(
        'REMOTE_NOT_CONFIGURED',
        `${provider.provider} does not generate ${kind === 'image' ? 'images' : 'video'} here.`,
        provider.provider
      )
    const { catalog } = await this.deps.catalog.catalog()
    const descriptor = describeModel(catalog, provider.provider, kind, dialect, target.model)
    const adapter = this.deps.adapters[descriptor.api]
    if (!adapter || adapter.kind !== kind)
      throw diffusionError(
        'REMOTE_UNSUPPORTED',
        `This core cannot talk to ${descriptor.api} yet.`,
        descriptor.api
      )
    return {
      target: { provider: provider.provider, model: target.model },
      descriptor: descriptor as D,
      adapter: adapter as A,
      context: (signal) => this.context(provider, signal),
    }
  }

  image(target: MediaTarget): Promise<ResolvedRemote<ImageModelDescriptor, ImageAdapter>> {
    return this.resolve('image', target)
  }

  video(target: MediaTarget): Promise<ResolvedRemote<VideoModelDescriptor, VideoAdapter>> {
    return this.resolve('video', target)
  }

  find(model: string, kind: MediaKind): MediaTarget | undefined {
    return resolveRemoteMedia(model, kind, this.deps.providers())
  }

  /**
   * `GET /media/providers/:provider/models?kind=`: the catalog's models of the provider, then what its
   * live listing adds. A listing that fails still answers the catalog's models, with the error.
   */
  async providerModels(name: string, kind: MediaKind): Promise<MediaProviderModels> {
    const provider = this.provider(name)
    const dialect = await this.dialectOf(provider, kind)
    const { catalog } = await this.deps.catalog.catalog()
    if (!dialect) return { provider: name, kind, api: null, models: [], live: false }
    const adapter = this.deps.adapters[dialect]
    const listing = adapter && MEDIA_DIALECT_KIND[dialect] === kind ? adapter.listModels : undefined
    if (!adapter || !listing) {
      return {
        provider: name,
        kind,
        api: dialect,
        models: mergeLiveModels(catalog, name, kind, dialect, []),
        live: false,
      }
    }
    try {
      const live = await listing.call(adapter, this.context(provider, AbortSignal.timeout(SHORT_TIMEOUT_MS)))
      return {
        provider: name,
        kind,
        api: dialect,
        models: mergeLiveModels(catalog, name, kind, dialect, live),
        live: true,
      }
    } catch (error) {
      const fields = error as { code?: unknown; message?: unknown }
      return {
        provider: name,
        kind,
        api: dialect,
        models: mergeLiveModels(catalog, name, kind, dialect, []),
        live: false,
        error: {
          code: typeof fields.code === 'string' ? fields.code : 'REMOTE_UNAVAILABLE',
          message: typeof fields.message === 'string' ? fields.message : String(error),
        },
      }
    }
  }
}
