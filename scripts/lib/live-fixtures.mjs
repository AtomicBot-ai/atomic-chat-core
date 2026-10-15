// Pure helpers for `scripts/fetch-live-fixtures.mjs`: which release asset a host runs, which release
// to take from a newest-first listing, and whether downloaded bytes match the asset's digest.
// Kept free of I/O so `test/contract/live-fixtures.test.ts` can pin them.

/** Default source of the binaries: ggml-org's releases. Any repo with the same asset names works. */
export const DEFAULT_RELEASE_REPO = 'ggml-org/llama.cpp'

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Release asset for a host, in the naming llama.cpp publishes (macOS and Linux ship `.tar.gz`,
 * Windows `.zip`) — the CPU build of the same mapping `src/backend/catalog/archive.ts` encodes.
 * `exactName` (ATOMIC_LIVE_ASSET) replaces the pattern with that one asset name.
 */
export function assetPatternFor(platform, arch, exactName) {
  if (exactName) return new RegExp(`^${escape(exactName)}$`)
  const a = arch === 'arm64' ? 'arm64' : 'x64'
  if (platform === 'win32') return new RegExp(`^llama-b\\d+-bin-win-cpu-${a}\\.zip$`)
  if (platform === 'darwin') return new RegExp(`^llama-b\\d+-bin-macos-${a}\\.tar\\.gz$`)
  return new RegExp(`^llama-b\\d+-bin-ubuntu-${a}\\.tar\\.gz$`)
}

/**
 * The first release (newest first, as the API lists them) that carries an asset for `pattern`.
 * ggml-org marks its `bNNNN` builds as prereleases and points `latest` at an asset-less release, so
 * a listing is walked instead of asking for `releases/latest`; drafts are never taken.
 */
export function pickRelease(releases, pattern) {
  for (const release of releases) {
    if (release.draft) continue
    const asset = (release.assets ?? []).find((a) => pattern.test(a.name))
    if (asset) return { release, asset }
  }
  return undefined
}

/**
 * Whether `sha256` (hex) matches an asset `digest` (`sha256:<hex>`). `undefined` when the release
 * publishes no digest, so the caller can record "not verified" rather than "verified".
 */
export function digestMatches(digest, sha256) {
  if (typeof digest !== 'string' || !digest.startsWith('sha256:')) return undefined
  return digest.slice('sha256:'.length).toLowerCase() === sha256.toLowerCase()
}
