/**
 * The TurboQuant fork's release catalog, pure half. Port of the decision halves of
 * `extensions/llamacpp-extension/src/backend.ts` (`compareSemver`, `satisfiesMinAppVersion`,
 * `normalizeVariants`, `parseReleaseIndex`, `sortReleasesNewestFirst`, `fetchFromReleaseIndex`,
 * `fetchFromLatestRedirect`, `fetchFromLegacyManifest`, `fetchRemoteBackends`, `readDiskCache`).
 *
 * The fork points at AtomicBot-ai/atomic-llama-cpp-turboquant. Which releases exist and which
 * variants each carries is resolved at runtime from `index.json`, published as an asset of every
 * release; `/releases/latest` is GitHub's own pointer at the newest non-prerelease, so no tag is ever
 * hardcoded and a new fork release reaches users without a new app build. Only stable releases of
 * the unified `b<upstream-build>-<fork-semver>` scheme are installable: `dev-latest` and the legacy
 * per-variant `turboquant-<id>-<sha>` releases are prereleases.
 *
 * Nothing here fetches or reads disk; `turboquant-catalog.ts` does, and hands the bytes here.
 */

import { AtomicCoreError } from '../../contracts/index.js'
import type { BackendVersion } from '../types.js'
import { isStableReleaseTag, turboquantDefaultAssetName } from '../turboquant.js'
import { stripBom } from '../version.js'

/** Redirects to `/releases/tag/<newest stable tag>`; used when index.json is absent. */
export const TURBOQUANT_LATEST_RELEASE_URL =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest'
/**
 * Legacy index channel (app ADR 2026-06-17). Read from `main` — not a pinned commit — so the
 * atomic-chat-conf repo can retarget the fork's tag without an app release.
 */
export const TURBOQUANT_LEGACY_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/turboquant-manifest.json'
/** Schema version of `index.json` this client understands. */
export const TURBOQUANT_INDEX_SCHEMA_VERSION = 1
/** How long a fetched catalog is served from memory before the network is asked again. */
export const TURBOQUANT_RELEASE_INDEX_TTL_MS = 60 * 60 * 1000

/** One platform/backend archive inside a release. */
export interface TurboquantVariant {
  id: string
  asset?: string
  size?: number
  sha256?: string
}

/** One release of the fork, as described by `index.json`. */
export interface TurboquantRelease {
  tag: string
  published_at?: string
  commit?: string
  prerelease?: boolean
  /** Minimum Atomic Chat version that can run this build; absent = any. */
  min_app_version?: string
  title?: string
  highlights?: string[]
  variants: TurboquantVariant[]
}

export type TurboquantCatalogSource = 'index' | 'redirect' | 'legacy-manifest' | 'disk-cache' | 'none'

export interface TurboquantCatalog {
  /** Newest stable tag the client accepted, or null when nothing is usable. */
  latest: string | null
  /** Stable, app-compatible releases, newest first. */
  releases: TurboquantRelease[]
  source: TurboquantCatalogSource
}

/** The shape of `<data>/llamacpp/release-index.cache.json`, byte-compatible with the extension's. */
export interface CachedTurboquantCatalog {
  fetched_at: number
  catalog: TurboquantCatalog
}

export const EMPTY_TURBOQUANT_CATALOG: Readonly<TurboquantCatalog> = Object.freeze({
  latest: null,
  releases: [],
  source: 'none',
})

/**
 * Numeric semver comparison over the leading `major.minor.patch`, ignoring any prerelease/build
 * suffix and a leading `v`. Returns <0, 0 or >0.
 */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string) =>
    (stripBom(v).trim().replace(/^v/, '').split(/[-+]/)[0] ?? '')
      .split('.')
      .map((part) => Number.parseInt(part, 10))
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = Number.isFinite(left[i]) ? (left[i] as number) : 0
    const r = Number.isFinite(right[i]) ? (right[i] as number) : 0
    if (l !== r) return l - r
  }
  return 0
}

/**
 * Whether this app build satisfies a release's `min_app_version`. Missing or unparseable
 * requirements pass: the field exists to stop an engine that needs newer CLI wiring from
 * auto-installing, not to gate on metadata the client failed to read. An unknown app version also
 * passes — refusing every release because the version is unavailable would be worse than the risk.
 */
