/**
 * What differs between the llama.cpp providers when the advisor answers — one table per provider
 * (upstream, TurboQuant, PrismML), pure. `advisor.ts` composes a policy with hardware, catalog,
 * store and clock.
 *
 * Every entry is the function the provider's extension called (upstream:
 * `extensions/llamacpp-upstream-extension/src/{backend,index}.ts` + `tauri-plugin-llamacpp-upstream`;
 * TurboQuant: `extensions/llamacpp-extension/src/{backend,index}.ts` + `tauri-plugin-llamacpp`),
 * already ported into `select/`, `catalog/`, `optimal/` and `turboquant.ts`. The differences kept
 * verbatim: 2 GiB vs 6 GiB VRAM floors, the Windows CUDA-12 driver floors, upstream Linux = Vulkan/CPU
 * only, the `already_optimal` rule, what a `no_catalog_entry` recheck writes, and how a concrete
 * target is resolved (the fork never borrows the current tag).
 */

import type { LlamacppProviderId } from '../../contracts/index.js'
import { isConcreteOfGpuFamily, mapOldBackendToNew, resolveLatestVersionBackend } from '../catalog/index.js'
import { resolveConcreteOptimalBackend } from '../optimal/index.js'
import type { AlreadyOptimalRule, ConcreteBackendResolver, OptimalRecordPolicy } from '../optimal/index.js'
import {
  checkBackendForUpdates,
  checkPrismBackendForUpdates,
  checkTurboquantBackendForUpdates,
  detectIdealBackendType,
  detectIdealPrismBackendType,
  detectIdealTurboquantBackendType,
  determineBestBackend,
  determineBestPrismBackend,
  determinePrismSupportedBackends,
  determineSupportedBackends,
  filterBackendsBySupport,
  filterPrismBackendsBySupport,
  findLatestPrismVersionForBackend,
  findLatestTurboquantVersionForBackend,
  findLatestVersionForBackend,
  getBackendCategory,
  getPrismBackendCategory,
  getPrismSupportedFeatures,
  getSupportedFeatures,
  listSupportedBackends,
  mergePrismBackends,
  staticLatestVariants,
} from '../select/index.js'
import {
  compareTurboquantBackendsForSort,
  determineBestTurboquantBackend,
  determineTurboquantSupportedBackends,
  filterTurboquantBackendsBySupport,
  getTurboquantBackendCategory,
  getTurboquantSupportedFeatures,
  isStableReleaseTag,
  mapOldTurboquantBackendToNew,
} from '../turboquant.js'
import type { RocmHostProbe } from '../turboquant.js'
import type {
  BackendFeatures,
  BackendVersion,
  GpuProbeInfo,
  IdealBackendResult,
  SupportedFeatures,
  TierHealth,
  UpdateCheckResult,
} from '../types.js'
import { stripBom } from '../version.js'

/** What `detect` gets from the advisor: the facts plus the two host-bound closures. */
export interface AdvisorDetectInput {
  osType: string
  arch: string
  cpuExtensions: readonly string[]
  gpus: readonly GpuProbeInfo[]
  /** Linux + TurboQuant: amdkfd / HIP facts; ignored by upstream. */
  rocm?: RocmHostProbe
  /** The hardware-gated catalog of this provider (`available`). */
  listAvailableBackends: () => Promise<BackendVersion[]>
  /** Windows + upstream: `tierEnumeratesDevices` bound to this host; ignored by the fork. */
  probeTier: (tier: string) => Promise<TierHealth>
  onWarn?: (message: string) => void
}

/** What a `no_catalog_entry` recheck persists: upstream cleared its cache, the fork kept the record. */
export type NoCatalogEntryWrite = 'null' | 'record'

