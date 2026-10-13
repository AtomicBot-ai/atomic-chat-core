/**
 * The release list of the `llamacpp-upstream` provider (ggml-org/llama.cpp builds mirrored and
 * signed in atomic-chat-conf), pure half.
 *
 * Source of truth: `atomic-chat-conf/backends/llamacpp-upstream-releases.json` (schema
 * `llamacpp-upstream-releases-schema.json` next to it). Each release names the oldest core it runs
 * on (`min_core_version`) and each archive its `validation`; this core takes, per backend, the
 * newest release it meets whose archive is `approved` (or `candidate`, on opt-in). That is how an
 * engine update that needs a core change reaches only the cores that have it. A `withdrawn` release
 * is never offered — a pack already installed from it is left alone.
 *
 * The legacy single-tag `backends/manifest.json` reads as a one-release list every core runs: it is
 * what cores before the list follow, so conf only ever points it at such a release.
 *
 * Parsing is lenient per entry and strict per field, as for the PrismML manifest: a malformed
 * release or archive is dropped, the rest survives; a newer `schema_version` is refused whole.
 */

import type { ArchSuffix, BackendVersion, UpstreamManifest } from '../types.js'
import { compareVersions } from '../version.js'
import { parseManifestForPlatform } from './manifest.js'

export const LLAMACPP_UPSTREAM_RELEASES_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/llamacpp-upstream-releases.json'
export const UPSTREAM_RELEASES_SCHEMA_VERSION = 1
/** `min_core_version` of a release every core runs, and of the legacy manifest read as a list. */
export const ANY_CORE_VERSION = '0.0.0'
const UPSTREAM_TAG_RE = /^b(\d+)$/

export type UpstreamValidation = 'candidate' | 'approved'

export interface UpstreamReleaseAsset {
  /** `llama-<tag>-bin-<backend>.<ext>`; the backend id is read from it. */
  name: string
  /** Always present in the list; absent only on a legacy-manifest asset that is not mirrored. */
  sha256?: string
  size?: number
  validation: UpstreamValidation
}

export interface UpstreamRelease {
  tag: string
  min_core_version: string
  withdrawn?: { reason: string }
  assets: UpstreamReleaseAsset[]
}

export interface UpstreamReleaseCatalog {
  schema_version: 1
  /** Absent only for a legacy manifest naming an unmirrored tag: downloads use the ggml-org CDN. */
  download_base?: string
  releases: UpstreamRelease[]
}

/** What decides whether a release is offered on this host. */
export interface UpstreamOfferOptions {
  coreVersion: string
  /** The user's `allow_candidate_builds`: offer `candidate` archives too. */
  allowCandidates: boolean
}

