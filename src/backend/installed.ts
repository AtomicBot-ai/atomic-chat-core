/**
 * Installed backend packs on disk — the pure half. Port of `getBackendDir`, `getBackendExePath`,
 * `isBackendInstalled`, `listInstalledBackendPacks`, `deleteBackendPack` (validation only),
 * `backendTypeEquivalents`, `findCompatibleInstalledBackend` and `mergeBackendOptions` from
 * `extensions/llamacpp-upstream-extension/src/backend.ts`, plus the `order` semantics of
 * `get_local_installed_backends` and the library-name half of `is_cuda_installed` from `backend.rs`.
 *
 * Layout (PLAN.md §8.1): `<data>/<provider>/backends/<version>/<backend>/build/bin/llama-server`,
 * legacy flat `<backend>/llama-server`. Directory scanning, `rm` and `stat` are phase 1
 * (`store.ts`); this file only turns scan results into decisions and joins paths.
 */

import { join } from 'node:path'
import { llamaServerExeName } from '../config/index.js'
import type { ProviderPaths } from '../config/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import type { BackendOption, BackendVersion, InstalledBackendPack } from './types.js'
import { parseRustU32, stripBom } from './version.js'

/** One `<version>/<backend>` directory as a scanner reports it. */
export interface InstalledBackendEntry {
  version: string
  backend: string
  /** `build/bin/<exe>` or flat `<exe>` exists. */
  hasExe: boolean
  /** Directory mtime, seconds since the epoch. */
  mtimeSeconds?: number
}

/**
 * Rust `get_local_installed_backends` on scan results: only directories carrying the executable,
 * names BOM-stripped and trimmed, `order` = mtime seconds as u32 (0 when unknown).
 */
export function installedBackendsFromEntries(entries: readonly InstalledBackendEntry[]): BackendVersion[] {
  const out: BackendVersion[] = []
  for (const entry of entries) {
    if (!entry.hasExe) continue
    const mtime = entry.mtimeSeconds
    const order = mtime !== undefined && mtime > 0 ? (parseRustU32(String(Math.floor(mtime))) ?? 0) : 0
    out.push({ version: stripBom(entry.version), backend: stripBom(entry.backend), order })
  }
  return out
}

/** `<backendsDir>/<version>/<backend>`, both ids BOM-stripped. */
export function getBackendDir(paths: ProviderPaths, backend: string, version: string): string {
  return join(paths.backendsDir, stripBom(version), stripBom(backend))
}

/** `[build/bin/<exe>, <exe>]` under the pack directory, per platform. */
export function backendExePathCandidates(
  paths: ProviderPaths,
  backend: string,
  version: string,
  platform: NodeJS.Platform
): [string, string] {
  const dir = getBackendDir(paths, backend, version)
  const exe = llamaServerExeName(platform)
  return [join(dir, 'build', 'bin', exe), join(dir, exe)]
}

/**
 * The executable path the app would launch: `build/bin/<exe>` when the pack has a `build/` directory,
 * else the legacy flat `<exe>`. (The app checks for the directory, not the file.)
 */
export async function getBackendExePath(
  paths: ProviderPaths,
  backend: string,
  version: string,
  platform: NodeJS.Platform,
  exists: (path: string) => Promise<boolean>
): Promise<string> {
  const [buildExe, flatExe] = backendExePathCandidates(paths, backend, version, platform)
  return (await exists(join(getBackendDir(paths, backend, version), 'build'))) ? buildExe : flatExe
}

/** Rust `is_backend_installed`: either candidate executable exists. */
export async function isBackendInstalled(
  paths: ProviderPaths,
  backend: string,
  version: string,
  platform: NodeJS.Platform,
  exists: (path: string) => Promise<boolean>
): Promise<boolean> {
  for (const candidate of backendExePathCandidates(paths, backend, version, platform)) {
    if (await exists(candidate)) return true
  }
  return false
}

/**
 * Every installed build with its absolute path (for "reveal in file manager") and whether it is the
 * selected one (which must not be deletable).
 */
export function listInstalledBackendPacks(
  paths: ProviderPaths,
  installed: readonly BackendVersion[],
  currentVersionBackend: string
): InstalledBackendPack[] {
  const current = stripBom(currentVersionBackend)
  return installed.map((entry) => {
    const version = stripBom(entry.version)
    const backend = stripBom(entry.backend)
    return {
      version,
      backend,
      path: join(paths.backendsDir, version, backend),
      active: `${version}/${backend}` === current,
    }
  })
}

/**
 * Validate a pack for deletion: both ids non-empty and free of path separators (no `../` escape),
 * and not the selected build — deleting that would leave `version_backend` pointing at nothing and
 * the next load would fail with `BINARY_NOT_FOUND` instead of anything actionable.
 */