export interface BackendProviderPolicy {
  readonly provider: LlamacppProviderId
  /** `get_supported_features` of the provider's plugin. */
  features(
    osType: string,
    cpuExtensions: readonly string[],
    gpus: readonly GpuProbeInfo[],
    rocm?: RocmHostProbe
  ): SupportedFeatures
  /** `determine_supported_backends`; throws `INVALID_ARGUMENT` for an OS/arch the provider has no build for. */
  supportedBackends(osType: string, arch: string, features: BackendFeatures): string[]
  /** `list_supported_backends`: remote + installed, keyed, sorted newest first by the provider's comparator. */
  merge(remote: readonly BackendVersion[], local: readonly BackendVersion[]): BackendVersion[]
  /** The extension's hardware gate on the merged catalog. */
  filterBySupport(
    merged: readonly BackendVersion[],
    supported: readonly string[],
    osType: string
  ): BackendVersion[]
  /** The extension's `determineBestBackend`; `''` for an empty catalog. */
  determineBest(available: readonly BackendVersion[], gpus: readonly GpuProbeInfo[]): string
  /** `find_latest_version_for_backend`. */
  findLatest(list: readonly BackendVersion[], backendType: string): string | null
  /** Ids behind the static "Latest <variant>" dropdown entries. */
  staticVariants(osType: string, currentVersionBackend: string, arch?: string): string[]
  /** `get_backend_category`. */
  getCategory(backend: string): string | null
  readonly alreadyOptimalRule: AlreadyOptimalRule
  readonly noCatalogEntryWrites: NoCatalogEntryWrite
  /** `map_old_backend_to_new`. */
  normalizeId(backend: string): string
  /** Whether a tag bump from `currentType` to `targetType` stays inside one backend family. */
  sameFamily(currentType: string, targetType: string): boolean
  /** Whether a resolved update target may be offered at all (the fork offers stable tags only). */
  acceptsUpdateTarget(target: string): boolean
  /** `check_backend_for_updates`; throws `INVALID_ARGUMENT` for a current that is not `<tag>/<id>`. */
  checkUpdates(current: string, list: readonly BackendVersion[]): UpdateCheckResult
  /** A `latest/<id>` sentinel's concrete target in the catalog, or `null`. */
  resolveSentinel(backendId: string, available: readonly BackendVersion[]): string | null
  detect(input: AdvisorDetectInput): Promise<IdealBackendResult>
  /** The concrete `<tag>/<id>` for a detected ideal type, or `null`. */
  resolveConcrete(idealType: string, current: string, deps: ConcreteBackendResolver): Promise<string | null>
}

/** The `optimal-cache.ts` view of a policy. */
export function recordPolicyOf(policy: BackendProviderPolicy): OptimalRecordPolicy {
  return {
    provider: policy.provider,
    getCategory: (backend) => policy.getCategory(backend),
    alreadyOptimalRule: policy.alreadyOptimalRule,
  }
}

export const UPSTREAM_POLICY: BackendProviderPolicy = {
  provider: 'llamacpp-upstream',
  features: (osType, cpuExtensions, gpus) => getSupportedFeatures(osType, cpuExtensions, gpus),
  supportedBackends: determineSupportedBackends,
  merge: listSupportedBackends,
  filterBySupport: filterBackendsBySupport,
  determineBest: determineBestBackend,
  findLatest: findLatestVersionForBackend,
  staticVariants: (osType, current, arch) => staticLatestVariants(osType, current, arch),
  getCategory: getBackendCategory,
  alreadyOptimalRule: 'type-and-category',
  noCatalogEntryWrites: 'null',
  normalizeId: mapOldBackendToNew,
  sameFamily: (currentType, targetType) => {
    const migrated = mapOldBackendToNew(currentType)
    return (
      targetType === currentType ||
      targetType === migrated ||
      isConcreteOfGpuFamily(currentType, targetType) ||
      isConcreteOfGpuFamily(migrated, targetType)
    )
  },
  acceptsUpdateTarget: () => true,
  checkUpdates: checkBackendForUpdates,
  resolveSentinel: (backendId, available) => resolveLatestVersionBackend(backendId, [...available]),
  detect: (input) =>
    detectIdealBackendType({
      osType: input.osType,
      arch: input.arch,
      cpuExtensions: input.cpuExtensions,
      gpus: input.gpus,
      listAvailableBackends: input.listAvailableBackends,
      probeTier: input.probeTier,
      ...(input.onWarn ? { onWarn: input.onWarn } : {}),
    }),
  resolveConcrete: (idealType, current, deps) =>
    resolveConcreteOptimalBackend(idealType, current, deps, 'BackendAdvisor.recommend'),
}