/** Build number of an upstream tag, `null` for any other shape. */
export function upstreamTagBuild(tag: string): number | null {
  const match = UPSTREAM_TAG_RE.exec(tag)
  return match ? Number(match[1]) : null
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function parseAsset(raw: unknown): UpstreamReleaseAsset | null {
  if (!isRecord(raw)) return null
  const { name, size, sha256, validation } = raw
  if (!isString(name)) return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return null
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  if (validation !== 'candidate' && validation !== 'approved') return null
  return { name, sha256, size, validation }
}

function parseRelease(raw: unknown): UpstreamRelease | null {
  if (!isRecord(raw)) return null
  const { tag, min_core_version } = raw
  if (!isString(tag) || upstreamTagBuild(tag) === null || !isString(min_core_version)) return null
  const assets = Array.isArray(raw['assets']) ? raw['assets'].map(parseAsset) : []
  const release: UpstreamRelease = {
    tag,
    min_core_version,
    assets: assets.filter((a): a is UpstreamReleaseAsset => a !== null),
  }
  const withdrawn = raw['withdrawn']
  if (isRecord(withdrawn) && isString(withdrawn['reason']))
    release.withdrawn = { reason: withdrawn['reason'] }
  return release
}

/** A parsed release list, or `null` for anything that is not one this core reads. */
export function parseUpstreamReleases(value: unknown): UpstreamReleaseCatalog | null {
  if (!isRecord(value)) return null
  if (value['schema_version'] !== UPSTREAM_RELEASES_SCHEMA_VERSION) return null
  if (!Array.isArray(value['releases'])) return null
  const catalog: UpstreamReleaseCatalog = {
    schema_version: 1,
    releases: value['releases'].map(parseRelease).filter((r): r is UpstreamRelease => r !== null),
  }
  if (isString(value['download_base'])) catalog.download_base = value['download_base']
  return catalog
}

/**
 * The legacy `backends/manifest.json` as a one-release list every core runs, or `null` when it has
 * no `tag_name`. Its archives count as approved: conf moves that file only to such a release.
 */
export function upstreamCatalogFromLegacyManifest(value: unknown): UpstreamReleaseCatalog | null {
  if (!isRecord(value) || !isString(value['tag_name'])) return null
  const assets: UpstreamReleaseAsset[] = []
  for (const raw of Array.isArray(value['assets']) ? value['assets'] : []) {
    if (!isRecord(raw) || !isString(raw['name'])) continue
    const asset: UpstreamReleaseAsset = { name: raw['name'], validation: 'approved' }
    if (typeof raw['sha256'] === 'string') asset.sha256 = raw['sha256']
    if (typeof raw['size'] === 'number') asset.size = raw['size']
    assets.push(asset)
  }
  const catalog: UpstreamReleaseCatalog = {
    schema_version: 1,
    releases: [{ tag: value['tag_name'], min_core_version: ANY_CORE_VERSION, assets }],
  }
  if (isString(value['download_base'])) catalog.download_base = value['download_base']
  return catalog
}

/** Not withdrawn and runnable by this core. */
export function upstreamReleaseOffered(
  release: UpstreamRelease,
  options: Pick<UpstreamOfferOptions, 'coreVersion'>
): boolean {
  return !release.withdrawn && compareVersions(options.coreVersion, release.min_core_version) >= 0
}

/** `approved`, or `candidate` on opt-in. */
export function upstreamAssetOffered(
  asset: UpstreamReleaseAsset,
  options: Pick<UpstreamOfferOptions, 'allowCandidates'>
): boolean {
  return asset.validation === 'approved' || options.allowCandidates
}

const newestFirst = (releases: readonly UpstreamRelease[]): UpstreamRelease[] =>
  [...releases].sort((a, b) => (upstreamTagBuild(b.tag) ?? 0) - (upstreamTagBuild(a.tag) ?? 0))

/**
 * Backends this host is offered: for each backend id, the newest offered release with an offered
 * archive for it, newest build first. The hardware gate is applied later.
 */
export function upstreamRemoteBackends(
  catalog: UpstreamReleaseCatalog,
  options: UpstreamOfferOptions,
  osType: string,
  archSuffix: ArchSuffix
): BackendVersion[] {
  const seen = new Set<string>()
  const out: BackendVersion[] = []
  for (const release of newestFirst(catalog.releases)) {
    if (!upstreamReleaseOffered(release, options)) continue
    const assets = release.assets.filter((a) => upstreamAssetOffered(a, options))
    for (const entry of parseManifestForPlatform({ tag_name: release.tag, assets }, osType, archSuffix)) {
      if (seen.has(entry.backend)) continue
      seen.add(entry.backend)
      out.push(entry)
    }
  }
  return out
}

/**
 * One listed release in the legacy manifest's shape, for `resolveBackendArchiveSource`: any listed
 * tag downloads from the mirror against its hash, whether or not it is offered right now (a pack
 * reinstalled from an older release, a candidate the user opted into). `null` for an unlisted tag.
 */
export function upstreamManifestForTag(
  catalog: UpstreamReleaseCatalog,
  tag: string
): UpstreamManifest | null {
  const release = catalog.releases.find((r) => r.tag === tag)
  if (!release) return null
  const manifest: UpstreamManifest = {
    tag_name: release.tag,
    assets: release.assets.map(({ name, sha256, size }) => ({
      name,
      ...(sha256 !== undefined ? { sha256 } : {}),
      ...(size !== undefined ? { size } : {}),
    })),
  }
  if (catalog.download_base) manifest.download_base = catalog.download_base
  return manifest
}
