/**
 * Which installed TurboQuant packs may run the decision model, in the order they are probed. Pure.
 *
 * Every pack of the fork under `<data>/llamacpp/backends/` is a candidate, whether or not TurboQuant
 * is the provider the user picked for chat: the decision model is a separate process, so the chat
 * provider's flag says nothing about it. The order:
 *  1. packs whose tag is at or above 1.7.0, then tags without a semver, then older tags (a dev build
 *     can serve `--decision` under an old number, so older tags are still probed, last);
 *  2. newer upstream builds first;
 *  3. inside one version, the pack that runs on the CPU with the fewest extra libraries first: the
 *     decision model is started with `--device none`, and a CUDA or ROCm pack may not even start
 *     without its runtime libraries.
 */

import { meetsForkVersion, parseForkSemver, formatSemver } from './engine-version.js'
import type { DecisionEngineInfo } from '../contracts/index.js'

export interface InstalledEnginePack {
  version: string
  backend: string
  /** The pack's `llama-server`. */
  path: string
}

export interface EngineCandidate extends InstalledEnginePack {
  info: DecisionEngineInfo
}

/** `b10269-1.7.0` → 10269; anything else sorts as 0. */
function buildOf(version: string): number {
  const match = /^b(\d+)/.exec(version.trim())
  return match ? Number(match[1]) : 0
}

/** Lower is tried first. */
export function backendPreference(backend: string): number {
  const id = backend.toLowerCase()
  if (id.includes('cpu')) return 0
  if (id.startsWith('macos')) return 1
  if (id.includes('vulkan')) return 2
  return 3
}

function gateRank(gate: boolean | undefined): number {
  if (gate === true) return 0
  if (gate === undefined) return 1
  return 2
}

export function engineInfoOf(pack: InstalledEnginePack): DecisionEngineInfo {
  const semver = parseForkSemver(pack.version)
  const gate = meetsForkVersion(pack.version)
  return {
    path: pack.path,
    version_backend: `${pack.version}/${pack.backend}`,
    fork_version: semver ? formatSemver(semver) : null,
    version_gate: gate ?? null,
  }
}

export function orderEngineCandidates(packs: readonly InstalledEnginePack[]): EngineCandidate[] {
  return packs
    .map((pack) => ({ ...pack, info: engineInfoOf(pack) }))
    .sort((a, b) => {
      const gate = gateRank(a.info.version_gate ?? undefined) - gateRank(b.info.version_gate ?? undefined)
      if (gate !== 0) return gate
      const build = buildOf(b.version) - buildOf(a.version)
      if (build !== 0) return build
      const backend = backendPreference(a.backend) - backendPreference(b.backend)
      if (backend !== 0) return backend
      return a.version === b.version ? a.backend.localeCompare(b.backend) : b.version.localeCompare(a.version)
    })
}
