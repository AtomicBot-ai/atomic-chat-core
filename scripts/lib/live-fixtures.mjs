// Pure helpers for `scripts/fetch-live-fixtures.mjs`: which release asset a host runs, which release
// to take from a newest-first listing, whether downloaded bytes match the asset's digest, and the env
// and model cache key of an engine's live run. Kept free of I/O so
// `test/contract/live-fixtures.test.ts` can pin them.
import { createHash } from 'node:crypto'

/** Default source of the binaries: ggml-org's releases. Any repo with the same asset names works. */
export const DEFAULT_RELEASE_REPO = 'ggml-org/llama.cpp'

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Release asset for a host, in the naming llama.cpp publishes (macOS and Linux ship `.tar.gz`,
 * Windows `.zip`) — the CPU build of the same mapping `src/backend/catalog/archive.ts` encodes.
 * `exactName` (ATOMIC_LIVE_ASSET) replaces the pattern with that one asset name. With `tag` the
 * pattern names that tag, which is how a fork with its own tags (PrismML's `prism-b<N>-<sha7>`,
 * `llama-prism-b10787-73bfe6c-bin-ubuntu-x64.tar.gz`) is fetched; without it, any `b<N>` build.
 */
export function assetPatternFor(platform, arch, exactName, tag) {
  if (exactName) return new RegExp(`^${escape(exactName)}$`)
  const a = arch === 'arm64' ? 'arm64' : 'x64'
  const prefix = tag ? `llama-${escape(tag)}-bin-` : 'llama-b\\d+-bin-'
  if (platform === 'win32') return new RegExp(`^${prefix}win-cpu-${a}\\.zip$`)
  if (platform === 'darwin') return new RegExp(`^${prefix}macos-${a}\\.tar\\.gz$`)
  return new RegExp(`^${prefix}ubuntu-${a}\\.tar\\.gz$`)
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

/**
 * The env an engine's live files read, from its config's `live_env`: each value is literal text or a
 * placeholder for what the fetch put on disk (`live.json`): `{engine_dir}`, `{tag}`, `{manifest}`,
 * `{model:<id>}`. A placeholder the fetch did not fill throws: a live run never starts half set up.
 */
export function expandLiveEnv(template, values) {
  const lookup = (name) => {
    const [kind, id] = name.split(':')
    const value = kind === 'model' ? values.models?.[id] : id === undefined ? values[kind] : undefined
    if (typeof value !== 'string' || value === '')
      throw new Error(`the fetch left no {${name}} for the live env`)
    return value
  }
  return Object.fromEntries(
    Object.entries(template).map(([key, value]) => [
      key,
      value.replace(/\{([a-z_]+(?::[A-Za-z0-9_.-]+)?)\}/g, (_, name) => lookup(name)),
    ])
  )
}

/**
 * The cache key of an engine's live models (`live_models`): their sha256 hashes, so a new model is a
 * new key and the same models share one entry across platforms. Empty when the engine names none.
 */
export function liveModelsKey(models) {
  if (!Array.isArray(models) || models.length === 0) return ''
  const hashes = models.map((m) => m.sha256).sort()
  return createHash('sha256').update(hashes.join('\n')).digest('hex').slice(0, 16)
}
