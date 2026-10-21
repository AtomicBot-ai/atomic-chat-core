// Which llama.cpp release a core version runs today: its "pin". A plain-JS mirror of
// src/backend/catalog/upstream-releases.ts (`parseUpstreamReleases`, `upstreamRemoteBackends`),
// manifest.ts (`parseManifestForPlatform`) and, for the PrismML fork (`atomic-prism`),
// prism-manifest.ts (`parsePrismManifest`, `prismCatalogToBackends`), for the scripts that cannot
// import TypeScript; test/contract/engine-pin.test.ts holds the two to the same answers.
//
// The pin of a platform is the release its CPU backend comes from: the newest release conf's
// `backends/llamacpp-upstream-releases.json` lists that is not withdrawn, that this core version
// meets (`min_core_version`), and whose archive for that backend is approved. Cores older than the
// list follow the legacy `backends/manifest.json` instead, which is reported next to it.

export const ANY_CORE_VERSION = '0.0.0'
export const UPSTREAM_RELEASES_SCHEMA_VERSION = 1

/** The platforms the candidate check runs on, with the CPU backend core installs there. */
export const PIN_PLATFORMS = [
  { platform: 'linux-x64', os: 'linux', arch: 'x64', backend: 'linux-cpu-x64' },
  { platform: 'linux-arm64', os: 'linux', arch: 'arm64', backend: 'linux-cpu-arm64' },
  { platform: 'macos-arm64', os: 'macos', arch: 'arm64', backend: 'macos-arm64' },
  { platform: 'windows-x64', os: 'windows', arch: 'x64', backend: 'win-cpu-x64' },
  { platform: 'windows-arm64', os: 'windows', arch: 'arm64', backend: 'win-cpu-arm64' },
]

const UPSTREAM_TAG_RE = /^b(\d+)$/

/** Build number of an upstream tag, `null` for any other shape. */
export function upstreamTagBuild(tag) {
  const match = UPSTREAM_TAG_RE.exec(tag)
  return match ? Number(match[1]) : null
}

const parseU32 = (s) => (/^\+?\d+$/.test(s) && Number(s) <= 4294967295 ? Number(s) : undefined)

/** Dotted-numeric comparison, an unparseable component counting as 0 (`compareVersions`). */
export function compareVersions(v1, v2) {
  const parts1 = v1.split('.')
  const parts2 = v2.split('.')
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const n1 = parseU32(parts1[i] ?? '') ?? 0
    const n2 = parseU32(parts2[i] ?? '') ?? 0
    if (n1 !== n2) return n1 < n2 ? -1 : 1
  }
  return 0
}

const isString = (v) => typeof v === 'string' && v.length > 0
const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

function parseAsset(raw) {
  if (!isRecord(raw)) return null
  const { name, size, sha256, validation } = raw
  if (!isString(name)) return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return null
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  if (validation !== 'candidate' && validation !== 'approved') return null
  return { name, sha256, size, validation }
}

function parseRelease(raw) {
  if (!isRecord(raw)) return null
  const { tag, min_core_version } = raw
  if (!isString(tag) || upstreamTagBuild(tag) === null || !isString(min_core_version)) return null
  const assets = Array.isArray(raw.assets) ? raw.assets.map(parseAsset) : []
  const release = { tag, min_core_version, assets: assets.filter((a) => a !== null) }
  if (isRecord(raw.withdrawn) && isString(raw.withdrawn.reason))
    release.withdrawn = { reason: raw.withdrawn.reason }
  return release
}

/** A parsed release list, or `null` for anything that is not one this core reads. */
export function parseUpstreamReleases(value) {
  if (!isRecord(value)) return null
  if (value.schema_version !== UPSTREAM_RELEASES_SCHEMA_VERSION) return null
  if (!Array.isArray(value.releases)) return null
  const catalog = {
    schema_version: 1,
    releases: value.releases.map(parseRelease).filter((r) => r !== null),
  }
  if (isString(value.download_base)) catalog.download_base = value.download_base
  return catalog
}

