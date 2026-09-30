/**
 * The fork's release semver, read from a pack's version tag, and the floor for `--decision`.
 *
 * TurboQuant releases are tagged `b<upstream build>-<fork semver>` (`b10269-1.7.0`). The decision role
 * shipped in 1.7.0, so a tag at or above it is a strong hint. It is only a hint: a `dev` build carries
 * whatever `TURBOQUANT_VERSION` the branch had (1.5.1 while 1.7.0 was being built) and a legacy
 * `turboquant-<id>-<sha>` tag has no semver at all. The `-h` probe is the real gate; this ordering
 * only decides which pack is probed first. A unified tag is read by the backend module's
 * `unifiedReleaseRank`, the parser the release index and the install sort use, so the two never
 * disagree about what a tag says; only the bare `1.7.0` / `v1.7.0` form is read here.
 */

import { unifiedReleaseRank } from '../backend/index.js'

/** The first fork release with `llama-server --decision` (API version 1). */
export const DECISION_MIN_FORK_VERSION = '1.7.0'

export type Semver = readonly [number, number, number]

const PLAIN_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/

/**
 * `b10269-1.7.0` → `[1, 7, 0]`; a bare `1.7.0` / `v1.7.0` too (the floor, a user-typed version).
 * Anything else (`b6325`, `turboquant-…`, `1.7`) has no semver: `undefined`.
 */
export function parseForkSemver(version: string): Semver | undefined {
  const trimmed = version.trim()
  const rank = unifiedReleaseRank(trimmed)
  if (rank) return [rank[1], rank[2], rank[3]]
  const match = PLAIN_SEMVER.exec(trimmed)
  if (!match) return undefined
  const parts = [Number(match[1]), Number(match[2]), Number(match[3])] as const
  return parts.every((n) => Number.isSafeInteger(n)) ? parts : undefined
}

/** Numeric, part by part: `1.10.0` > `1.9.9`. */
export function compareSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

export function formatSemver(v: Semver): string {
  return `${v[0]}.${v[1]}.${v[2]}`
}

/**
 * Whether the tag says the build is new enough: `true` / `false` when it has a semver, `undefined`
 * when it does not (then only the probe can tell).
 */
export function meetsForkVersion(
  version: string,
  floor: string = DECISION_MIN_FORK_VERSION
): boolean | undefined {
  const have = parseForkSemver(version)
  const need = parseForkSemver(floor)
  if (!have || !need) return undefined
  return compareSemver(have, need) >= 0
}