export function deletableBackendPack(
  currentVersionBackend: string,
  version: string,
  backend: string
): { version: string; backend: string } {
  const cleanVersion = stripBom(version)
  const cleanBackend = stripBom(backend)
  if (!cleanVersion || !cleanBackend || /[/\\]/.test(cleanVersion) || /[/\\]/.test(cleanBackend)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid backend pack: '${version}/${backend}'`)
  }
  if (`${cleanVersion}/${cleanBackend}` === stripBom(currentVersionBackend)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'Cannot remove the backend that is currently selected')
  }
  return { version: cleanVersion, backend: cleanBackend }
}

/**
 * Ids treated as the same backend type (ATO-233): a tarball installed by its upstream file name sits
 * on disk as `ubuntu-vulkan-x64` while the app stores `linux-vulkan-x64`.
 */
export function backendTypeEquivalents(backendType: string): Set<string> {
  const bt = stripBom(backendType)
  const ids = new Set<string>([bt])
  const pairs: Array<[string, string]> = [
    ['linux-vulkan-x64', 'ubuntu-vulkan-x64'],
    ['linux-vulkan-arm64', 'ubuntu-vulkan-arm64'],
    ['linux-cpu-x64', 'ubuntu-x64'],
    ['linux-cpu-arm64', 'ubuntu-arm64'],
  ]
  for (const [linux, ubuntu] of pairs) {
    if (bt === linux) ids.add(ubuntu)
    if (bt === ubuntu) ids.add(linux)
  }
  return ids
}

/**
 * Newest installed build of exactly this type (any release tag), by install `order`, or `null`.
 * Never crosses types (cuda → cpu is a user choice). Fallback for a pinned tag that cannot be
 * downloaded (ATO-179).
 */
export function findCompatibleInstalledBackend(
  backendType: string,
  installed: readonly BackendVersion[]
): BackendVersion | null {
  const equivalents = backendTypeEquivalents(backendType)
  const sameType = installed.filter((b) => equivalents.has(stripBom(b.backend)))
  if (sameType.length === 0) return null
  return sameType.sort((a, b) => (b.order ?? 0) - (a.order ?? 0))[0] ?? null
}

/**
 * Flatten the dropdown tiers (most-preferred first) into one list: first spelling of a value wins
 * (keeps the richest label), blanks and BOM-only values drop, and `recommended` is forced to the
 * front when absent — a recommendation the dropdown cannot offer is a dead end.
 */
export function mergeBackendOptions(
  tiers: readonly (readonly BackendOption[])[],
  recommended?: BackendOption
): BackendOption[] {
  const merged: BackendOption[] = []
  const seen = new Set<string>()
  for (const tier of tiers) {
    for (const option of tier) {
      const value = stripBom(option.value)
      if (!value || seen.has(value)) continue
      seen.add(value)
      merged.push({ value, name: option.name })
    }
  }
  const recommendedValue = recommended ? stripBom(recommended.value) : ''
  if (recommended && recommendedValue && !seen.has(recommendedValue)) {
    merged.unshift({ value: recommendedValue, name: recommended.name })
  }
  return merged
}

/**
 * CUDA runtime library a backend needs, by CUDA *major* (so a 13.x minor bump does not break the
 * probe): `cudart64_{110,12,13}.dll` on Windows, `libcudart.so.{11.0,12,13}` on Linux; `null` for
 * any other OS or major.
 */
export function cudaRuntimeLibName(osType: string, version: string): string | null {
  const major = parseRustU32(version.split('.')[0] ?? '') ?? 0
  const key = `${osType}:${major}`
  switch (key) {
    case 'windows:11':
      return 'cudart64_110.dll'
    case 'windows:12':
      return 'cudart64_12.dll'
    case 'windows:13':
      return 'cudart64_13.dll'
    case 'linux:11':
      return 'libcudart.so.11.0'
    case 'linux:12':
      return 'libcudart.so.12'
    case 'linux:13':
      return 'libcudart.so.13'
    default:
      return null
  }
}

export interface CudaLibFs {
  exists: (path: string) => Promise<boolean>
  mkdir: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
}

/**
 * Rust `is_cuda_installed`: the runtime library is present at `<backendDir>/build/bin/<lib>`, or it
 * sits at the legacy `<data>/llamacpp/lib/<lib>` and is moved into place (creating `build/bin`;
 * a failed `mkdir` is `IO_ERROR`, a failed `rename` is `false`). `false` for an unknown OS/major.
 */
export async function isCudaInstalled(input: {
  backendDir: string
  version: string
  osType: string
  legacyLibDir: string
  fs: CudaLibFs
}): Promise<boolean> {
  const libName = cudaRuntimeLibName(input.osType, input.version)
  if (!libName) return false
  const targetDir = join(input.backendDir, 'build', 'bin')
  const newPath = join(targetDir, libName)
  if (await input.fs.exists(newPath)) return true
  const oldPath = join(input.legacyLibDir, libName)
  if (!(await input.fs.exists(oldPath))) return false
  if (!(await input.fs.exists(targetDir))) {
    try {
      await input.fs.mkdir(targetDir)
    } catch (err) {
      throw new AtomicCoreError(
        'IO_ERROR',
        `Failed to create target directory: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }
  try {
    await input.fs.rename(oldPath, newPath)
    return true
  } catch {
    return false
  }
}
