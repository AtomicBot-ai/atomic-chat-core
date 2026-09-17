/**
 * The cloud providers the Local API Server can route to: what the app registers today with
 * `register_provider_config`, kept by the core so a server it owns — or a core running on its own —
 * can serve cloud models too.
 *
 * Ported from: src-tauri/src/core/server/remote_provider_commands.rs (the in-memory map there).
 *
 * The non-secret half (base URL, custom headers, models) is stored in `settings.json` under
 * `cloud.providers`; the API key goes to `credentials.json`, so the settings file never carries a
 * secret (PLAN.md §3.4). Order is registration order, which decides which provider wins when two
 * list the same model — the app's hash map made that arbitrary; here it is at least stable.
 */

import { createHash } from 'node:crypto'
import { AtomicCoreError } from '../contracts/index.js'
import type { ApiKeyStore } from '../credentials/index.js'
import type { RemoteProvider } from '../router/index.js'
import type { SettingsStore } from '../settings/index.js'

/** Engines the core runs itself; registering one as a cloud provider would shadow its sessions. */
const LOCAL_PROVIDERS = new Set(['llamacpp', 'llamacpp-upstream', 'mlx', 'foundation-models'])

export interface CustomHeader {
  header: string
  value: string
}

/** A provider as the control API shows it: never the key, only whether there is one. */
export interface CloudProviderView {
  provider: string
  base_url: string | null
  custom_headers: CustomHeader[]
  models: string[]
  has_api_key: boolean
}

export interface CloudProviderInput {
  provider: string
  /** Absent keeps the stored key; `null` or `""` removes it; a string replaces it. */
  api_key?: string | null
  base_url?: string | null
  custom_headers?: CustomHeader[]
  models?: string[]
}

interface StoredProvider {
  provider: string
  base_url: string | null
  custom_headers: CustomHeader[]
  models: string[]
}

function binding(provider: StoredProvider): string {
  return createHash('sha256')
    .update(JSON.stringify([provider.provider, provider.base_url, provider.custom_headers, provider.models]))
    .digest('hex')
}

export class CloudRegistry {
  private mutation: Promise<void> = Promise.resolve()
  constructor(
    private readonly settings: SettingsStore,
    private readonly keys: ApiKeyStore
  ) {}

  private stored(): StoredProvider[] {
    return this.settings.snapshot().cloud.providers.flatMap((raw) => {
      const provider = raw['provider']
      if (typeof provider !== 'string' || provider === '') return []
      const baseUrl = raw['base_url']
      const headers = Array.isArray(raw['custom_headers']) ? raw['custom_headers'] : []
      const models = Array.isArray(raw['models']) ? raw['models'] : []
      return [
        {
          provider,
          base_url: typeof baseUrl === 'string' ? baseUrl : null,
          custom_headers: headers.filter(
            (h): h is CustomHeader =>
              typeof (h as CustomHeader)?.header === 'string' &&
              typeof (h as CustomHeader)?.value === 'string'
          ),
          models: models.filter((m): m is string => typeof m === 'string'),
        },
      ]
    })
  }

  list(): CloudProviderView[] {
    return this.stored().map((p) => ({ ...p, has_api_key: this.keys.has(p.provider) }))
  }

  get(provider: string): CloudProviderView | undefined {
    return this.list().find((p) => p.provider === provider)
  }

  /** Register or replace a provider. Everything but the key is replaced wholesale, as the app does. */
  async upsert(input: CloudProviderInput): Promise<CloudProviderView> {
    const provider = validate(input)
    const next: StoredProvider = {
      provider,
      base_url: input.base_url === undefined || input.base_url === null ? null : input.base_url.trim(),
      custom_headers: (input.custom_headers ?? []).map((h) => ({ header: h.header, value: h.value })),
      models: [...(input.models ?? [])],
    }
    return this.serialize(async () => {
      const list = this.stored()
      const at = list.findIndex((p) => p.provider === provider)
      if (at >= 0) list[at] = next
      else list.push(next)
      const oldKey = this.keys.record(provider)
      // Publish the new key with a binding before changing settings. A router
      // reading between the two writes (or after a crash) sees a mismatch and
      // cannot send either key to the wrong destination.
      await this.keys.setBound(
        provider,
        input.api_key === undefined ? oldKey?.api_key : input.api_key,
        binding(next)
      )
      try {
        await this.settings.setCloudProviders(list as unknown as Record<string, unknown>[])
      } catch (e) {
        await this.keys.restore(provider, oldKey)
        throw e
      }
      return { ...next, has_api_key: this.keys.has(provider) }
    })
  }

  /** Missing is success, like the app's `unregister_provider_config`. */
  async remove(provider: string): Promise<void> {
    await this.serialize(async () => {
      const list = this.stored()
      const kept = list.filter((p) => p.provider !== provider)
      const oldKey = this.keys.record(provider)
      await this.keys.remove(provider)
      try {
        if (kept.length !== list.length)
          await this.settings.setCloudProviders(kept as unknown as Record<string, unknown>[])
      } catch (e) {
        await this.keys.restore(provider, oldKey)
        throw e
      }
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutation.then(operation)
    this.mutation = result.then(
      () => {},
      () => {}
    )
    return result
  }

  /** What the router matches models against. */
  routing(): ReadonlyMap<string, RemoteProvider> {
    return new Map(
      this.stored().flatMap((p): [string, RemoteProvider][] => {
        const key = this.keys.record(p.provider)
        if (key?.bound_to !== undefined && key.bound_to !== binding(p)) return []
        return [
          [
            p.provider,
            {
              provider: p.provider,
              apiKey: key?.api_key ?? null,
              baseUrl: p.base_url,
              customHeaders: p.custom_headers,
              models: p.models,
            },
          ],
        ]
      })
    )
  }
}

function validate(input: CloudProviderInput): string {
  const provider = typeof input?.provider === 'string' ? input.provider.trim() : ''
  if (provider === '') throw new AtomicCoreError('INVALID_ARGUMENT', 'a cloud provider needs a name')
  if (LOCAL_PROVIDERS.has(provider))
    throw new AtomicCoreError('INVALID_ARGUMENT', `"${provider}" is a local engine, not a cloud provider`)
  if (
    input.models !== undefined &&
    (!Array.isArray(input.models) || input.models.some((m) => typeof m !== 'string'))
  )
    throw new AtomicCoreError('INVALID_ARGUMENT', 'models must be a list of model ids')
  if (
    input.custom_headers !== undefined &&
    (!Array.isArray(input.custom_headers) ||
      input.custom_headers.some((h) => typeof h?.header !== 'string' || typeof h?.value !== 'string'))
  )
    throw new AtomicCoreError('INVALID_ARGUMENT', 'custom_headers must be a list of {header, value}')
  if (input.base_url !== undefined && input.base_url !== null && typeof input.base_url !== 'string')
    throw new AtomicCoreError('INVALID_ARGUMENT', 'base_url must be a string')
  if (input.api_key !== undefined && input.api_key !== null && typeof input.api_key !== 'string')
    throw new AtomicCoreError('INVALID_ARGUMENT', 'api_key must be a string')
  return provider
}
