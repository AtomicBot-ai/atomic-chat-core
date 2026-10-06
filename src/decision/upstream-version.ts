/**
 * The upstream llama.cpp builds that serve a decision model, by its `<arch>.decision.type`. Pure.
 *
 * Upstream has no flag to probe (`/v1/systemone` is always there, it answers 501 for a model that is
 * not a decision model), so the release tag is the gate: `b11436` → 11436, compared with the first
 * build that serves the type. The readiness check (`/v1/models` lists `decisions`) catches the rest.
 * The floors (ggml-org/llama.cpp, by the merge of each change):
 *  - b11370: `/v1/systemone` with laya, openjev, lev, kev (#29818) and nimble (#29844);
 *  - b11371: clef, text only (#29831);
 *  - b11418: clef with images (#29969).
 */

import { releaseTagRank } from '../backend/index.js'

/** The first upstream build with `/v1/systemone`. */
export const UPSTREAM_DECISION_MIN_BUILD = 11370
/** The first upstream build that serves clef. */
export const UPSTREAM_CLEF_MIN_BUILD = 11371
/** The first upstream build that gives clef images. */
export const UPSTREAM_CLEF_VISION_MIN_BUILD = 11418

/** The oldest build that serves `decisionType` (with a projector when `vision`). Unknown types: the first one. */
export function upstreamMinBuild(decisionType: string | undefined, vision: boolean): number {
  if (decisionType === 'clef') return vision ? UPSTREAM_CLEF_VISION_MIN_BUILD : UPSTREAM_CLEF_MIN_BUILD
  return UPSTREAM_DECISION_MIN_BUILD
}

/** `b11436` → 11436; a tag that is not a plain upstream release (`b10269-1.7.0`, `prism-…`) → `undefined`. */
export function upstreamBuildOf(version: string): number | undefined {
  return releaseTagRank(version.trim())
}

/** Whether an upstream tag is at or above `minBuild`; `undefined` when the tag carries no build number. */
export function meetsUpstreamBuild(version: string, minBuild: number): boolean | undefined {
  const build = upstreamBuildOf(version)
  return build === undefined ? undefined : build >= minBuild
}
