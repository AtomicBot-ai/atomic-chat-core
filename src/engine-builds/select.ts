/**
 * Which build of an engine this host should install. Openspec change `move-sdcpp-mlx-install-to-core`,
 * design D7.
 *
 * The sd.cpp ladder below, from `LINUX_VULKAN_MIN_VRAM_MIB` to `backendKindOf`, is
 * `web-app/src/services/diffusion/backendMatrix.ts` of the app's `change/add-vllm-runtime` branch,
 * verbatim but for one cast core's `noUncheckedIndexedAccess` needs (rulings/core.md 2.4: that branch, not app main, because it carries the arm64 builds and
 * the walk down the ladder). The app fed it the deprecated Rust `get_supported_features`; the core
 * feeds it `getSupportedFeatures`, which that function was ported from, through `sdcppHostOf`.
 *
 * What the app kept in `localStorage` — the `<tag>/<backend_id>` builds that unpacked but failed their
 * probe here — lives in `<data>/diffusion/failed-backends.json`, so the desktop and `atc` skip the
 * same ones.
 *
 * Original header:
 *
 * Which stable-diffusion.cpp prebuilt this host should run.
 *
 * Pure: the caller gathers the OS, arch, the feature probe from
 * `plugin:llamacpp-upstream|get_supported_features` and the GPU list, and
 * hands over the backend ids the manifest actually lists. The ladder mirrors
 * the llama.cpp providers' policy in AGENTS.md §3 — a backend is a property of
 * the pinned release, so an id the manifest does not carry is skipped rather
 * than guessed at.
 *
 * Linux x64 has no CUDA prebuilt from leejet (nor from ggml-org), so NVIDIA
 * hosts there run Vulkan until the diffusers sidecar (phase 1b) lands. Windows
 * ROCm is not in every tag; when absent the host falls through to Vulkan.
 *
 * arm64 Linux and Windows on Arm get no upstream archive at all; their CUDA 13
 * and CPU builds come from AtomicBot-ai/stable-diffusion.cpp, mirrored under
 * the same tag (ADR 2026-10-06). CUDA 13 is the only accelerated tier there:
 * those builds target sm_121 (GB10 / N1X) with a Hopper PTX floor.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { DiffusionBackend } from '../contracts/index.js'
import { getSupportedFeatures } from '../backend/index.js'
import type { HardwareFacts } from '../hardware/index.js'

/**
 * Smallest Vulkan device worth moving a Linux host off the CPU build for.
 * Mirrors `LINUX_VULKAN_MIN_VRAM_MIB` in
 * `extensions/llamacpp-upstream-extension/src/index.ts` (the web app cannot
 * import extension source); keep the two in step.
 */
export const LINUX_VULKAN_MIN_VRAM_MIB = 2 * 1024

export type DiffusionHostOs = 'macos' | 'windows' | 'linux'
export type DiffusionHostArch = 'arm64' | 'x64'

export type DiffusionBackendSelectionInput = {
  os: DiffusionHostOs
  arch: DiffusionHostArch
  features: {
    cuda12?: boolean
    cuda13?: boolean
    vulkan?: boolean
    rocm?: boolean
  }
  gpus: { vendor?: string; totalMemoryMib?: number }[]
  /** Backend ids the manifest lists (companions included or not; they never match). */
  available: string[]
}

/** Windows CUDA 12 build; a CUDA 13-only driver still runs it. */
const WIN_CUDA12 = 'win-cuda12-x64'
const WIN_ROCM_RE = /^win-rocm-(\d+(?:\.\d+)*)-x64$/
const WIN_VULKAN = 'win-vulkan-x64'
const WIN_CPU = 'win-cpu-x64'
const LINUX_VULKAN = 'linux-vulkan-x64'
const LINUX_CPU = 'linux-cpu-x64'
const MACOS_ARM64 = 'macos-arm64'
const WIN_CUDART_CU12 = 'win-cudart-cu12'
/** Atomic-built arm64 archives; they carry their CUDA runtime, so no companion. */
const WIN_CUDA13_ARM64 = 'win-cuda13-arm64'
const WIN_CPU_ARM64 = 'win-cpu-arm64'
const LINUX_CUDA13_ARM64 = 'linux-cuda13-arm64'
const LINUX_CPU_ARM64 = 'linux-cpu-arm64'

