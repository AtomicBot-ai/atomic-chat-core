/**
 * llama.cpp packs that could not run on this machine, and the one-shot fallback order a failed load
 * walks (CUDA 13 → CUDA 12 / ROCm → Vulkan / OpenCL → CPU). Pure: the record list, the GPU facts and
 * the installed packs are parameters; `install/runtime-backend.ts` reads and writes the file.
 *
 * A record is keyed by provider, backend directory name and the machine's GPU driver: a driver update
 * is what usually fixes a build the card refused (CUDA 13.x on Turing before R616), so a new driver
 * forgets the record without anyone clearing it.
 */

import type { BackendVersion, GpuProbeInfo } from '../types.js'
import { stripBom } from '../version.js'

/** `<data>/atomic-core/bad-backends.json`. */
export const BAD_BACKENDS_FILE = 'bad-backends.json'
export const BAD_BACKENDS_SCHEMA_VERSION = 1

export interface BadBackendEntry {
  provider: string
  /** The backend directory name, e.g. `win-cuda-13.3-x64`. */
  backend: string
  /** `gpuDriverKey` of the machine when the pack failed. */
  driver: string
  /** The error code that marked it (`GPU_BACKEND_INCOMPATIBLE`, …). */
  reason: string
  /** The release tag that failed; informational, the key ignores it. */
  version: string
  /** ISO time it was marked. */
  at: string
}

/**
 * The driver a record is keyed by: the NVIDIA driver when there is an NVIDIA GPU (CUDA builds are
 * what fail), otherwise every GPU's driver, so an AMD or Intel update clears a Vulkan record too.
 * `''` on a machine without a GPU.
 */
export function gpuDriverKey(gpus: readonly GpuProbeInfo[]): string {
  const driverOf = (gpu: GpuProbeInfo) => (gpu.driver_version ?? '').trim()
  const nvidia = gpus.filter((gpu) => gpu.nvidia_info || gpu.vendor === 'NVIDIA').map(driverOf)
  const drivers = (nvidia.length > 0 ? nvidia : gpus.map(driverOf)).filter((d) => d !== '')
  return [...new Set(drivers)].join(',')
}

/** The records of a `bad-backends.json` document; anything malformed is dropped, never thrown. */
export function parseBadBackends(raw: unknown): BadBackendEntry[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const entries = (raw as Record<string, unknown>)['entries']
  if (!Array.isArray(entries)) return []
  const out: BadBackendEntry[] = []
  for (const value of entries) {
    if (!value || typeof value !== 'object') continue
    const e = value as Record<string, unknown>
    const text = (key: string) => (typeof e[key] === 'string' ? (e[key] as string) : undefined)
    const provider = text('provider')
    const backend = text('backend')
    const driver = text('driver')
    if (!provider || !backend || driver === undefined) continue
    out.push({
      provider,
      backend: stripBom(backend),
      driver,
      reason: text('reason') ?? '',
      version: text('version') ?? '',
      at: text('at') ?? '',
    })
  }
  return out
}

const sameKey = (e: BadBackendEntry, provider: string, backend: string, driver: string) =>
  e.provider === provider && e.backend === stripBom(backend) && e.driver === driver

/** Whether `backend` of `provider` failed on this machine with the driver it has now. */
export function isBackendMarkedBad(
  entries: readonly BadBackendEntry[],
  provider: string,
  backend: string,
  driver: string
): boolean {
  return entries.some((e) => sameKey(e, provider, backend, driver))
}

/** `entries` with `entry` in place of any record of the same key, and without records of an older driver for it. */
export function withBadBackend(
  entries: readonly BadBackendEntry[],
  entry: BadBackendEntry
): BadBackendEntry[] {
  const kept = entries.filter(
    (e) => !(e.provider === entry.provider && e.backend === stripBom(entry.backend))
  )
  return [...kept, { ...entry, backend: stripBom(entry.backend) }]
}

/** The document `bad-backends.json` holds. */
export function serializeBadBackends(entries: readonly BadBackendEntry[]): string {
  return `${JSON.stringify({ schema_version: BAD_BACKENDS_SCHEMA_VERSION, entries }, null, 2)}\n`
}

/**
 * Where a backend sits in the fallback order, lower is tried first: CUDA 13 (0), CUDA 12 / 11 and
 * ROCm / HIP (1), Vulkan / OpenCL / SYCL (2), a CPU build (3). `undefined` for an id that says neither
 * (Metal, a hand-named pack): it is never a fallback target and never falls back.
 */
export function backendFallbackRank(backend: string): number | undefined {
  const id = stripBom(backend).toLowerCase()
  if (/cuda-(cu)?13/.test(id)) return 0
  if (/cuda-(cu)?1[12]|rocm|(^|-)hip(-|$)/.test(id)) return 1
  if (/vulkan|opencl|sycl/.test(id)) return 2
  if (
    /(^|-)cpu(-|$)|(^|-)(no)?avx(2|512)?(-|$)|common_cpus|^(linux|win)-(x64|x86_64|arm64|aarch64)$/.test(id)
  )
    return 3
  return undefined
}

/**
 * The pack a load that failed on `failed` tries next: the first further down the fallback order,
 * the same release tag first, then in the order `candidates` came in (callers pass them newest
 * first). Never `failed` itself or a pack `skip` rules out; `undefined` when nothing is left.
 */
export function nextFallbackBackend(
  failed: { version: string; backend: string },
  candidates: readonly BackendVersion[],
  skip: (backend: string) => boolean = () => false
): BackendVersion | undefined {
  const from = backendFallbackRank(failed.backend)
  if (from === undefined) return undefined
  const failedBackend = stripBom(failed.backend)
  const ranked = candidates
    .map((candidate, index) => ({ candidate, index, rank: backendFallbackRank(candidate.backend) }))
    .filter(
      (c): c is { candidate: BackendVersion; index: number; rank: number } =>
        c.rank !== undefined &&
        c.rank > from &&
        stripBom(c.candidate.backend) !== failedBackend &&
        !skip(c.candidate.backend)
    )
  const sameTag = (c: BackendVersion) => (stripBom(c.version) === stripBom(failed.version) ? 0 : 1)
  ranked.sort((a, b) => a.rank - b.rank || sameTag(a.candidate) - sameTag(b.candidate) || a.index - b.index)
  return ranked[0]?.candidate
}
