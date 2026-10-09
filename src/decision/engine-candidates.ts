/**
 * Which installed packs may run the decision model, in the order they are tried. Pure.
 *
 * Every pack of the model's engine is a candidate, whether or not that provider is the one the user
 * picked for chat: the decision model is a separate process, so the chat provider's flag says
 * nothing about it.
 *
 * The fork's packs (`<data>/llamacpp/backends/`, `orderEngineCandidates`):
 *  1. packs whose tag is at or above 1.7.0, then tags without a semver, then older tags (a dev build
 *     can serve `--decision` under an old number, so older tags are still probed, last);
 *  2. newer upstream builds first;
 *  3. inside one version, the pack that runs on the CPU with the fewest extra libraries first: the
 *     decision model is started with `--device none`, and a CUDA or ROCm pack may not even start
 *     without its runtime libraries.
 *
 * Upstream packs (`<data>/llamacpp-upstream/backends/`, `orderUpstreamCandidates`): only tags at or
 * above the model's floor. The build the user runs `llamacpp-upstream` chat on goes first when it is
 * one of them: it is the one known to work on this machine, and a GPU kind the user did not pick (a
 * ROCm pack beside the recommended Vulkan one) may not run on this card at all. Then newest first,
 * the picked build's backend first inside a release, then GPU packs before CPU ones: upstream
 * decision models run up to 27B parameters and are started on the GPU when the pack has one.
 */

import { meetsForkVersion, parseForkSemver, formatSemver } from './engine-version.js'
import { meetsUpstreamBuild, upstreamBuildOf } from './upstream-version.js'
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
    dialect: 'turboquant',
    provider: 'llamacpp',
  }
}

/**
 * Lower is tried first: the GPU packs, then the CPU ones. Upstream names its plain builds without a
 * `cpu` marker (`ubuntu-x64`, `win-cpu-x64`), so anything without a GPU marker counts as CPU.
 */
export function upstreamBackendPreference(backend: string): number {
  const id = backend.toLowerCase()
  if (id.startsWith('macos')) return 0
  if (id.includes('cuda')) return 1
  if (id.includes('rocm') || id.includes('hip')) return 2
  if (id.includes('vulkan')) return 3
  if (id.includes('sycl') || id.includes('openvino') || id.includes('opencl')) return 4
  return 5
}

export interface UpstreamCandidates {
  /** Packs new enough for the model, in the order to try them. */
  eligible: EngineCandidate[]
  /** Installed packs older than the floor (or with a tag that is not a build number). */
  tooOld: InstalledEnginePack[]
}

/**
 * `preferred` is the `llamacpp-upstream` build the user picked (`version_backend`, `b11463/win-vulkan-x64`);
 * empty or not installed, the order is the release's and the GPU kind's alone.
 */
export function orderUpstreamCandidates(
  packs: readonly InstalledEnginePack[],
  minBuild: number,
  preferred = ''
): UpstreamCandidates {
  const eligible: EngineCandidate[] = []
  const tooOld: InstalledEnginePack[] = []
  for (const pack of packs) {
    if (meetsUpstreamBuild(pack.version, minBuild) !== true) {
      tooOld.push(pack)
      continue
    }
    eligible.push({
      ...pack,
      info: {
        path: pack.path,
        version_backend: `${pack.version}/${pack.backend}`,
        fork_version: null,
        version_gate: true,
        dialect: 'upstream',
        provider: 'llamacpp-upstream',
      },
    })
  }
  const picked = preferred.trim()
  const pickedBackend = picked.slice(picked.indexOf('/') + 1)
  const rank = (pack: EngineCandidate, key: (pack: EngineCandidate) => boolean) => (key(pack) ? 0 : 1)
  eligible.sort((a, b) => {
    const exact = (pack: EngineCandidate) => picked !== '' && pack.info.version_backend === picked
    const first = rank(a, exact) - rank(b, exact)
    if (first !== 0) return first
    const build = (upstreamBuildOf(b.version) ?? 0) - (upstreamBuildOf(a.version) ?? 0)
    if (build !== 0) return build
    const sameKind = (pack: EngineCandidate) => picked.includes('/') && pack.backend === pickedBackend
    const kind = rank(a, sameKind) - rank(b, sameKind)
    if (kind !== 0) return kind
    const backend = upstreamBackendPreference(a.backend) - upstreamBackendPreference(b.backend)
    return backend !== 0 ? backend : a.backend.localeCompare(b.backend)
  })
  return { eligible, tooOld }
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
