/**
 * The optimal-backend cache record and the recheck / refresh decisions around it. Port of
 * `getCachedOptimalBackend`, `persistOptimalBackendCache`, `resolveConcreteOptimalBackend`,
 * `refreshOptimalBackendCache` and `recheckOptimalBackend` from
 * `extensions/llamacpp-upstream-extension/src/index.ts`, without the storage, events and timeouts.
 *
 * The app keeps the record in `localStorage[OPTIMAL_BACKEND_CACHE_KEY]`; the core keeps it in
 * `<data>/atomic-core/optimal-backend.json` (`DataLayout.core.optimalBackend`). Same JSON either way.
 *
 * What the caller does around these functions (the entangled halves left in the app):
 *   - skips both flows entirely on macOS (there are no GPU tiers to recommend);
 *   - runs `detectIdealBackendType` under a 20 s timeout, mapping a timeout to `detection-failed`;
 *   - on `detection_failed` throws the `BACKEND_DETECTION_FAILED` sentinel (the UI matches its
 *     message) and leaves the record and any prior recommendation untouched;
 *   - persists `record`, and for `recheckOptimalBackend` writes / removes
 *     `BETTER_BACKEND_RECOMMENDATION_KEY` and emits `onBetterBackendDetected` with `payload`.
 */

import { resolveLatestVersionBackend } from '../catalog/index.js'
import { backendCategoryToLabel, findLatestVersionForBackend, getBackendCategory } from '../select/index.js'
import type {
  BackendRecommendation,
  BackendVersion,
  IdealBackendResult,
  OptimalBackendCacheRecord,
} from '../types.js'
import { isConcreteVersionBackend, stripBom } from '../version.js'

export const OPTIMAL_BACKEND_CACHE_KEY = 'atomic_llamacpp_upstream_optimal_backend_v1'
export const OPTIMAL_BACKEND_PROVIDER = 'llamacpp-upstream'
/** Legacy recommendation key the `useBackendUpdater` mount path still reads. */
export const BETTER_BACKEND_RECOMMENDATION_KEY = 'llama_cpp_better_backend_recommendation'
/**
 * Sentinel `Error.message` for "detection could not complete — keep the current backend"
 * (ATO-161). The web-app handler matches the literal value; keep the two in sync.
 */
export const BACKEND_DETECTION_FAILED = 'BACKEND_DETECTION_FAILED'

export type CompletedDetection = Exclude<IdealBackendResult, { kind: 'detection-failed' }>

/**
 * Validate a stored record. Anything with the wrong schema, provider, a non-finite or negative
 * `detectedAt`, missing strings, a `gpu` record whose `recommendedBackend` is not a concrete
 * `<tag>/<idealBackendId>`, or a `cpu-optimal` record carrying GPU fields is `null` (ignored).
 */
export function parseOptimalBackendCache(
  raw: string | null | undefined,
  provider: 'llamacpp-upstream' | 'llamacpp' = OPTIMAL_BACKEND_PROVIDER
): OptimalBackendCacheRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      value === null ||
      typeof value !== 'object' ||
      value.schemaVersion !== 1 ||
      value.provider !== provider ||
      !Number.isFinite(value.detectedAt) ||
      (value.detectedAt as number) < 0 ||
      typeof value.currentBackend !== 'string' ||
      typeof value.recommendedCategory !== 'string' ||
      !value.recommendedCategory
    ) {
      return null
    }
    if (value.detectionKind === 'gpu') {
      const recommendedType =
        typeof value.recommendedBackend === 'string'
          ? stripBom(value.recommendedBackend).split('/')[1]
          : undefined
      if (
        typeof value.idealBackendId !== 'string' ||
        !value.idealBackendId ||
        (value.recommendedBackend !== undefined &&
          (typeof value.recommendedBackend !== 'string' ||
            // TurboQuant's validator (`llamacpp-extension` index.ts) only asks for `<tag>/<id>`: the
            // fork has no `latest/` sentinel to exclude.
            (provider === 'llamacpp'
              ? stripBom(value.recommendedBackend).split('/').length !== 2
              : !isConcreteVersionBackend(value.recommendedBackend)) ||
            recommendedType !== stripBom(value.idealBackendId)))
      ) {
        return null
      }
      return value as unknown as OptimalBackendCacheRecord
    }
    if (value.detectionKind === 'cpu-optimal') {
      if (value.idealBackendId !== undefined || value.recommendedBackend !== undefined) return null
      return value as unknown as OptimalBackendCacheRecord
    }
    return null
  } catch {
    return null
  }
}

/** The record to persist for a completed detection (`persistOptimalBackendCache` minus the write). */
export function buildOptimalBackendCacheRecord(
  detection: CompletedDetection,
  currentBackend: string,
  recommendedBackend: string | null | undefined,
  now: number
): OptimalBackendCacheRecord {
  if (detection.kind === 'cpu-optimal') {
    return {
      schemaVersion: 1,
      provider: OPTIMAL_BACKEND_PROVIDER,
      detectedAt: now,
      detectionKind: 'cpu-optimal',
      currentBackend,
      recommendedCategory: 'CPU',
    }
  }
  return {
    schemaVersion: 1,
    provider: OPTIMAL_BACKEND_PROVIDER,
    detectedAt: now,
    detectionKind: 'gpu',
    currentBackend,
    idealBackendId: detection.backend,
    ...(recommendedBackend ? { recommendedBackend } : {}),
    recommendedCategory: backendCategoryToLabel(getBackendCategory(detection.backend) ?? 'unknown'),
  }
}

