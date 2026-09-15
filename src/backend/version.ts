/**
 * Version strings of backend packs. Port of the comparison helpers in
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs` (`compare_versions`,
 * `parse_backend_version`, `parse_binary_version`, `release_tag_rank`,
 * `compare_backend_versions_for_sort`, `validate_backend_string`) plus the `<version>/<backend>`
 * string helpers from `extensions/llamacpp-upstream-extension/src/{index,util}.ts`
 * (`stripBom`, `parseBuildNumber`, `isConcreteVersionBackend`).
 *
 * A "version" is normally a ggml-org release tag (`b10405`); a hand-placed directory or a
 * TurboQuant unified tag (`b10018-1.3.0`) is also accepted and ranks by install order instead.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type { BackendVersion } from './types.js'

/** Drop the BOM a settings read can leave behind and trim. */
export function stripBom(s: string): string {
  return s.replace(/\uFEFF/g, '').trim()
}

/** `str::parse::<u32>()`: optional `+`, digits only, ≤ 2^32 − 1. */
export function parseRustU32(s: string): number | undefined {
  if (!/^\+?\d+$/.test(s)) return undefined
  const n = Number(s)
  return n <= 4294967295 ? n : undefined
}

/**
 * Dotted-numeric comparison (`450.80.02` vs `525.60.13`). Each component is parsed as u32, an
 * unparseable or missing component counts as 0. Returns −1 / 0 / 1.
 */
export function compareVersions(v1: string, v2: string): -1 | 0 | 1 {
  const parts1 = v1.split('.')
  const parts2 = v2.split('.')
  const max = Math.max(parts1.length, parts2.length)
  for (let i = 0; i < max; i++) {
    const n1 = parseRustU32(parts1[i] ?? '') ?? 0
    const n2 = parseRustU32(parts2[i] ?? '') ?? 0
    if (n1 < n2) return -1
    if (n1 > n2) return 1
  }
  return 0
}

/**
 * Build number of a version string: leading non-digits are stripped and the rest must parse as a
 * whole u32, otherwise 0.
 *
 * Deliberate quirk (PLAN.md decision 15): `"b10018-1.3.0"` → `0`, not `10018`, because the
 * remainder `10018-1.3.0` is not a number. The app's `verify_backend_binary` relies on 0 meaning
 * "no build number to check", which is what lets TurboQuant unified tags through its launch gate.
 * Do not "fix" this before the app has left the Rust plugins (phase 6).
 */
export function parseBackendVersion(versionString: string): number {
  const numeric = versionString.replace(/^[^0-9]*/, '')
  return parseRustU32(numeric) ?? 0
}

/**
 * Ordering key for a ggml-org release tag (`bNNNNN`). `undefined` for anything that is not
 * `b<digits>` — a hand-placed directory, a TurboQuant tag — which then ranks by install order.
 */
export function releaseTagRank(version: string): number | undefined {
  if (!version.startsWith('b')) return undefined
  return parseRustU32(version.slice(1))
}

/**
 * Build number printed by `llama-server --version`. Two shapes exist:
 * `version: 10344 (a1b2c3d)` and, from b10405 on, `version: 0.1.0-dev (build 10405, commit a1b2c3d)`.
 * The first line starting with `version:` that yields a number wins.
 */
export function parseBinaryVersion(output: string): number | undefined {
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('version:')) continue
    const tokens = line
      .slice('version:'.length)
      .split(/\s+/)
      .filter((t) => t !== '')
    const first = tokens[0]
    if (first !== undefined) {
      const build = parseRustU32(first)
      if (build !== undefined) return build
    }
    const index = tokens.findIndex((t) => t.replace(/^\(+/, '') === 'build')
    if (index < 0) continue
    const next = tokens[index + 1]
    if (next === undefined) continue
    const build = parseRustU32(next.replace(/[^0-9]+$/, ''))
    if (build !== undefined) return build
  }
  return undefined
}

/** `^b(\d+)$` → build number, else `null` (app `parseBuildNumber`; stricter than `releaseTagRank`). */
export function parseBuildNumber(version: string): number | null {
  const match = /^b(\d+)$/.exec(version)
  return match ? parseInt(match[1] ?? '', 10) : null
}

export function isWindowsBackend(backend: string): boolean {
  return backend.startsWith('win-')
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Sort comparator: newest first. Release tags rank numerically (so `b9999` < `b10344` and an
 * installed build never outranks a newer remote one); a tagged build sorts before an untagged
 * one; two untagged Windows builds compare by `parseBackendVersion`; then install `order`
 * descending, version string descending, backend name ascending.
 */
export function compareBackendVersionsForSort(left: BackendVersion, right: BackendVersion): number {
  const leftRank = releaseTagRank(left.version)
  const rightRank = releaseTagRank(right.version)
  if (leftRank !== undefined && rightRank !== undefined) {
    if (rightRank !== leftRank) return rightRank < leftRank ? -1 : 1
  } else if (leftRank !== undefined) {
    return -1
  } else if (rightRank !== undefined) {
    return 1
  }

  if (isWindowsBackend(left.backend) && isWindowsBackend(right.backend)) {
    const leftVersion = parseBackendVersion(left.version)
    const rightVersion = parseBackendVersion(right.version)
    if (rightVersion !== leftVersion) return rightVersion < leftVersion ? -1 : 1
  }

  const leftOrder = left.order ?? 0
  const rightOrder = right.order ?? 0
  if (rightOrder !== leftOrder) return rightOrder < leftOrder ? -1 : 1

  const versionCmp = compareStrings(right.version, left.version)
  if (versionCmp !== 0) return versionCmp

  return compareStrings(left.backend, right.backend)
}

/**
 * True for a resolved `<tag>/<backend>` value: non-empty, not `none`, contains `/`, and not the
 * unresolved `latest/<backend>` dropdown sentinel (ATO-124).
 */
export function isConcreteVersionBackend(vb: string | undefined | null): boolean {
  const v = stripBom(vb ?? '')
  if (!v || v === 'none') return false
  if (!v.includes('/')) return false
  if (v.startsWith('latest/')) return false
  return true
}

/** Split `<version>/<backend>` into its trimmed halves; `INVALID_ARGUMENT` for any other shape. */
export function validateBackendString(backendString: string): [string, string] {
  const parts = backendString.split('/')
  if (parts.length !== 2) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid backend format: ${backendString}`)
  }
  const version = (parts[0] ?? '').trim()
  const backend = (parts[1] ?? '').trim()
  if (!version || !backend) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid backend format: ${backendString}`)
  }
  return [version, backend]
}
