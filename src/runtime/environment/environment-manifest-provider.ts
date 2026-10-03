/**
 * Getting this platform's environment manifest onto disk and keeping the right one in play (openspec
 * change `extract-environment-manifest`, task 2.2; spec `runtime-environment-manifest`, "Core
 * получает, проверяет и кэширует манифест окружения", "Операция закрепляет манифест окружения").
 *
 * The same mechanism as the runtime descriptor's (`cached-document.ts`, design D3): accepted only
 * when it parses and its `minimum_core_version` is no higher than this build's; cached forever by
 * `manifest_id` in the shared per-user root, so an app core and a CLI core read the same cache; the
 * latest accepted one stands in when the network is down, the document is invalid, or it needs a
 * newer core. `ATOMIC_ENVIRONMENT_MANIFEST_URL` (`file://`, `https://`) overrides the source.
 *
 * Only this core's own platform's manifest is ever read (change `add-tensorrt-llm-windows`, task
 * 2.1): `platform` picks both the default source (`runtimes/environments/<platform>.json`) and the
 * parser, which accepts nothing but that `platform` — so a manifest conf adds or changes for another
 * platform never reaches this core (design D1). One override variable serves both: a machine runs one
 * platform.
 *
 * Two ways in, one per moment of an operation (design D4): `latest()` before the consent — the
 * newest manifest, so a plan built now is judged against what conf says now; `pinned(id)` after it —
 * exactly the consented manifest, from the cache alone, so neither a sign-in wait nor a core
 * restart can swap the distribution list a user agreed to.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { EnvironmentPlatform } from '../../contracts/index.js'
import { managedSharedPaths } from '../../config/index.js'
import {
  createCachedDocuments,
  documentFetchFromFetch,
  type CachedDocumentOptions,
  type DocumentFetch,
} from './cached-document.js'
import { environmentManifestParser, type EnvironmentManifestByPlatform } from './environment-manifest.js'

/** Overrides the manifest source: `file://…` is read from disk, `https://…` is fetched. */
export const ENVIRONMENT_MANIFEST_URL_ENV = 'ATOMIC_ENVIRONMENT_MANIFEST_URL'

/** conf main, the published Linux environment manifest. */
export const DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/environments/linux.json'

/** conf main, the published Windows environment manifest (absent until the live acceptance, design D14). */
export const DEFAULT_WINDOWS_ENVIRONMENT_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/environments/windows.json'

/** conf main, the Windows on Arm manifest: its own file, which released (x64-only) cores never read. */
export const DEFAULT_WINDOWS_ARM64_ENVIRONMENT_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/runtimes/environments/windows-arm64.json'

const DEFAULT_URLS: Record<EnvironmentPlatform, string> = {
  linux: DEFAULT_LINUX_ENVIRONMENT_MANIFEST_URL,
  windows: DEFAULT_WINDOWS_ENVIRONMENT_MANIFEST_URL,
}

/** A transport over a `fetch`-compatible function with an abort-on-timeout. */
export function environmentManifestFetchFromFetch(fetchImpl: typeof fetch): DocumentFetch {
  return documentFetchFromFetch(fetchImpl, 'Environment manifest')
}

export type EnvironmentManifestProviderOptions<P extends EnvironmentPlatform = 'linux'> = Omit<
  CachedDocumentOptions,
  'url'
> & {
  /** Whose manifest this core reads: its own platform's. Linux when omitted. */
  platform?: P
  /** The machine's architecture: on Windows, `aarch64` reads the Windows on Arm manifest. */
  arch?: string | null
  /** The shared per-user managed root (`managedSharedRoot`); both scopes share one cache. */
  root: string
  /** Default source when no override is set; defaults to the platform's published manifest. */
  url?: string
}

export type EnvironmentManifestResult<P extends EnvironmentPlatform = 'linux'> =
  | { kind: 'available'; manifest: EnvironmentManifestByPlatform[P] }
  | { kind: 'unavailable'; error: AtomicCoreError }

export interface EnvironmentManifestProvider<P extends EnvironmentPlatform = 'linux'> {
  /**
   * The manifest a plan built before the consent uses: fetched from the configured source, or —
   * without ever surfacing that as an error — the latest one accepted before. `unavailable` only
   * when nothing acceptable was fetched and nothing was ever cached. The only call that reaches
   * the network.
   */
  latest(): Promise<EnvironmentManifestResult<P>>
  /** The manifest with this exact id, from the cache alone: never `fetch`, never `readFile`. */
  pinned(manifestId: string): Promise<EnvironmentManifestResult<P>>
}

const unavailable = <P extends EnvironmentPlatform>(
  message: string,
  details?: string
): EnvironmentManifestResult<P> => ({
  kind: 'unavailable',
  error: new AtomicCoreError('MANAGED_METADATA_INVALID', message, details),
})

export function createEnvironmentManifestProvider<P extends EnvironmentPlatform = 'linux'>(
  options: EnvironmentManifestProviderOptions<P>
): EnvironmentManifestProvider<P> {
  const { root, url, platform: chosen, arch, ...rest } = options
  const platform = (chosen ?? 'linux') as P
  const paths = managedSharedPaths(root)
  const documents = createCachedDocuments<EnvironmentManifestByPlatform[P]>(
    {
      label: 'Environment manifest',
      urlEnv: ENVIRONMENT_MANIFEST_URL_ENV,
      parse: environmentManifestParser(platform),
      idField: 'manifest_id',
      id: (manifest) => manifest.manifest_id,
      minimumCoreVersion: (manifest) => manifest.minimum_core_version,
      cacheDir: paths.environmentManifestsDir,
      cacheFile: paths.environmentManifestFile,
      latestFile: paths.environmentManifestLatestFile,
    },
    {
      ...rest,
      url:
        url ??
        (platform === 'windows' && arch === 'aarch64'
          ? DEFAULT_WINDOWS_ARM64_ENVIRONMENT_MANIFEST_URL
          : DEFAULT_URLS[platform]),
    }
  )

  return {
    async latest(): Promise<EnvironmentManifestResult<P>> {
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

    async pinned(manifestId: string): Promise<EnvironmentManifestResult<P>> {
      const cached = await documents.cached(manifestId)
      if (cached !== null) return { kind: 'available', manifest: cached }
      return unavailable(
        'The environment manifest this operation was approved with is no longer cached.',
        manifestId
      )
    },
  }
}
