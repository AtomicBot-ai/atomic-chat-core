/**
 * The release catalog of the `atomic-prism` provider (PrismML-Eng/llama.cpp builds), pure half.
 *
 * Source of truth: `atomic-chat-conf/backends/atomic-prism-manifest.json` (schema
 * `atomic-prism-schema.json` next to it). Every release is pinned by tag, commit and per-asset
 * sha256; an asset reaches users only once it is `approved` (real-hardware acceptance), unless the
 * user opted into unverified builds. A release whose `min_core_version` is newer than this core, or
 * that was `withdrawn`, is never offered — a pack already installed from it is left alone.
 *
 * Parsing is lenient per entry and strict per field: a malformed release or asset is dropped, the
 * rest of the document survives. A document with a newer `schema_version` is refused whole, so the
 * caller falls back to its disk cache or the bundled baseline.
 */

import type { BackendVersion } from '../types.js'
import { compareVersions } from '../version.js'

export const PRISM_MANIFEST_URL =
  'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/atomic-prism-manifest.json'
export const PRISM_DOWNLOAD_BASE = 'https://github.com/PrismML-Eng/llama.cpp/releases/download'
export const PRISM_MANIFEST_SCHEMA_VERSION = 1
/** `prism-b<build>-<sha7>`, the only tag shape PrismML publishes. */
export const PRISM_TAG_RE = /^prism-b(\d+)-([0-9a-f]{7})$/

export type PrismValidation = 'candidate' | 'approved'
export type PrismCapability = 'q1_0' | 'q2_0_g64' | 'pq2_0' | 'ptq1_0' | 'hadamard' | 'vision'

const CAPABILITIES: ReadonlySet<string> = new Set([
  'q1_0',
  'q2_0_g64',
  'pq2_0',
  'ptq1_0',
  'hadamard',
  'vision',
])

export interface PrismAsset {
  /** Stable backend id, e.g. `macos-arm64`, `win-cuda-12.4-x64`, `win-cudart-12.4-x64`. */
  backend: string
  name: string
  size: number
  sha256: string
  validation: PrismValidation
  /** A runtime library pack (`cudart-*`) installed into its main pack, never offered on its own. */
  companion?: boolean
  /** The companion this pack needs in the same directory. */
  companion_backend?: string
  min_driver?: string
  min_compute_capability?: string
}

export interface PrismRelease {
  tag: string
  commit: string
  published_at: string
  min_core_version: string
  notes_url: string
  notes?: string
  supersedes?: string[]
  withdrawn?: { reason: string }
  capabilities: PrismCapability[]
  assets: PrismAsset[]
}

export interface PrismManifest {
  schema_version: 1
  updated_at: string
  upstream_repo: string
  download_base?: string
  releases: PrismRelease[]
}

/** What decides whether an entry is offered on this host. */
export interface PrismOfferOptions {
  coreVersion: string
  /** The user's `allow_candidate_builds`: offer `candidate` assets too. */
  allowCandidates: boolean
}

/** Build number of a Prism tag, `null` for any other shape. */
export function prismTagBuild(tag: string): number | null {
  const match = PRISM_TAG_RE.exec(tag)
  return match ? Number(match[1]) : null
}

const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function parseAsset(raw: unknown): PrismAsset | null {
  if (!isRecord(raw)) return null
  const { backend, name, size, sha256, validation } = raw
  if (!isString(backend) || !isString(name)) return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return null
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  if (validation !== 'candidate' && validation !== 'approved') return null
  const asset: PrismAsset = { backend, name, size, sha256, validation }
  if (raw['companion'] === true) asset.companion = true
  if (isString(raw['companion_backend'])) asset.companion_backend = raw['companion_backend']
  if (isString(raw['min_driver'])) asset.min_driver = raw['min_driver']
  if (isString(raw['min_compute_capability'])) asset.min_compute_capability = raw['min_compute_capability']
  return asset
}