export function satisfiesMinAppVersion(
  minAppVersion: string | undefined,
  appVersion: string | null | undefined
): boolean {
  if (!minAppVersion || typeof minAppVersion !== 'string') return true
  if (!appVersion) return true
  if (!/^\d+(\.\d+)*/.test(minAppVersion.trim().replace(/^v/, ''))) return true
  return compareSemver(appVersion, minAppVersion) >= 0
}

function normalizeVariants(raw: unknown): TurboquantVariant[] {
  if (!Array.isArray(raw)) return []
  const variants: TurboquantVariant[] = []
  for (const entry of raw as Array<Record<string, unknown> | null | undefined>) {
    const id = typeof entry?.id === 'string' ? entry.id.trim() : ''
    if (!id) continue
    variants.push({
      id,
      ...(typeof entry?.asset === 'string' ? { asset: entry.asset.trim() } : {}),
      ...(typeof entry?.size === 'number' ? { size: entry.size } : {}),
      ...(typeof entry?.sha256 === 'string' ? { sha256: entry.sha256 } : {}),
    })
  }
  return variants
}

/**
 * Newest first by `(upstream build, fork semver)` parsed out of the tag, which is authoritative
 * even when `published_at` is missing or a build was re-published out of order.
 */
function sortReleasesNewestFirst(releases: readonly TurboquantRelease[]): TurboquantRelease[] {
  const rank = (tag: string): number[] => {
    const match = /^b(\d+)-(\d+)\.(\d+)\.(\d+)$/.exec(tag)
    if (!match) return [0, 0, 0, 0]
    return match.slice(1).map((n) => Number.parseInt(n, 10))
  }
  return [...releases].sort((a, b) => {
    const left = rank(a.tag)
    const right = rank(b.tag)
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return (right[i] ?? 0) - (left[i] ?? 0)
    }
    return 0
  })
}

/**
 * Step 1: a fetched `index.json` payload → the stable, app-compatible catalog (`source: 'index'`),
 * or `null` when nothing in it is usable. Everything that is a prerelease, carries a non-unified
 * tag, needs a newer app or has no variants is dropped here rather than in the UI; a half-written
 * entry costs the entry, not the catalog. A `schema_version` newer than this client understands is
 * `INVALID_ARGUMENT`: a future schema may describe releases in ways this parser would misread, so
 * the caller falls through to the tag-only paths instead of guessing.
 */
export function parseTurboquantReleaseIndex(
  payload: unknown,
  appVersion: string | null | undefined,
  onInfo?: (message: string) => void
): TurboquantCatalog | null {
  const document = (payload ?? {}) as Record<string, unknown>
  const schemaVersion = document.schema_version
  if (typeof schemaVersion === 'number' && schemaVersion > TURBOQUANT_INDEX_SCHEMA_VERSION) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `index.json schema_version ${schemaVersion} is newer than supported ${TURBOQUANT_INDEX_SCHEMA_VERSION}`
    )
  }
  const rawReleases = document.releases
  if (!Array.isArray(rawReleases)) return null

  const releases: TurboquantRelease[] = []
  for (const entry of rawReleases as Array<Record<string, unknown> | null | undefined>) {
    const tag = typeof entry?.tag === 'string' ? entry.tag.trim() : ''
    if (!isStableReleaseTag(tag)) continue
    if (entry?.prerelease === true) continue
    const minAppVersion = typeof entry?.min_app_version === 'string' ? entry.min_app_version : undefined
    if (!satisfiesMinAppVersion(minAppVersion, appVersion)) {
      onInfo?.(
        `[fetchStableIndex] skipping ${tag}: needs app >= ${minAppVersion}, running ${appVersion ?? 'unknown'}`
      )
      continue
    }
    const variants = normalizeVariants(entry?.variants)
    if (variants.length === 0) continue

    releases.push({
      tag,
      ...(typeof entry?.published_at === 'string' ? { published_at: entry.published_at } : {}),
      ...(typeof entry?.commit === 'string' ? { commit: entry.commit } : {}),
      prerelease: false,
      ...(minAppVersion !== undefined ? { min_app_version: minAppVersion } : {}),
      ...(typeof entry?.title === 'string' ? { title: entry.title } : {}),
      ...(Array.isArray(entry?.highlights)
        ? { highlights: (entry.highlights as unknown[]).filter((h): h is string => typeof h === 'string') }
        : {}),
      variants,
    })
  }
  if (releases.length === 0) return null
  const sorted = sortReleasesNewestFirst(releases)
  return { latest: (sorted[0] as TurboquantRelease).tag, releases: sorted, source: 'index' }
}