/** The legacy `backends/manifest.json` as a one-release list every core runs. */
export function upstreamCatalogFromLegacyManifest(value) {
  if (!isRecord(value) || !isString(value.tag_name)) return null
  const assets = []
  for (const raw of Array.isArray(value.assets) ? value.assets : []) {
    if (!isRecord(raw) || !isString(raw.name)) continue
    const asset = { name: raw.name, validation: 'approved' }
    if (typeof raw.sha256 === 'string') asset.sha256 = raw.sha256
    if (typeof raw.size === 'number') asset.size = raw.size
    assets.push(asset)
  }
  const catalog = {
    schema_version: 1,
    releases: [{ tag: value.tag_name, min_core_version: ANY_CORE_VERSION, assets }],
  }
  if (isString(value.download_base)) catalog.download_base = value.download_base
  return catalog
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const LINUX_BACKEND_BY_INFIX = {
  'ubuntu-x64': 'linux-cpu-x64',
  'ubuntu-vulkan-x64': 'linux-vulkan-x64',
  'ubuntu-arm64': 'linux-cpu-arm64',
  'ubuntu-vulkan-arm64': 'linux-vulkan-arm64',
}

function linuxBackendForUpstreamInfix(infix) {
  const listed = LINUX_BACKEND_BY_INFIX[infix]
  if (listed) return listed
  const m = /^ubuntu-cuda-(13\.\d+)-(arm64)$/.exec(infix)
  return m ? `linux-cuda-${m[1]}-${m[2]}` : undefined
}

const WINDOWS_ALLOWED = (name) =>
  name === 'win-cpu-x64' ||
  /^win-cuda-12\.\d+-x64$/.test(name) ||
  /^win-cuda-13\.\d+-x64$/.test(name) ||
  /^win-rocm-\d+\.\d+-x64$/.test(name) ||
  name === 'win-vulkan-x64' ||
  name === 'win-cpu-arm64' ||
  name === 'win-opencl-adreno-arm64' ||
  /^win-cuda-13\.\d+-arm64$/.test(name)

/** Backends a release offers an OS + arch (`parseManifestForPlatform`). */
export function parseManifestForPlatform(release, osType, archSuffix) {
  const tag = release.tag_name
  if (!tag) return []
  const assets = release.assets ?? []
  const escapedTag = escapeRegExp(tag)
  const backends = []
  const add = (backend) => backends.push({ version: tag, backend, order: 0 })
  if (osType === 'windows') {
    const re = new RegExp(`^llama-${escapedTag}-bin-(win-.+)\\.zip$`)
    for (const asset of assets) {
      const name = re.exec(asset.name)?.[1]
      if (name && WINDOWS_ALLOWED(name) && name.endsWith(`-${archSuffix}`)) add(name)
    }
  } else if (osType === 'linux') {
    const re = new RegExp(`^llama-${escapedTag}-bin-(ubuntu-.+)\\.tar\\.gz$`)
    for (const asset of assets) {
      const infix = re.exec(asset.name)?.[1]
      const name = infix ? linuxBackendForUpstreamInfix(infix) : undefined
      if (name && name.endsWith(`-${archSuffix}`)) add(name)
    }
  } else if (osType === 'macos') {
    const re = new RegExp(`^llama-${escapedTag}-bin-(macos-.+)\\.tar\\.gz$`)
    for (const asset of assets)
      if (re.exec(asset.name)?.[1] === `macos-${archSuffix}`) add(`macos-${archSuffix}`)
  }
  return backends
}

/** Not withdrawn and runnable by this core. */
export function upstreamReleaseOffered(release, options) {
  return !release.withdrawn && compareVersions(options.coreVersion, release.min_core_version) >= 0
}

/** For each backend id, the newest offered release with an offered archive for it. */
export function upstreamRemoteBackends(catalog, options, osType, archSuffix) {
  const seen = new Set()
  const out = []
  const newestFirst = [...catalog.releases].sort(
    (a, b) => (upstreamTagBuild(b.tag) ?? 0) - (upstreamTagBuild(a.tag) ?? 0)
  )
  for (const release of newestFirst) {
    if (!upstreamReleaseOffered(release, options)) continue
    const assets = release.assets.filter((a) => a.validation === 'approved' || options.allowCandidates)
    for (const entry of parseManifestForPlatform({ tag_name: release.tag, assets }, osType, archSuffix)) {
      if (seen.has(entry.backend)) continue
      seen.add(entry.backend)
      out.push(entry)
    }
  }
  return out
}

function pinsOf(catalog, coreVersion) {
  const out = {}
  for (const p of PIN_PLATFORMS) {
    const entries = upstreamRemoteBackends(catalog, { coreVersion, allowCandidates: false }, p.os, p.arch)
    out[p.platform] = entries.find((e) => e.backend === p.backend)?.version ?? null
  }
  return out
}

/**
 * The pin of `coreVersion` on every platform, from conf's release list and legacy manifest (raw
 * JSON values, either may be `undefined`). `source` says which one decided: the list when this core
 * reads it, as the catalog service does, else the legacy manifest.
 */
export function resolvePins({ releases, manifest, coreVersion }) {
  const list = releases === undefined ? null : parseUpstreamReleases(releases)
  const legacy = manifest === undefined ? null : upstreamCatalogFromLegacyManifest(manifest)
  const listPins = list ? pinsOf(list, coreVersion) : null
  const legacyPins = legacy ? pinsOf(legacy, coreVersion) : null
  const source = list ? 'list' : legacy ? 'legacy' : 'none'
  const chosen = listPins ?? legacyPins ?? Object.fromEntries(PIN_PLATFORMS.map((p) => [p.platform, null]))
  return {
    source,
    core_version: coreVersion,
    per_platform: Object.fromEntries(
      PIN_PLATFORMS.map((p) => [p.platform, { backend: p.backend, tag: chosen[p.platform] }])
    ),
    list: { readable: list !== null, per_platform: listPins },
    legacy: { tag: legacy?.releases[0]?.tag ?? null },
  }
}

// --- PrismML (atomic-prism) -------------------------------------------------------------------------
//
// conf's `backends/atomic-prism-manifest.json` lists PrismML-Eng/llama.cpp builds with a backend id on
// every asset; core downloads them from PrismML itself. The pin of a platform is the newest offered
// release whose CPU pack for it is approved, as `prismCatalogToBackends` offers them.

export const PRISM_MANIFEST_SCHEMA_VERSION = 1

/** Where PrismML publishes a build core installs (src/backend/select/prism.ts), with its CPU pack. */
export const PRISM_PIN_PLATFORMS = [
  { platform: 'linux-x64', os: 'linux', arch: 'x64', backend: 'linux-cpu-x64' },
  { platform: 'macos-arm64', os: 'macos', arch: 'arm64', backend: 'macos-arm64' },
  { platform: 'macos-x64', os: 'macos', arch: 'x64', backend: 'macos-x64' },
  { platform: 'windows-x64', os: 'windows', arch: 'x64', backend: 'win-cpu-x64' },
]

const PRISM_TAG_RE = /^prism-b(\d+)-[0-9a-f]{7}$/

/** Build number of a PrismML tag (`prism-b10787-73bfe6c` → 10787), `null` for any other shape. */
export function prismTagBuild(tag) {
  const match = PRISM_TAG_RE.exec(tag)
  return match ? Number(match[1]) : null
}

/**
 * Build number of a tag of any engine the check knows: `b11617`, `prism-b10787-73bfe6c` or
 * `master-883-137f740`. PrismML's number is the upstream build the fork is cut from, which is what
 * `--version` prints; sd.cpp's is the commit count of upstream's master.
 */
export function engineTagBuild(tag) {
  return upstreamTagBuild(tag) ?? prismTagBuild(tag) ?? sdcppTagBuild(tag)
}

function parsePrismAsset(raw) {
  if (!isRecord(raw)) return null
  const { backend, name, size, sha256, validation } = raw
  if (!isString(backend) || !isString(name)) return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) return null
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) return null
  if (validation !== 'candidate' && validation !== 'approved') return null
  const asset = { backend, name, size, sha256, validation }
  if (raw.companion === true) asset.companion = true
  if (isString(raw.companion_backend)) asset.companion_backend = raw.companion_backend
  return asset
}