function parseRelease(raw: unknown): PrismRelease | null {
  if (!isRecord(raw)) return null
  const { tag, commit, published_at, min_core_version, notes_url } = raw
  if (!isString(tag) || prismTagBuild(tag) === null) return null
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null
  if (!isString(published_at) || !isString(min_core_version) || !isString(notes_url)) return null
  const assets = Array.isArray(raw['assets']) ? raw['assets'].map(parseAsset) : []
  const capabilities = Array.isArray(raw['capabilities'])
    ? raw['capabilities'].filter((c): c is PrismCapability => typeof c === 'string' && CAPABILITIES.has(c))
    : []
  const release: PrismRelease = {
    tag,
    commit,
    published_at,
    min_core_version,
    notes_url,
    capabilities,
    assets: assets.filter((a): a is PrismAsset => a !== null),
  }
  if (isString(raw['notes'])) release.notes = raw['notes']
  if (Array.isArray(raw['supersedes'])) release.supersedes = raw['supersedes'].filter(isString)
  const withdrawn = raw['withdrawn']
  if (isRecord(withdrawn) && isString(withdrawn['reason']))
    release.withdrawn = { reason: withdrawn['reason'] }
  return release
}

/** A parsed manifest, or `null` for anything that is not one this core understands. */
export function parsePrismManifest(value: unknown): PrismManifest | null {
  if (!isRecord(value)) return null
  if (value['schema_version'] !== PRISM_MANIFEST_SCHEMA_VERSION) return null
  if (!Array.isArray(value['releases'])) return null
  const manifest: PrismManifest = {
    schema_version: 1,
    updated_at: isString(value['updated_at']) ? value['updated_at'] : '',
    upstream_repo: isString(value['upstream_repo']) ? value['upstream_repo'] : '',
    releases: value['releases'].map(parseRelease).filter((r): r is PrismRelease => r !== null),
  }
  if (isString(value['download_base'])) manifest.download_base = value['download_base']
  return manifest
}

/** Not withdrawn and runnable by this core. */
export function prismReleaseOffered(
  release: PrismRelease,
  options: Pick<PrismOfferOptions, 'coreVersion'>
): boolean {
  return !release.withdrawn && compareVersions(options.coreVersion, release.min_core_version) >= 0
}

/**
 * Whether one asset of an offered release may be offered: never a companion on its own, never a pack
 * whose companion is missing from the release, `candidate` only on opt-in (and then for both halves).
 */
export function prismAssetOffered(
  release: PrismRelease,
  asset: PrismAsset,
  options: Pick<PrismOfferOptions, 'allowCandidates'>
): boolean {
  if (asset.companion) return false
  const validated = (a: PrismAsset) => a.validation === 'approved' || options.allowCandidates
  if (!validated(asset)) return false
  if (!asset.companion_backend) return true
  const companion = release.assets.find((a) => a.backend === asset.companion_backend)
  return !!companion && validated(companion)
}

/** Every offered `<tag>/<backend>` pair, newest build first; the hardware gate is applied later. */
export function prismCatalogToBackends(
  manifest: PrismManifest,
  options: PrismOfferOptions
): BackendVersion[] {
  const out: BackendVersion[] = []
  const releases = [...manifest.releases].sort(
    (a, b) => (prismTagBuild(b.tag) ?? 0) - (prismTagBuild(a.tag) ?? 0)
  )
  for (const release of releases) {
    if (!prismReleaseOffered(release, options)) continue
    for (const asset of release.assets) {
      if (prismAssetOffered(release, asset, options))
        out.push({ version: release.tag, backend: asset.backend })
    }
  }
  return out
}

export function findPrismRelease(manifest: PrismManifest, tag: string): PrismRelease | undefined {
  return manifest.releases.find((r) => r.tag === tag)
}

/** One archive to download for a pack: where from, what it must hash to, and whether it is the companion. */
export interface PrismArchiveSource {
  name: string
  url: string
  sha256: string
  size: number
  companion: boolean
}

/**
 * The archives that make up `<tag>/<backend>`: the pack itself, then its companion. `null` when the
 * manifest does not list the pack (or lists its companion as missing) — the caller refuses to install
 * an unpinned archive rather than guess a URL.
 */
export function prismArchiveSources(
  manifest: PrismManifest,
  tag: string,
  backend: string
): PrismArchiveSource[] | null {
  const release = findPrismRelease(manifest, tag)
  const asset = release?.assets.find((a) => a.backend === backend && !a.companion)
  if (!release || !asset) return null
  const base = (manifest.download_base ?? PRISM_DOWNLOAD_BASE).replace(/\/+$/, '')
  const source = (a: PrismAsset, companion: boolean): PrismArchiveSource => ({
    name: a.name,
    url: `${base}/${release.tag}/${a.name}`,
    sha256: a.sha256,
    size: a.size,
    companion,
  })
  const sources = [source(asset, false)]
  if (asset.companion_backend) {
    const companion = release.assets.find((a) => a.backend === asset.companion_backend)
    if (!companion) return null
    sources.push(source(companion, true))
  }
  return sources
}
