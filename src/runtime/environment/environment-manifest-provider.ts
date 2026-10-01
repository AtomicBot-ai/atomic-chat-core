/**
 * Getting the Linux environment manifest onto disk and keeping the right one in play (openspec
 * change `extract-environment-manifest`, task 2.2; spec `runtime-environment-manifest`, "Core
 * получает, проверяет и кэширует манифест окружения", "Операция закрепляет манифест окружения").
 *
 * The same mechanism as the runtime descriptor's (`cached-document.ts`, design D3): accepted only
 * when it parses and its `minimum_core_version` is no higher than this build's; cached forever by
 * `manifest_id` in the shared per-user root, so an app core and a CLI core read the same cache; the
 * latest accepted one stands in when the network is down, the document is invalid, or it needs a
 * newer core. `ATOMIC_ENVIRONMENT_MANIFEST_URL` (`file://`, `https://`) overrides the source.
 *
 * Only Linux's manifest is ever read — the default source is `runtimes/environments/linux.json` and
 * the parser accepts nothing but `platform: linux` — so a manifest conf adds or changes for another
 * platform never reaches this core (design D1).
 *
 * Two ways in, one per moment of an operation (design D4): `latest()` before the consent — the
 * newest manifest, so a plan built now is judged against what conf says now; `pinned(id)` after it —
 * exactly the consented manifest, from the cache alone, so neither a sign-in wait nor a core
 * restart can swap the distribution list a user agreed to.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { EnvironmentManifest } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import {
  createCachedDocuments,
  documentFetchFromFetch,
  type CachedDocumentOptions,
  type DocumentFetch,
} from './cached-document.js'
import { parseEnvironmentManifest } from './environment-manifest.js'

/** Overrides the manifest source: `file://…` is read from disk, `https://…` is fetched. */
export const ENVIRONMENT_MANIFEST_URL_ENV = 'ATOMIC_ENVIRONMENT_MANIFEST_URL'

/** conf main, the published Linux environment manifest. */
export const DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/environments/linux.json'

/** A transport over a `fetch`-compatible function with an abort-on-timeout. */
export function environmentManifestFetchFromFetch(fetchImpl: typeof fetch): DocumentFetch {
  return documentFetchFromFetch(fetchImpl, 'Environment manifest')
}

export type EnvironmentManifestProviderOptions = Omit<CachedDocumentOptions, 'url'> & {
  /** The shared per-user managed root (`managedSharedRoot`); both scopes share one cache. */
  root: string
  /** Default source when no override is set; defaults to the published Linux manifest. */
  url?: string
}

export type EnvironmentManifestResult =
  { kind: 'available'; manifest: EnvironmentManifest } | { kind: 'unavailable'; error: AtomicCoreError }

export interface EnvironmentManifestProvider {
  /**
   * The manifest a plan built before the consent uses: fetched from the configured source, or —
   * without ever surfacing that as an error — the latest one accepted before. `unavailable` only
   * when nothing acceptable was fetched and nothing was ever cached. The only call that reaches
   * the network.
   */
  latest(): Promise<EnvironmentManifestResult>
  /** The manifest with this exact id, from the cache alone: never `fetch`, never `readFile`. */
  pinned(manifestId: string): Promise<EnvironmentManifestResult>
}

const unavailable = (message: string, details?: string): EnvironmentManifestResult => ({
  kind: 'unavailable',
  error: new AtomicCoreError('MANAGED_METADATA_INVALID', message, details),
})

export function createEnvironmentManifestProvider(
  options: EnvironmentManifestProviderOptions
): EnvironmentManifestProvider {
  const { root, url, ...rest } = options
  const paths = managedSharedPaths(root)
  const documents = createCachedDocuments<EnvironmentManifest>(
    {
      label: 'Environment manifest',
      urlEnv: ENVIRONMENT_MANIFEST_URL_ENV,
      parse: parseEnvironmentManifest,
      idField: 'manifest_id',
      id: (manifest) => manifest.manifest_id,
      minimumCoreVersion: (manifest) => manifest.minimum_core_version,
      cacheDir: paths.environmentManifestsDir,
      cacheFile: paths.environmentManifestFile,
      latestFile: paths.environmentManifestLatestFile,
    },
    { ...rest, url: url ?? DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL }
  )

  return {
    async latest(): Promise<EnvironmentManifestResult> {
      const latest = await documents.latest()
      switch (latest.kind) {
        case 'fresh':
        case 'cached':
          return { kind: 'available', manifest: latest.document }
        case 'too-new':
          return unavailable(
            'The published environment manifest requires a newer version of Atomic Chat, and no earlier one is cached.',
            latest.id
          )
        case 'none':
          return unavailable(
            'No environment manifest is available: it could not be fetched and nothing has been cached yet.'
          )
      }
    },

    async pinned(manifestId: string): Promise<EnvironmentManifestResult> {
      const cached = await documents.cached(manifestId)
      if (cached !== null) return { kind: 'available', manifest: cached }
      return unavailable(
        'The environment manifest this operation was approved with is no longer cached.',
        manifestId
      )
    },
  }
}