export interface ConcreteBackendResolver {
  /** The hardware-gated catalog (remote + local). The caller bounds it (the app: 20 s → `[]`). */
  listSupportedBackends: () => Promise<BackendVersion[]>
  /** The remote catalog alone, for `resolveLatestVersionBackend`. Bounded likewise (20 s → `[]`). */
  fetchRemoteBackends: () => Promise<BackendVersion[]>
  onWarn?: (message: string) => void
}

/**
 * Concrete `<tag>/<backend>` for the detected ideal type: newest catalog entry of that type, else the
 * newest remote asset (exact or family match), else the current backend's tag with the ideal type
 * (so an in-family migration such as CUDA 13.1 → 13.3 still gets a target), else `null` when there is
 * no current tag to borrow.
 */
export async function resolveConcreteOptimalBackend(
  idealType: string,
  currentBackend: string,
  deps: ConcreteBackendResolver,
  operation = 'resolveConcreteOptimalBackend'
): Promise<string | null> {
  const warn = deps.onWarn ?? (() => {})
  let recommended: string | null = null
  try {
    recommended = findLatestVersionForBackend(await deps.listSupportedBackends(), idealType)
  } catch (err) {
    warn(
      `${operation}: failed to resolve latest backend for ${idealType}, falling back to current version: ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }
  if (recommended) return recommended

  try {
    recommended = resolveLatestVersionBackend(idealType, await deps.fetchRemoteBackends())
  } catch (err) {
    warn(
      `${operation}: failed to fetch latest release for '${idealType}': ${err instanceof Error ? err.message : String(err)}`
    )
  }
  if (recommended) return recommended

  const fallbackVersion = currentBackend.split('/')[0]
  if (!fallbackVersion) {
    warn(
      `${operation}: could not resolve a concrete tag for ${idealType} and no current backend tag to fall back to`
    )
    return null
  }
  return `${fallbackVersion}/${idealType}`
}

export type RefreshOutcome =
  { outcome: 'detection_failed' } | { outcome: 'cached'; record: OptimalBackendCacheRecord }

/**
 * Silent cache refresh (startup coordinator, once per launch). Never emits a recommendation. A
 * failed concrete resolution still caches the `gpu` verdict, just without `recommendedBackend`.
 */
export async function refreshOptimalBackendCache(
  detection: IdealBackendResult,
  currentBackend: string,
  resolveConcrete: (idealType: string, currentBackend: string) => Promise<string | null>,
  now: number
): Promise<RefreshOutcome> {
  if (detection.kind === 'detection-failed') return { outcome: 'detection_failed' }
  const current = stripBom(currentBackend)
  if (detection.kind === 'cpu-optimal') {
    return { outcome: 'cached', record: buildOptimalBackendCacheRecord(detection, current, null, now) }
  }
  let recommended: string | null = null
  try {
    recommended = await resolveConcrete(detection.backend, current)
  } catch {
    recommended = null
  }
  return { outcome: 'cached', record: buildOptimalBackendCacheRecord(detection, current, recommended, now) }
}

/**
 * Why `recheckOptimalBackend` did or did not produce a recommendation. The app collapsed four of
 * these into `null` and telemetry could not tell `already_optimal` (healthy) from the rest.
 */
export type RecheckOutcome =
  | { outcome: 'detection_failed' }
  | { outcome: 'cpu_optimal'; record: OptimalBackendCacheRecord }
  | { outcome: 'already_optimal'; record: OptimalBackendCacheRecord }
  | { outcome: 'no_catalog_entry'; record: OptimalBackendCacheRecord }
  | { outcome: 'recommend'; record: OptimalBackendCacheRecord; payload: BackendRecommendation }

/**
 * Manual "Find optimal backend" / onboarding recheck. Same category *and* same backend type as the
 * current build is `already_optimal` without resolving anything; otherwise the concrete target is
 * resolved and compared — equal to current is `already_optimal`, nothing resolvable is
 * `no_catalog_entry`, else `recommend` with the event payload.
 */
export async function recheckOptimalBackend(
  detection: IdealBackendResult,
  currentBackend: string,
  resolveConcrete: (idealType: string, currentBackend: string) => Promise<string | null>,
  now: number
): Promise<RecheckOutcome> {
  if (detection.kind === 'detection-failed') return { outcome: 'detection_failed' }
  const current = stripBom(currentBackend)
  if (detection.kind === 'cpu-optimal') {
    return { outcome: 'cpu_optimal', record: buildOptimalBackendCacheRecord(detection, current, null, now) }
  }

  const idealType = detection.backend
  const idealCategory = getBackendCategory(idealType)
  const currentType = current.split('/')[1] || ''
  const currentCategory = getBackendCategory(currentType)
  if (idealCategory === currentCategory && currentType === idealType) {
    return {
      outcome: 'already_optimal',
      record: buildOptimalBackendCacheRecord(detection, current, current, now),
    }
  }

  const recommended = await resolveConcrete(idealType, current)
  const record = buildOptimalBackendCacheRecord(detection, current, recommended, now)
  if (!recommended) return { outcome: 'no_catalog_entry', record }
  if (recommended === current) return { outcome: 'already_optimal', record }

  const [version, backendId] = recommended.split('/')
  return {
    outcome: 'recommend',
    record,
    payload: {
      currentBackend: current,
      recommendedBackend: recommended,
      recommendedCategory: backendCategoryToLabel(idealCategory ?? 'unknown'),
      provider: OPTIMAL_BACKEND_PROVIDER,
      version: version ?? '',
      backendId: backendId ?? '',
    },
  }
}
