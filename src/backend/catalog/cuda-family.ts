/**
 * Version-less GPU family ids and their concrete assets. Port of the family helpers in
 * `extensions/llamacpp-upstream-extension/src/backend.ts` (`cudaFamilyMajor`,
 * `isConcreteOfGpuFamily`, `resolveGpuFamilyConcrete`) and of `resolveLatestBackendString` in
 * `index.ts`.
 *
 * The Rust matrix (`determine_supported_backends`) and the "Latest <variant>" dropdown emit
 * *minor-less* ids — `win-cuda-13-x64`, `win-cuda-12-x64`, `win-rocm-x64` — because ggml-org bumps
 * the CUDA toolkit minor (13.1 → 13.3 → 13.x) and the HIP version (7.14 → 10.0) between releases.
 * The concrete asset (`win-cuda-13.3-x64`, `win-rocm-10.0-x64`) is only known once the manifest is
 * read, and is resolved here (ATO-105 / ATO-174).
 */

import type { BackendVersion } from '../types.js'
import { stripBom } from '../version.js'

/** Minor-less Windows CUDA family id: `win-cuda-13-x64`, `win-cuda-12-x64`. */
export const WIN_CUDA_FAMILY_RE = /^win-cuda-(\d+)-x64$/
/** Concrete Windows CUDA asset id: `win-cuda-12.4-x64`, `win-cuda-13.3-x64`. */
export const WINDOWS_CUDA_BACKEND_RE = /^win-cuda-(12\.\d+|13\.\d+)-x64$/
/** HIP has no major to pin: one `win-rocm-<major>.<minor>-x64` asset per release, moved wholesale. */
export const WIN_ROCM_FAMILY_ID = 'win-rocm-x64'
export const WIN_ROCM_CONCRETE_RE = /^win-rocm-(\d+)\.(\d+)-x64$/

/**
 * The CUDA major (`"13"`, `"12"`) of a minor-less family id, or `null` when `backend` is not one.
 * Concrete ids (`win-cuda-13.3-x64`) deliberately return `null` — they need no family resolution.
 */
export function cudaFamilyMajor(backend: string): string | null {
  const m = WIN_CUDA_FAMILY_RE.exec(stripBom(backend))
  return m ? (m[1] ?? null) : null
}

/**
 * Regex matching every concrete asset id of a family id, with the version components captured so
 * the newest can be picked. `null` when `familyBackend` is not a family id.
 */
export function gpuFamilyConcreteRe(familyBackend: string): RegExp | null {
  const id = stripBom(familyBackend)
  if (id === WIN_ROCM_FAMILY_ID) return WIN_ROCM_CONCRETE_RE
  const major = cudaFamilyMajor(id)
  return major ? new RegExp(`^win-cuda-(${major})\\.(\\d+)-x64$`) : null
}

/** True when `familyBackend` is one of the version-less family ids. */
export function isGpuFamilyId(backend: string): boolean {
  return gpuFamilyConcreteRe(backend) !== null
}

/**
 * True when `concrete` (`win-cuda-13.3-x64`, `win-rocm-7.14-x64`) belongs to the family
 * `familyBackend` (`win-cuda-13-x64`, `win-rocm-x64`). False for a non-family `familyBackend`.
 */
export function isConcreteOfGpuFamily(familyBackend: string, concrete: string): boolean {
  const re = gpuFamilyConcreteRe(familyBackend)
  return re ? re.test(stripBom(concrete)) : false
}

/**
 * Newest concrete `<tag>/<backend>` of a family present in `remote` (`b10405/win-rocm-7.14-x64`),
 * comparing the captured version numerically (`10.0` beats `7.14`). `null` when `familyBackend` is
 * not a family id or no concrete asset is listed.
 */
export function resolveGpuFamilyConcrete(familyBackend: string, remote: BackendVersion[]): string | null {
  const re = gpuFamilyConcreteRe(familyBackend)
  if (!re) return null
  let best: { version: string; backend: string; rank: [number, number] } | null = null
  for (const b of remote) {
    const backendName = stripBom(b.backend)
    const m = re.exec(backendName)
    if (!m) continue
    const rank: [number, number] = [parseInt(m[1] ?? '', 10), parseInt(m[2] ?? '', 10)]
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) {
      best = { version: b.version, backend: backendName, rank }
    }
  }
  return best ? `${best.version}/${best.backend}` : null
}

/**
 * CUDA toolkit version (`"13.3"`) of a concrete Windows CUDA backend id, or `null` for anything
 * else (family ids included). The cudart companion archive and `is_cuda_installed` key off it.
 */
export function matchWindowsCudaBackend(backend: string): string | null {
  const m = WINDOWS_CUDA_BACKEND_RE.exec(stripBom(backend))
  return m ? (m[1] ?? null) : null
}

/**
 * Resolve a "Latest <variant>" sentinel's backend id to a concrete `<tag>/<backend>` from the
 * remote catalog: an exact id match first, then the newest asset of its family. `null` when the
 * catalog has nothing for it (app `resolveLatestBackendString`, minus the fetch and the logging).
 */
export function resolveLatestVersionBackend(backend: string, remote: BackendVersion[]): string | null {
  const match = remote.find((b) => b.backend === backend)
  if (match?.version) return `${match.version}/${backend}`
  return resolveGpuFamilyConcrete(backend, remote)
}