function parsePrismRelease(raw) {
  if (!isRecord(raw)) return null
  const { tag, commit, published_at, min_core_version, notes_url } = raw
  if (!isString(tag) || prismTagBuild(tag) === null) return null
  if (typeof commit !== 'string' || !/^[0-9a-f]{40}$/.test(commit)) return null
  if (!isString(published_at) || !isString(min_core_version) || !isString(notes_url)) return null
  const assets = Array.isArray(raw.assets) ? raw.assets.map(parsePrismAsset) : []
  const release = { tag, commit, min_core_version, assets: assets.filter((a) => a !== null) }
  if (isRecord(raw.withdrawn) && isString(raw.withdrawn.reason))
    release.withdrawn = { reason: raw.withdrawn.reason }
  return release
}

/** A parsed PrismML manifest, or `null` for anything that is not one this core reads. */
export function parsePrismManifest(value) {
  if (!isRecord(value)) return null
  if (value.schema_version !== PRISM_MANIFEST_SCHEMA_VERSION) return null
  if (!Array.isArray(value.releases)) return null
  return { schema_version: 1, releases: value.releases.map(parsePrismRelease).filter((r) => r !== null) }
}

/** Offered assets of offered releases, newest build first, as `{ version, backend }` (`prismCatalogToBackends`). */
export function prismCatalogToBackends(manifest, options) {
  const validated = (a) => a.validation === 'approved' || options.allowCandidates
  const offered = (release, asset) => {
    if (asset.companion || !validated(asset)) return false
    if (!asset.companion_backend) return true
    const companion = release.assets.find((a) => a.backend === asset.companion_backend)
    return !!companion && validated(companion)
  }
  const out = []
  const newestFirst = [...manifest.releases].sort((a, b) => prismTagBuild(b.tag) - prismTagBuild(a.tag))
  for (const release of newestFirst) {
    if (!upstreamReleaseOffered(release, options)) continue
    for (const asset of release.assets)
      if (offered(release, asset)) out.push({ version: release.tag, backend: asset.backend })
  }
  return out
}