const versionKey = (version: string): number[] => version.split('.').map((part) => Number(part))

const compareVersions = (a: number[], b: number[]): number => {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** The highest-versioned id matching `pattern`, or null when the tag ships none. */
const pickVersioned = (available: string[], pattern: RegExp): string | null => {
  let best: { id: string; key: number[] } | null = null
  for (const id of available) {
    const match = pattern.exec(id)
    if (!match) continue
    const key = versionKey(match[1] as string)
    if (!best || compareVersions(key, best.key) > 0) best = { id, key }
  }
  return best?.id ?? null
}

const allAvailable = (available: string[], candidates: (string | null)[]): string[] =>
  candidates.filter(
    (id, index): id is string => id !== null && available.includes(id) && candidates.indexOf(id) === index
  )

/**
 * Every build this host can run that the manifest ships, best first; empty
 * when there is none (Intel Macs, an arm64 host on a manifest without arm64
 * builds, an empty manifest). The installer walks down it when a build
 * unpacks but fails the core's probe — upstream's Windows ROCm archive on a
 * host without the HIP SDK it links against — instead of stopping there.
 */
export function diffusionBackendLadder(input: DiffusionBackendSelectionInput): string[] {
  const { os, arch, features, gpus, available } = input

  if (os === 'macos') {
    return arch === 'arm64' ? allAvailable(available, [MACOS_ARM64]) : []
  }
  if (arch === 'arm64') {
    // The CUDA 13 runtime inside these archives needs the r580+ driver the
    // cuda13 probe checks for; anything less runs the CPU build.
    const cuda = features.cuda13 ? (os === 'windows' ? WIN_CUDA13_ARM64 : LINUX_CUDA13_ARM64) : null
    return allAvailable(available, [cuda, os === 'windows' ? WIN_CPU_ARM64 : LINUX_CPU_ARM64])
  }

  if (os === 'windows') {
    const cuda = features.cuda12 || features.cuda13 ? WIN_CUDA12 : null
    const rocm = features.rocm ? pickVersioned(available, WIN_ROCM_RE) : null
    const vulkan = features.vulkan ? WIN_VULKAN : null
    return allAvailable(available, [cuda, rocm, vulkan, WIN_CPU])
  }

  // Linux: Vulkan is the only accelerated prebuilt, and only when the loader
  // enumerated a device big enough to hold a checkpoint beside its activations.
  const anyVulkanDevice = gpus.some((gpu) => (gpu.totalMemoryMib ?? 0) >= LINUX_VULKAN_MIN_VRAM_MIB)
  const vulkan = features.vulkan && anyVulkanDevice ? LINUX_VULKAN : null
  return allAvailable(available, [vulkan, LINUX_CPU])
}

/**
 * The backend id to install, or `null` when this host cannot run any build
 * the manifest ships: the top of `diffusionBackendLadder`.
 */
export function selectDiffusionBackend(input: DiffusionBackendSelectionInput): string | null {
  return diffusionBackendLadder(input)[0] ?? null
}

/** The companion archive a backend needs unpacked beside it, if any. */
export function companionFor(backendId: string): 'win-cudart-cu12' | null {
  return backendId === WIN_CUDA12 ? WIN_CUDART_CU12 : null
}

/** The compute backend a manifest id was built for, for the install record. */
export function backendKindOf(backendId: string): DiffusionBackend {
  if (backendId.startsWith('macos-')) return 'metal'
  if (backendId.includes('-cuda')) return 'cuda'
  if (backendId.includes('-rocm')) return 'rocm'
  if (backendId.includes('-vulkan')) return 'vulkan'
  return 'cpu'
}

// --- core: the host from the core's hardware facts, failed rungs, MLX ------------------------------

/** What the ladder reads, from the core's own facts (the override applied). */
export function sdcppHostOf(
  facts: Pick<HardwareFacts, 'osType' | 'arch' | 'cpuExtensions' | 'gpus'>
): Omit<DiffusionBackendSelectionInput, 'available' | 'os'> & { os: string } {
  const arch: DiffusionHostArch = /arm64|aarch64/.test(facts.arch) ? 'arm64' : 'x64'
  const os = facts.osType
  const gpus = facts.gpus.map((gpu) => ({
    ...(typeof gpu.vendor === 'string' ? { vendor: gpu.vendor } : {}),
    ...(typeof gpu.total_memory === 'number' ? { totalMemoryMib: gpu.total_memory } : {}),
  }))
  // macOS has Metal and nothing for the feature probe to find, as the app had it.
  if (os === 'macos') return { os, arch, features: {}, gpus }
  const probed = getSupportedFeatures(os, facts.cpuExtensions ?? [], facts.gpus)
  return {
    os,
    arch,
    features: { cuda12: probed.cuda12, cuda13: probed.cuda13, vulkan: probed.vulkan, rocm: probed.rocm },
    gpus,
  }
}

/** The key a failed probe is remembered under: a new tag gets a fresh try. */
export const failedBackendKey = (tag: string, backendId: string): string => `${tag}/${backendId}`

export interface SdcppHostChoice {
  /** What this host would install, best first, without the builds that already failed on this tag. */
  ladder: string[]
  backend_id: string | null
  /** Why `backend_id` is `null`. */
  reason: string | null
}

/** Why no build applies, in words a settings card can show (the app's `unsupportedReason`). */
function unsupportedReason(host: { os: string; arch: string }): string {
  if (host.os === 'macos') return 'Image generation needs an Apple Silicon Mac; Intel Macs are not supported.'
  if (host.os !== 'windows' && host.os !== 'linux') return `Image generation is not supported on ${host.os}.`
  if (host.arch !== 'x64')
    return `The release manifest lists no stable-diffusion.cpp build for ${host.arch} ${host.os} yet.`
  return 'The release manifest lists no build for this computer.'
}

/**
 * The ladder for `manifest`, leaving out the builds that failed here on this tag; when that leaves
 * nothing, the last build is offered again, so a retry ends on its own error rather than on "no build
 * for this computer" (the app's `backendLadderForHost`).
 */
export function sdcppHostChoice(
  host: Omit<DiffusionBackendSelectionInput, 'available' | 'os'> & { os: string },
  manifest: { tag_name: string; assets: readonly { backend: string; companion?: boolean }[] },
  failed: ReadonlySet<string>
): SdcppHostChoice {
  const supported = host.os === 'macos' || host.os === 'windows' || host.os === 'linux'
  const ladder = supported
    ? diffusionBackendLadder({
        ...host,
        os: host.os as DiffusionHostOs,
        available: manifest.assets.filter((asset) => !asset.companion).map((asset) => asset.backend),
      })
    : []
  if (ladder.length === 0) return { ladder: [], backend_id: null, reason: unsupportedReason(host) }
  const usable = ladder.filter((id) => !failed.has(failedBackendKey(manifest.tag_name, id)))
  const offered = usable.length > 0 ? usable : ladder.slice(-1)
  return { ladder: offered, backend_id: offered[0] ?? null, reason: null }
}

/** The app kept "a few tags' worth of rungs"; older entries name tags no manifest serves. */
export const FAILED_BACKENDS_LIMIT = 16

/** `<tag>/<backend_id>` pairs that failed their probe on this machine; empty when unreadable. */
export async function readFailedBackends(file: string): Promise<Set<string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    return new Set(Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Remember one more failed pair, newest last; a failed write only costs a repeated download. */
export async function rememberFailedBackend(file: string, tag: string, backendId: string): Promise<void> {
  const key = failedBackendKey(tag, backendId)
  const entries = [...(await readFailedBackends(file))].filter((entry) => entry !== key)
  entries.push(key)
  const temporary = `${file}.tmp-${process.pid}`
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temporary, JSON.stringify(entries.slice(-FAILED_BACKENDS_LIMIT)), 'utf8')
    await rename(temporary, file)
  } catch {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

/** MLX ships one build, for Apple Silicon; the manifest only has to list it. */
export function mlxHostChoice(
  host: { os: string; arch: string },
  manifest: { assets: readonly { backend: string }[] } | null
): { backend_id: string | null; reason: string | null } {
  if (host.os !== 'macos' || host.arch !== 'arm64')
    return { backend_id: null, reason: 'MLX runs on Apple Silicon Macs only.' }
  if (manifest && !manifest.assets.some((asset) => asset.backend === MACOS_ARM64))
    return { backend_id: null, reason: 'The MLX manifest lists no build for Apple Silicon.' }
  return { backend_id: MACOS_ARM64, reason: null }
}