export const TURBOQUANT_POLICY: BackendProviderPolicy = {
  provider: 'llamacpp',
  features: (osType, cpuExtensions, gpus, rocm) =>
    getTurboquantSupportedFeatures(osType, cpuExtensions, gpus, rocm),
  supportedBackends: determineTurboquantSupportedBackends,
  merge: (remote, local) => listSupportedBackends(remote, local).sort(compareTurboquantBackendsForSort),
  filterBySupport: (merged, supported) => filterTurboquantBackendsBySupport(merged, supported),
  determineBest: determineBestTurboquantBackend,
  findLatest: findLatestTurboquantVersionForBackend,
  staticVariants: () => [],
  getCategory: getTurboquantBackendCategory,
  alreadyOptimalRule: 'category',
  noCatalogEntryWrites: 'record',
  normalizeId: mapOldTurboquantBackendToNew,
  sameFamily: (currentType, targetType) =>
    targetType === currentType || targetType === mapOldTurboquantBackendToNew(currentType),
  acceptsUpdateTarget: (target) => isStableReleaseTag(target),
  checkUpdates: checkTurboquantBackendForUpdates,
  resolveSentinel: (backendId, available) =>
    findLatestTurboquantVersionForBackend(available, mapOldTurboquantBackendToNew(backendId)),
  detect: (input) =>
    detectIdealTurboquantBackendType({
      osType: input.osType,
      arch: input.arch,
      cpuExtensions: input.cpuExtensions,
      gpus: input.gpus,
      ...(input.rocm ? { rocm: input.rocm } : {}),
      listAvailableBackends: input.listAvailableBackends,
      ...(input.onWarn ? { onWarn: input.onWarn } : {}),
    }),
  /**
   * Exact catalog match only. Never reuse the current backend's tag: the catalog entry is the only
   * thing that knows which release carries a variant, and a legacy install can still sit on a
   * per-variant tag (`resolveConcreteBackend` of the fork extension).
   */
  resolveConcrete: async (idealType, _current, deps) => {
    try {
      const match = (await deps.listSupportedBackends()).find((b) => stripBom(b.backend) === idealType)
      return match ? `${stripBom(match.version)}/${stripBom(match.backend)}` : null
    } catch (err) {
      deps.onWarn?.(
        `resolveConcreteBackend: failed to resolve concrete tag from catalog: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  },
}

/**
 * PrismML (`atomic-prism`). Its catalog is already filtered to offered releases (approved, not
 * withdrawn, runnable by this core) before the policy sees it, so every resolved target may be
 * offered. A tag bump never changes the backend id, and the category rule keeps a CUDA 12.4 user from
 * being nudged to 12.8.
 */
export const PRISM_POLICY: BackendProviderPolicy = {
  provider: 'atomic-prism',
  features: (osType, cpuExtensions, gpus, rocm) =>
    getPrismSupportedFeatures(osType, cpuExtensions, gpus, rocm),
  supportedBackends: determinePrismSupportedBackends,
  merge: mergePrismBackends,
  filterBySupport: (merged, supported) => filterPrismBackendsBySupport(merged, supported),
  determineBest: determineBestPrismBackend,
  findLatest: findLatestPrismVersionForBackend,
  staticVariants: () => [],
  getCategory: getPrismBackendCategory,
  alreadyOptimalRule: 'category',
  noCatalogEntryWrites: 'record',
  normalizeId: (backend) => stripBom(backend),
  sameFamily: (currentType, targetType) => currentType === targetType,
  acceptsUpdateTarget: () => true,
  checkUpdates: checkPrismBackendForUpdates,
  resolveSentinel: (backendId, available) => findLatestPrismVersionForBackend(available, backendId),
  detect: (input) =>
    detectIdealPrismBackendType({
      osType: input.osType,
      arch: input.arch,
      cpuExtensions: input.cpuExtensions,
      gpus: input.gpus,
      ...(input.rocm ? { rocm: input.rocm } : {}),
      listAvailableBackends: input.listAvailableBackends,
      ...(input.onWarn ? { onWarn: input.onWarn } : {}),
    }),
  resolveConcrete: async (idealType, _current, deps) => {
    try {
      return findLatestPrismVersionForBackend(await deps.listSupportedBackends(), idealType)
    } catch (err) {
      deps.onWarn?.(`resolveConcrete: ${err instanceof Error ? err.message : String(err)}`)
      return null
    }
  },
}

export function policyFor(provider: LlamacppProviderId): BackendProviderPolicy {
  if (provider === 'atomic-prism') return PRISM_POLICY
  return provider === 'llamacpp' ? TURBOQUANT_POLICY : UPSTREAM_POLICY
}

/** The provider ids the advisor answers for; anything else is a caller error. */
export function isLlamacppProviderId(value: unknown): value is LlamacppProviderId {
  return value === 'llamacpp-upstream' || value === 'llamacpp' || value === 'atomic-prism'
}