/**
 * The PrismML pin of `coreVersion` on every platform PrismML builds for, from conf's manifest (raw
 * JSON, may be `undefined`). The same shape as `resolvePins`; there is no legacy file.
 */
export function resolvePrismPins({ manifest, coreVersion }) {
  const parsed = manifest === undefined ? null : parsePrismManifest(manifest)
  const offered = parsed ? prismCatalogToBackends(parsed, { coreVersion, allowCandidates: false }) : []
  const pins = Object.fromEntries(
    PRISM_PIN_PLATFORMS.map((p) => [
      p.platform,
      offered.find((e) => e.backend === p.backend)?.version ?? null,
    ])
  )
  return {
    source: parsed ? 'prism-manifest' : 'none',
    core_version: coreVersion,
    per_platform: Object.fromEntries(
      PRISM_PIN_PLATFORMS.map((p) => [p.platform, { backend: p.backend, tag: pins[p.platform] }])
    ),
    list: { readable: parsed !== null, per_platform: parsed ? pins : null },
    legacy: { tag: null },
  }
}

// --- stable-diffusion.cpp (sd-cpp) ------------------------------------------------------------------
//
// conf's `backends/sdcpp-manifest.json` names one build, `tag_name`, for every core (no
// `min_core_version`). The pin of a platform is that tag when the manifest pins the platform's CPU
// archive with a sha256 and a size (`assetInstallable`); `parseSdcppPinManifest` mirrors
// `parseSdcppManifest` in src/engine-builds/manifest.ts.

/** Where sd.cpp ships a build core installs (src/engine-builds/select.ts), with its CPU archive. */
export const SDCPP_PIN_PLATFORMS = [
  { platform: 'linux-x64', os: 'linux', arch: 'x64', backend: 'linux-cpu-x64' },
  { platform: 'linux-arm64', os: 'linux', arch: 'arm64', backend: 'linux-cpu-arm64' },
  { platform: 'macos-arm64', os: 'macos', arch: 'arm64', backend: 'macos-arm64' },
  { platform: 'windows-x64', os: 'windows', arch: 'x64', backend: 'win-cpu-x64' },
  { platform: 'windows-arm64', os: 'windows', arch: 'arm64', backend: 'win-cpu-arm64' },
]

