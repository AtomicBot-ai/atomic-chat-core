/**
 * The `configureBackends` startup recovery in `extensions/llamacpp-upstream-extension/src/index.ts`:
 * persisted `version_backend` recovery and the bundled-build / same-type upgrade decisions,
 * extracted from the settings/UI plumbing.
 *
 * Nothing here reads hardware, disk or network: the persisted values, the installed list, the
 * probe result and the catalog are parameters.
 */

import { friendlyBackendLabel, WIN_ROCM_FAMILY_ID } from '../catalog/index.js'
import type { BackendOption, BackendVersion, GpuProbeInfo } from '../types.js'
import { isConcreteVersionBackend, parseBuildNumber, stripBom } from '../version.js'
import { determineBestBackend } from './categories.js'

// ---------------------------------------------------------------------------------------------
// configureBackends startup decisions (index.ts:1070-1660), extracted from the settings/UI plumbing
// ---------------------------------------------------------------------------------------------

/** Persisted `version_backend` is unusable: empty, `none`, or not `<version>/<backend>`. */
export function isPersistedVersionBackendMissing(versionBackend: string | undefined | null): boolean {
  const vb = versionBackend || ''
  return !vb || vb === 'none' || !vb.includes('/')
}

/**
 * When the persisted `version_backend` was lost (wiped WebView storage, factory reset) but builds
 * are still on disk, pick the best installed one so the user's GPU backend survives the restart
 * instead of silently re-pinning the bundled CPU build. `null` when nothing usable is installed.
 */
export function recoverVersionBackendFromDisk(
  installed: readonly BackendVersion[],
  gpus: readonly GpuProbeInfo[]
): string | null {
  if (installed.length === 0) return null
  const recovered = determineBestBackend(installed, gpus)
  return recovered.includes('/') ? recovered : null
}

/**
 * Apply the bundled build over the persisted value when that value is still not a concrete
 * `<tag>/<backend>` after recovery — including the unresolved `latest/<backend>` sentinel, which
 * an `includes('/')` check let through and left pinned in a retry loop (ATO-124).
 */
export function shouldApplyBundledBackend(versionBackendAfterRecovery: string | undefined | null): boolean {
  return !isConcreteVersionBackend(versionBackendAfterRecovery ?? '')
}

/**
 * Backend ids behind the static "Latest <variant>" dropdown entries, unfiltered by hardware on
 * purpose (a manual override). Windows offers the minor-less CUDA / ROCm family ids; Linux CPU and
 * Vulkan; macOS only `macos-arm64`, and only when the bundled (or current) build is that arch — an
 * Intel host gets no sentinel because `latest/macos-x64` resolves to nothing.
 */
export function staticLatestVariants(osType: string, macHostVersionBackend?: string | null): string[] {
  if (osType === 'windows')
    return ['win-cpu-x64', 'win-cuda-12-x64', 'win-cuda-13-x64', WIN_ROCM_FAMILY_ID, 'win-vulkan-x64']
  if (osType === 'linux') return ['linux-cpu-x64', 'linux-vulkan-x64']
  if (osType === 'macos') {
    const variant = stripBom(macHostVersionBackend ?? '')
      .split('/')[1]
      ?.trim()
    return variant === 'macos-arm64' ? [variant] : []
  }
  return []
}

/** `latest/<backend>` sentinels with their "Latest <label>" names. */
export function latestBackendOptions(variants: readonly string[]): BackendOption[] {
  return variants.map((backend) => ({
    value: `latest/${backend}`,
    name: `Latest ${friendlyBackendLabel(backend)}`,
  }))
}

/**
 * Force-switch to the bundled build only when it is a *newer* release tag of the *same* type
 * (app update bumped the engine). Comparing, not assuming: the bundled build is reported on every
 * launch, so "the strings differ" would drag a runtime-updated user back to the installer's tag.
 */
export function isBundledNewerSameType(
  bundled: string | undefined | null,
  effective: string | undefined | null
): boolean {
  if (!bundled || !effective || !effective.includes('/')) return false
  const [bundledVersion, bundledType] = bundled.split('/')
  const [currentVersion, currentType] = effective.split('/')
  const bundledBuild = parseBuildNumber(stripBom(bundledVersion ?? ''))
  const currentBuild = parseBuildNumber(stripBom(currentVersion ?? ''))
  return (
    effective !== bundled &&
    bundledType === currentType &&
    bundledBuild !== null &&
    currentBuild !== null &&
    bundledBuild > currentBuild
  )
}

/**
 * The auto-upgrade candidate: `best` when it differs from `effective` and is of the same backend
 * type, else `null`. The caller must still check the candidate is installed on disk before
 * switching — pointing config at a build that is not downloaded yet is exactly the CUDA→CPU
 * regression this guards against.
 */
export function sameTypeUpgradeCandidate(
  effective: string | undefined | null,
  best: string | undefined | null
): string | null {
  if (!effective || !best || effective === best || !effective.includes('/')) return null
  const currentType = effective.split('/')[1]?.trim()
  const bestType = best.split('/')[1]?.trim()
  if (!currentType || !bestType || currentType !== bestType) return null
  return best
}

/**
 * Fresh install or a saved backend that is genuinely gone: empty / `none` / malformed, or absent
 * from the catalog *and* not installed. Absent-but-installed is kept (the catalog comes partly from
 * a remote fetch that can fail or truncate; resetting on that alone regressed CUDA→CPU on restart).
 */
export function savedBackendVanished(
  effective: string | undefined | null,
  versionBackends: readonly BackendVersion[],
  savedVbIsInstalled: boolean
): boolean {
  const vb = effective || ''
  const savedNotInList =
    !!vb && vb.includes('/') && !versionBackends.some((e) => `${e.version}/${e.backend}` === vb)
  return !vb || vb === 'none' || !vb.includes('/') || (savedNotInList && !savedVbIsInstalled)
}
