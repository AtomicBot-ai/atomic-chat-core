/**
 * Backend-id migration and the `version_backend` setting update. Port of `map_old_backend_to_new`,
 * `should_migrate_backend` and `handle_setting_update` in
 * `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`.
 *
 * Two naming generations exist in persisted settings: legacy janhq-mirror ids
 * (`win-cuda-12-common_cpus-x64`, `win-noavx-cuda-cu11.7-x64`, `linux-avx2-x64`, …) and the
 * ggml-org native ids the upstream provider uses now (`win-cuda-12.4-x64`, `linux-vulkan-x64`,
 * `macos-arm64`). `mapOldBackendToNew` folds the former onto the closest of the latter so an old
 * setting still resolves to something downloadable.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type { BackendVersion, SettingUpdateResult } from './types.js'

/**
 * Closest current id for a legacy backend id; current ids round-trip unchanged.
 *
 *   - `ubuntu-*` (a tarball installed by file name, ATO-233) → `linux-{cpu,vulkan}-<arch>`.
 *   - Windows: `win-cpu-x64`, the family ids `win-cuda-13-x64` / `win-rocm-*`, concrete
 *     `cuda-12.4` / `cuda-13.3` and `win-vulkan-x64` pass through; legacy CUDA 13 / `cu13` →
 *     `win-cuda-13.3`, CUDA 12 / `cu12` → `win-cuda-12.4`, CUDA 11 / `cu11` → `win-cuda-12.4`
 *     (ggml-org dropped CUDA 11; the driver gate refuses it on too-old hosts), vulkan →
 *     `win-vulkan`, AVX tiers / `common_cpus` → `win-cpu`.
 *   - Linux (2026-05-28 ADR "Linux ships only `llamacpp-upstream`"): `linux-cpu-x64` and
 *     `linux-vulkan-x64` pass through; on x64 anything with `vulkan` → `linux-vulkan-x64`, everything
 *     else (CUDA tiers included — upstream publishes no `ubuntu-cuda-*`) → `linux-cpu-x64`; arm64 →
 *     the phase-2 placeholder `linux-cpu-arm64`.
 *   - Any other OS: legacy AVX tiers → `<os>common_cpus-<arch>`, else unchanged.
 */
export function mapOldBackendToNew(oldBackend: string): string {
  if (oldBackend.startsWith('ubuntu-')) {
    const archSuffix = oldBackend.includes('-arm64') ? 'arm64' : 'x64'
    if (oldBackend.includes('vulkan')) return `linux-vulkan-${archSuffix}`
    return `linux-cpu-${archSuffix}`
  }

  const isWindows = oldBackend.startsWith('win-')
  const isLinux = oldBackend.startsWith('linux-')
  const osPrefix = isWindows ? 'win-' : isLinux ? 'linux-' : ''

  const archSuffix = oldBackend.includes('-arm64') ? 'arm64' : 'x64'
  const isX64 = archSuffix === 'x64'
  const arch = archSuffix

  if (
    isWindows &&
    (oldBackend === 'win-cpu-x64' ||
      oldBackend === 'win-cuda-13-x64' ||
      oldBackend.includes('cuda-12.4') ||
      oldBackend.includes('cuda-13.3') ||
      oldBackend.includes('rocm') ||
      oldBackend === 'win-vulkan-x64')
  ) {
    return oldBackend
  }

  if (isWindows && (oldBackend.includes('cuda-13') || oldBackend.includes('cu13'))) {
    return `win-cuda-13.3-${arch}`
  }
  if (isWindows && (oldBackend.includes('cuda-12') || oldBackend.includes('cu12'))) {
    return `win-cuda-12.4-${arch}`
  }
  if (isWindows && (oldBackend.includes('cuda-11') || oldBackend.includes('cu11'))) {
    return `win-cuda-12.4-${arch}`
  }
  if (isWindows && oldBackend.includes('vulkan')) {
    return `win-vulkan-${arch}`
  }
  if (
    isWindows &&
    (oldBackend.includes('common_cpus') ||
      oldBackend.includes('avx512') ||
      oldBackend.includes('avx2') ||
      oldBackend.includes('avx-x64') ||
      oldBackend.includes('noavx-x64'))
  ) {
    return `win-cpu-${arch}`
  }

  if (isLinux) {
    if (oldBackend === 'linux-cpu-x64' || oldBackend === 'linux-vulkan-x64') return oldBackend
    if (isX64) {
      if (oldBackend.includes('vulkan')) return 'linux-vulkan-x64'
      return 'linux-cpu-x64'
    }
    return 'linux-cpu-arm64'
  }

  const isOldCpuBackend =
    oldBackend.includes('avx512') ||
    oldBackend.includes('avx2') ||
    oldBackend.includes('avx-x64') ||
    oldBackend.includes('noavx-x64')
  if (isOldCpuBackend) return `${osPrefix}common_cpus-${arch}`

  return oldBackend
}

/**
 * The id a stored backend-type preference should migrate to, or `null` when it is already current
 * or the mapped type is not available in `versionBackends` (then the preference is left alone).
 */
export function shouldMigrateBackend(
  storedBackendType: string,
  versionBackends: BackendVersion[]
): string | null {
  const mapped = mapOldBackendToNew(storedBackendType)
  if (mapped === storedBackendType) return null
  const available = versionBackends.some((vb) => mapOldBackendToNew(vb.backend) === mapped)
  return available ? mapped : null
}

/**
 * Interpret a settings write. Only `version_backend` matters: its value is BOM-stripped, split into
 * `<version>/<backend>` (`INVALID_ARGUMENT` otherwise), the backend id normalised, and
 * `backend_type_updated` says whether the effective type differs from `currentStoredBackend`
 * (`null` stored → updated). A `version_backend` write always needs an installation check.
 */
export function handleSettingUpdate(
  key: string,
  value: string,
  currentStoredBackend: string | null
): SettingUpdateResult {
  if (key !== 'version_backend') {
    return {
      backend_type_updated: false,
      effective_backend_type: null,
      needs_backend_installation: false,
      version: null,
      backend: null,
    }
  }
  const cleanValue = value.replace(/\uFEFF/g, '')
  const parts = cleanValue.split('/')
  if (parts.length !== 2) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid backend format: ${cleanValue}`)
  }
  const version = (parts[0] ?? '').trim()
  const backend = (parts[1] ?? '').trim()
  if (!version || !backend) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `Invalid backend format: ${value}`)
  }
  const effectiveBackendType = mapOldBackendToNew(backend)
  const backendTypeUpdated =
    currentStoredBackend === null ? true : currentStoredBackend !== effectiveBackendType
  return {
    backend_type_updated: backendTypeUpdated,
    effective_backend_type: effectiveBackendType,
    needs_backend_installation: true,
    version,
    backend,
  }
}