/**
 * Step 2: no index.json yet. The URL `/releases/latest` redirected to names the newest stable tag
 * without any API call; the variant list is synthesised from the fork's asset naming for the ids
 * this host supports (`null` when it supports none). A final URL that is not a `/releases/tag/`
 * page, or one naming a prerelease, is `INVALID_ARGUMENT` — the caller moves to the next source.
 */
export function catalogFromLatestRedirect(
  finalUrl: string,
  supportedIds: readonly string[],
  platform: NodeJS.Platform = process.platform
): TurboquantCatalog | null {
  const match = /\/releases\/tag\/([^/?#]+)/.exec(finalUrl)
  if (!match) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `could not read a release tag from the /releases/latest redirect (${finalUrl || 'no final URL'})`
    )
  }
  const tag = decodeURIComponent(match[1] ?? '').trim()
  if (!isStableReleaseTag(tag)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `/releases/latest resolved to non-stable tag '${tag}'`)
  }
  if (supportedIds.length === 0) return null
  return {
    latest: tag,
    releases: [
      {
        tag,
        prerelease: false,
        variants: supportedIds.map((id) => ({ id, asset: turboquantDefaultAssetName(id, platform) })),
      },
    ],
    source: 'redirect',
  }
}

/**
 * Step 3: the legacy atomic-chat-conf manifest (`{ commit, backends: [{ id, tag, asset }] }`), kept
 * until index.json ships everywhere. Entries are grouped by stable tag; `null` when none is stable.
 */
export function parseLegacyTurboquantManifest(payload: unknown): TurboquantCatalog | null {
  const manifest = (payload ?? {}) as Record<string, unknown>
  const entries = Array.isArray(manifest.backends) ? (manifest.backends as unknown[]) : []
  const byTag = new Map<string, TurboquantVariant[]>()
  for (const raw of entries) {
    const entry = raw as Record<string, unknown> | null | undefined
    if (!entry || typeof entry.id !== 'string' || typeof entry.tag !== 'string') continue
    if (!isStableReleaseTag(entry.tag)) continue
    const variants = byTag.get(entry.tag) ?? []
    variants.push({
      id: entry.id.trim(),
      ...(typeof entry.asset === 'string' ? { asset: entry.asset } : {}),
    })
    byTag.set(entry.tag, variants)
  }
  if (byTag.size === 0) return null
  const releases = sortReleasesNewestFirst(
    [...byTag.entries()].map(([tag, variants]) => ({
      tag,
      prerelease: false,
      ...(typeof manifest.commit === 'string' ? { commit: manifest.commit } : {}),
      variants,
    }))
  )
  return { latest: (releases[0] as TurboquantRelease).tag, releases, source: 'legacy-manifest' }
}

/**
 * The installable stable builds for this host, as `BackendVersion[]` (`order: 0`, catalog order).
 * `supportedIds` encodes OS/arch plus the detected GPU tier, so the user never sees a variant the
 * hardware cannot run; an empty set yields `[]`, the app's "undetectable hardware" answer.
 */
export function turboquantCatalogToBackends(
  catalog: TurboquantCatalog,
  supportedIds: readonly string[]
): BackendVersion[] {
  const supported = new Set(supportedIds)
  if (supported.size === 0) return []
  const backends: BackendVersion[] = []
  for (const release of catalog.releases) {
    for (const variant of release.variants) {
      if (!supported.has(variant.id)) continue
      backends.push({ version: release.tag, backend: variant.id, order: 0 })
    }
  }
  return backends
}

/**
 * The disk cache the extension wrote (`{ fetched_at, catalog }`), or `null` when the text is not
 * that shape. Lenient on purpose, exactly like the extension's `readDiskCache`: the file is our own.
 */
export function parseCachedTurboquantCatalog(raw: string | null | undefined): CachedTurboquantCatalog | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(stripBom(raw)) as { fetched_at?: unknown; catalog?: unknown } | null
    const catalog = parsed?.catalog as Partial<TurboquantCatalog> | undefined
    if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.releases)) return null
    return {
      fetched_at: typeof parsed?.fetched_at === 'number' ? parsed.fetched_at : 0,
      catalog: {
        latest: typeof catalog.latest === 'string' ? catalog.latest : null,
        releases: catalog.releases as TurboquantRelease[],
        source: (catalog.source ?? 'none') as TurboquantCatalogSource,
      },
    }
  } catch {
    return null
  }
}
