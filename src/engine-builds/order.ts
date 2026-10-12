/**
 * Which of two builds of one engine is newer (design D4). An "update" is only ever a strictly newer
 * build, so a conf manifest rolled back to an older tag is never offered and never installed over a
 * newer one.
 *
 *   - sd.cpp: the build number `<n>` of `master-<n>-<sha>[-a<sha>]` (what `buildOf` in
 *     `diffusion/compat.ts` reads); at an equal number the Atomic rebuild (`-a<sha>`) is newer. Two
 *     rebuilds of one tag are equal: their shas carry no order.
 *   - MLX: `published_at` of the GitHub release. The tags are commit hashes.
 *
 * A build whose order cannot be read (a dev stub, an installer without `mlx-server.json`) is older
 * than every build whose order can, so any verified build replaces it.
 */

import type { EngineBuildId } from '../contracts/index.js'
import { isDateTime } from './manifest.js'

export interface OrderedBuild {
  tag: string
  /** MLX only. */
  published_at?: string | null
}

/** `[build number, 1 for an Atomic rebuild]`, or `null` for a tag without a build number. */
export function sdcppBuildKey(tag: string): [number, number] | null {
  const match = /^master-(\d+)-[0-9a-z]+(-a[0-9a-f]+)?$/.exec(tag)
  if (!match) return null
  return [Number(match[1]), match[2] ? 1 : 0]
}

function mlxKey(build: OrderedBuild): [number] | null {
  return isDateTime(build.published_at) ? [Date.parse(build.published_at)] : null
}

function compareKeys(a: readonly number[] | null, b: readonly number[] | null): number {
  if (a === null || b === null) return (a === null ? 0 : 1) - (b === null ? 0 : 1)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Negative when `a` is older, positive when newer, zero when neither is. */
export function compareBuilds(engine: EngineBuildId, a: OrderedBuild, b: OrderedBuild): number {
  return engine === 'sd-cpp'
    ? compareKeys(sdcppBuildKey(a.tag), sdcppBuildKey(b.tag))
    : compareKeys(mlxKey(a), mlxKey(b))
}

export function isNewerBuild(engine: EngineBuildId, candidate: OrderedBuild, than: OrderedBuild): boolean {
  return compareBuilds(engine, candidate, than) > 0
}