const SDCPP_TAG_RE = /^master-(\d+)-([0-9a-f]{7})(?:-a([0-9a-f]{7}))?$/

/**
 * `master-883-137f740-a36f1b1a` → its build (883), upstream commit (`137f740`), the upstream tag
 * (`master-883-137f740`) and the Atomic fork's rev (`36f1b1a`, `null` on a bare upstream tag).
 * `null` for any other shape.
 */
export function sdcppTagParts(tag) {
  const match = SDCPP_TAG_RE.exec(tag)
  if (!match) return null
  const [, build, sha7, rev] = match
  return { build: Number(build), sha7, upstream_tag: `master-${build}-${sha7}`, atomic_rev: rev ?? null }
}

/** Build number of an sd.cpp tag (`master-883-137f740` → 883), `null` for any other shape. */
export function sdcppTagBuild(tag) {
  return sdcppTagParts(tag)?.build ?? null
}

const SDCPP_BACKEND_RE = /^[a-z0-9.-]+$/
const SDCPP_ASSET_NAME_RE = /^[A-Za-z0-9._-]+\.(zip|tar\.gz|tgz)$/

/** conf's sd.cpp manifest as the core reads it, or `null` for anything it would refuse. */
export function parseSdcppPinManifest(value) {
  if (!isRecord(value)) return null
  const tag = value.tag_name
  if (typeof tag !== 'string' || !SDCPP_TAG_RE.test(tag)) return null
  if (!Array.isArray(value.assets)) return null
  const assets = []
  const seen = new Set()
  for (const raw of value.assets) {
    if (!isRecord(raw)) continue
    const { backend, name, sha256, size } = raw
    if (typeof backend !== 'string' || !SDCPP_BACKEND_RE.test(backend)) continue
    if (typeof name !== 'string' || !SDCPP_ASSET_NAME_RE.test(name)) continue
    if (seen.has(backend)) continue
    seen.add(backend)
    assets.push({
      backend,
      name,
      ...(typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256) ? { sha256 } : {}),
      ...(typeof size === 'number' && Number.isSafeInteger(size) && size > 0 ? { size } : {}),
      ...(raw.companion === true ? { companion: true } : {}),
    })
  }
  if (assets.length === 0) return null
  const manifest = { tag_name: tag, assets }
  if (typeof value.updated_at === 'string') manifest.updated_at = value.updated_at
  if (
    typeof value.upstream_repo === 'string' &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.upstream_repo)
  )
    manifest.upstream_repo = value.upstream_repo
  if (typeof value.download_base === 'string' && /^https:\/\/\S+$/.test(value.download_base))
    manifest.download_base = value.download_base.replace(/\/+$/, '')
  return manifest
}

/**
 * The sd.cpp pin on every platform core ships it for, from conf's manifest (raw JSON, may be
 * `undefined`). The same shape as `resolvePins`; there is no release list and no legacy file, and
 * `coreVersion` decides nothing: every core gets the manifest's build.
 */
export function resolveSdcppPins({ manifest, coreVersion }) {
  const parsed = manifest === undefined ? null : parseSdcppPinManifest(manifest)
  const pins = Object.fromEntries(
    SDCPP_PIN_PLATFORMS.map((p) => {
      const asset = parsed?.assets.find((a) => a.backend === p.backend)
      return [p.platform, asset?.sha256 && asset.size ? parsed.tag_name : null]
    })
  )
  return {
    source: parsed ? 'sdcpp-manifest' : 'none',
    core_version: coreVersion,
    per_platform: Object.fromEntries(
      SDCPP_PIN_PLATFORMS.map((p) => [p.platform, { backend: p.backend, tag: pins[p.platform] }])
    ),
    list: { readable: parsed !== null, per_platform: parsed ? pins : null },
    legacy: { tag: null },
  }
}
