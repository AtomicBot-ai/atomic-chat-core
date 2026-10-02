/**
 * The backend advisor: the hardware-gated catalog, the optimal-backend recommendation and the
 * update check for one llama.cpp provider, computed in the core and served over
 * `POST /backends/:provider/{catalog,recommendation,updates}` (2026-09-27 ADR "the core advises on
 * backends, the app decides"). The app used to run all of this in its extensions (`configureBackends`,
 * `detectIdealBackendType`, `recheckOptimalBackend`, `checkBackendForUpdates`); it now asks and
 * decides when to install. The core only answers — and persists the optimal record it derives.
 *
 * Composition, no policy: the rules live in `policy.ts` and the pure modules it points at. This
 * class owns the I/O seams — hardware facts, the installed scan, the remote catalogs (upstream
 * manifest with its session cache, the fork's release index), the optimal store, the event emitter,
 * `--list-devices` for the Windows tier probe, the Linux ROCm probe — every one injected so a test
 * can run the canonical hosts on any OS.
 *
 * Never throws for a network failure: an unreachable release stream degrades to the bundled
 * baseline / disk cache / empty catalog, and a detection that could not complete is the
 * `detection_failed` outcome, not an error. It throws `INVALID_ARGUMENT` only for an OS/arch the
 * provider has no build for and for a bad `mode`.
 */

import type { DataLayout } from '../../config/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  BackendCatalogRelease,
  BackendCatalogRequest,
  BackendCatalogResponse,
  BackendCatalogSource,
  BackendCurrentKind,
  BackendRecommendationOutcome,
  BackendRecommendationRequest,
  BackendRecommendationResponse,
  BackendUpdateCheckRequest,
  BackendUpdateCheckResponse,
  CoreEvents,
  DeviceInfo,
  LlamacppProviderId,
  ProxyConfig,
} from '../../contracts/index.js'
import type { HardwareFacts } from '../../hardware/index.js'
import {
  archSuffixFor,
  BUNDLED_MANIFEST_BASELINE,
  fetchLiveManifest,
  ManifestSessionCache,
  manifestTransportFromFetch,
  parseManifestForPlatform,
  TurboquantCatalogService,
  turboquantCatalogToBackends,
  withHardTimeout,
} from '../catalog/index.js'
import type { TurboquantRelease } from '../catalog/index.js'
import { scanInstalledBackends } from '../installed/index.js'
import { recheckOptimalBackend, refreshOptimalBackendCache } from '../optimal/index.js'
import type { OptimalBackendStore, OptimalState } from '../optimal/index.js'
import { tierEnumeratesDevices } from '../select/index.js'
import { probeLinuxRocmHost } from '../turboquant.js'
import type { RocmHostProbe } from '../turboquant.js'
import type {
  BackendRecommendation,
  BackendVersion,
  IdealBackendResult,
  OptimalBackendCacheRecord,
  TierHealth,
} from '../types.js'
import { stripBom } from '../version.js'
import { policyFor, recordPolicyOf } from './policy.js'
import type { BackendProviderPolicy } from './policy.js'

/** The app's guard around detection (`withTimeout(detectIdealBackendType(), 20_000)`). */
export const BACKEND_DETECTION_TIMEOUT_MS = 20_000

export interface BackendAdvisorDeps {
  provider: LlamacppProviderId
  layout: DataLayout
  /** The current hardware facts (`HardwareService.facts`). */
  hardware: () => Promise<HardwareFacts>
  /** The provider's `version_backend` from the core settings; the request may override it. */
  currentVersionBackend: () => string | undefined | Promise<string | undefined>
  optimalStore: Pick<OptimalBackendStore, 'get' | 'set'>
  emit: (name: 'backend:better-detected', payload: CoreEvents['backend:better-detected']) => void
  /** The `fetch` for a request carrying this proxy policy (`policyFetchFor` in the core). */
  fetchFor: (proxy?: ProxyConfig | null) => typeof fetch
  /** Upstream: the session manifest cache shared with `BackendService.readManifest`. */
  manifestCache?: ManifestSessionCache
  /** TurboQuant: the release-index service; built from `layout` + `fetchFor` when absent. */
  turboquantCatalog?: TurboquantCatalogService
  /** Every pack on disk; defaults to the directory scan. */
  installed?: () => Promise<BackendVersion[]>
  /** Windows + upstream: `<exe> --list-devices` for an installed build; absent = tiers stay unverified. */
  listDevices?: (installed: BackendVersion) => Promise<DeviceInfo[]>
  /** Linux + TurboQuant: amdkfd / HIP facts; defaults to reading sysfs and the library dirs. */
  rocmProbe?: () => Promise<RocmHostProbe>
  now?: () => number
  platform?: NodeJS.Platform
  detectionTimeoutMs?: number
  log?: (level: 'info' | 'warn', message: string) => void
}

interface RemoteCatalog {
  remote: BackendVersion[]
  source: BackendCatalogSource
  releases?: TurboquantRelease[]
}

interface FetchOptions {
  force: boolean
  appVersion: string | null
  proxy: ProxyConfig | null
}

export class BackendAdvisor {
  readonly provider: LlamacppProviderId
  private readonly policy: BackendProviderPolicy
  private readonly manifestCache: ManifestSessionCache
  private readonly turboquant: TurboquantCatalogService
  private inFlightRecommend: Promise<BackendRecommendationResponse> | null = null

  constructor(private readonly deps: BackendAdvisorDeps) {
    this.provider = deps.provider
    this.policy = policyFor(deps.provider)
    this.manifestCache = deps.manifestCache ?? new ManifestSessionCache()
    this.turboquant =
      deps.turboquantCatalog ??
      new TurboquantCatalogService({
        layout: deps.layout,
        fetchFor: deps.fetchFor,
        ...(deps.now ? { now: deps.now } : {}),
        ...(deps.platform ? { platform: deps.platform } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      })
  }

  // -------------------------------------------------------------------------------------------
  // catalog
  // -------------------------------------------------------------------------------------------

  /**
   * The hardware-gated catalog: what `configureBackends` computed in the app. `available` is the
   * merged, gated, sorted list the dropdown shows; `recommended` its best entry;
   * `recommended_installed` the best entry already on disk (the disk-recovery pick);
   * `latest_by_type` the newest tag per type (what `find_latest_version_for_backend` answered one
   * round trip at a time). Throws `INVALID_ARGUMENT` only for an unsupported OS/arch.
   */
  async catalog(request: BackendCatalogRequest = {}): Promise<BackendCatalogResponse> {
    const facts = await this.deps.hardware()
    const current = stripBom(request.current_backend ?? (await this.currentVersionBackend()))
    return this.catalogFor(facts, current, {
      force: request.force ?? false,
      appVersion: request.app_version ?? null,
      proxy: request.proxy ?? null,
    })
  }

  private async catalogFor(
    facts: HardwareFacts,
    current: string,
    options: FetchOptions
  ): Promise<BackendCatalogResponse> {
    const { osType, arch, gpus } = facts
    const cpuExtensions = facts.cpuExtensions ?? []
    const rocm = await this.rocmFacts(osType)
    const features = this.policy.features(osType, cpuExtensions, gpus, rocm)
    const supported = this.policy.supportedBackends(osType, arch, features)

    const [{ remote, source, releases }, installed] = await Promise.all([
      this.remoteCatalog(osType, arch, supported, options),
      this.installed(),
    ])
    const merged = this.policy.merge(remote, installed)
    const available = this.policy.filterBySupport(merged, supported, osType)

    const installedKeys = new Set(installed.map((b) => `${b.version}|${b.backend}`))
    const installedAvailable = available.filter((b) => installedKeys.has(`${b.version}|${b.backend}`))
    const latestByType: Record<string, string> = {}
    for (const entry of available) {
      const type = this.policy.normalizeId(stripBom(entry.backend))
      if (type in latestByType) continue
      const latest = this.policy.findLatest(available, type)
      if (latest) latestByType[type] = latest
    }

    return {
      provider: this.provider,
      os_type: osType,
      arch_suffix: archSuffixFor(arch),
      hardware_source: facts.source,
      features,
      supported_backends: supported,
      remote,
      installed,
      available,
      recommended: this.policy.determineBest(available, gpus) || null,
      recommended_installed: this.policy.determineBest(installedAvailable, gpus) || null,
      latest_by_type: latestByType,
      static_variants: this.policy.staticVariants(osType, current, arch),
      source,
      ...(releases ? { releases: releases.map(toCatalogRelease) } : {}),
    }
  }

  private async remoteCatalog(
    osType: string,
    arch: string,
    supported: readonly string[],
    options: FetchOptions
  ): Promise<RemoteCatalog> {
    if (this.provider === 'llamacpp') {
      const catalog = await this.turboquant.catalog({
        force: options.force,
        appVersion: options.appVersion,
        supportedIds: supported,
        proxy: options.proxy,
      })
      return {
        remote: turboquantCatalogToBackends(catalog, supported),
        source: catalog.source,
        releases: catalog.releases,
      }
    }

    const archSuffix = archSuffixFor(arch)
    if (options.force) this.manifestCache.clear()
    const cached = this.manifestCache.get()
    if (cached) {
      return { remote: parseManifestForPlatform(cached, osType, archSuffix), source: 'session-cache' }
    }
    const live = await fetchLiveManifest({
      cache: this.manifestCache,
      transports: [manifestTransportFromFetch('core fetch', this.deps.fetchFor(options.proxy))],
      onInfo: (message) => this.log('info', message),
      onWarn: (message) => this.log('warn', message),
    })
    if (live) return { remote: parseManifestForPlatform(live, osType, archSuffix), source: 'live' }
    return {
      remote: parseManifestForPlatform(BUNDLED_MANIFEST_BASELINE, osType, archSuffix),
      source: 'bundled-baseline',
    }
  }

  // -------------------------------------------------------------------------------------------
  // recommend
  // -------------------------------------------------------------------------------------------

  /**
   * Detect the ideal backend, resolve a concrete target, build the optimal record and persist it.
   * `refresh` is the silent startup pass (never emits); `recheck` is the user asking (forces a
   * catalog refresh, emits `backend:better-detected` on a recommendation). macOS is `mac` without
   * detection or a write. One pass runs at a time per provider; a second caller shares its result.
   * A `detection_failed` pass leaves the store untouched; a `no_catalog_entry` recheck writes what
   * the provider's extension wrote (upstream: cleared; fork: the record).
   */
  async recommend(request: BackendRecommendationRequest): Promise<BackendRecommendationResponse> {
    if (request.mode !== 'refresh' && request.mode !== 'recheck') {
      throw new AtomicCoreError(
        'INVALID_ARGUMENT',
        `mode must be 'refresh' or 'recheck', got ${String(request.mode)}`
      )
    }
    if (this.inFlightRecommend) return this.inFlightRecommend
    this.inFlightRecommend = this.runRecommend(request).finally(() => {
      this.inFlightRecommend = null
    })
    return this.inFlightRecommend
  }

  private async runRecommend(request: BackendRecommendationRequest): Promise<BackendRecommendationResponse> {
    const started = this.now()
    const mode = request.mode
    const facts = await this.deps.hardware()
    const done = (
      outcome: BackendRecommendationOutcome,
      detection: IdealBackendResult | null,
      record: OptimalBackendCacheRecord | null,
      state: OptimalState,
      recommendation: BackendRecommendation | null
    ): BackendRecommendationResponse => ({
      provider: this.provider,
      mode,
      outcome,
      detection,
      record,
      revision: state.revision,
      optimal: state.optimal,
      recommendation,
      elapsed_ms: Math.max(0, this.now() - started),
    })

    if (facts.osType === 'macos') {
      return done('mac', null, null, this.deps.optimalStore.get(this.provider), null)
    }

    const current = stripBom(request.current_backend ?? (await this.currentVersionBackend()))
    const options: FetchOptions = {
      force: request.force ?? mode === 'recheck',
      appVersion: request.app_version ?? null,
      proxy: request.proxy ?? null,
    }
    // One catalog per pass, fetched lazily inside the detection guard (the app fetched it there too,
    // so a slow release stream trips the 20 s guard the same way) and shared with the resolver.
    let catalogPromise: Promise<BackendCatalogResponse> | null = null
    const catalogOnce = () => (catalogPromise ??= this.catalogFor(facts, current, options))
    const warn = (message: string) => this.log('warn', message)

    const detection: IdealBackendResult = request.assume_no_gpu
      ? { kind: 'cpu-optimal' }
      : await withHardTimeout(
          this.policy.detect({
            osType: facts.osType,
            arch: facts.arch,
            cpuExtensions: facts.cpuExtensions ?? [],
            gpus: facts.gpus,
            ...(await this.rocmInput(facts.osType)),
            listAvailableBackends: async () => (await catalogOnce()).available,
            probeTier: (tier) => this.probeTier(tier, facts),
            onWarn: warn,
          }),
          this.deps.detectionTimeoutMs ?? BACKEND_DETECTION_TIMEOUT_MS,
          `detectIdealBackendType timed out after ${this.deps.detectionTimeoutMs ?? BACKEND_DETECTION_TIMEOUT_MS}ms`
        ).catch((err: unknown): IdealBackendResult => {
          warn(
            `recommend: ${err instanceof Error ? err.message : String(err)}; treating as detection failure`
          )
          return { kind: 'detection-failed' }
        })

    if (detection.kind === 'detection-failed') {
      return done('detection_failed', detection, null, this.deps.optimalStore.get(this.provider), null)
    }

    const resolve = (idealType: string, currentBackend: string) =>
      this.policy.resolveConcrete(idealType, currentBackend, {
        listSupportedBackends: async () => (await catalogOnce()).available,
        fetchRemoteBackends: async () => (await catalogOnce()).remote,
        onWarn: warn,
      })
    const recordPolicy = recordPolicyOf(this.policy)
    const now = this.now()

    if (mode === 'refresh') {
      const result = await refreshOptimalBackendCache(detection, current, resolve, now, recordPolicy)
      // `detection-failed` was handled above; the refresh outcome is always `cached` here.
      const record = result.outcome === 'cached' ? result.record : null
      const state = await this.persist(record)
      return done(
        refreshOutcome(record, current),
        detection,
        record,
        state,
        recommendationOf(record, this.provider)
      )
    }

    const result = await recheckOptimalBackend(detection, current, resolve, now, recordPolicy)
    if (result.outcome === 'detection_failed') {
      return done('detection_failed', detection, null, this.deps.optimalStore.get(this.provider), null)
    }
    const write =
      result.outcome === 'no_catalog_entry' && this.policy.noCatalogEntryWrites === 'null'
        ? null
        : result.record
    const state = await this.persist(write)
    if (result.outcome === 'recommend') {
      this.deps.emit('backend:better-detected', {
        provider: this.provider,
        currentBackend: result.payload.currentBackend,
        recommendedBackend: result.payload.recommendedBackend,
        recommendedCategory: result.payload.recommendedCategory,
        version: result.payload.version,
        backendId: result.payload.backendId,
      })
      return done('recommend', detection, result.record, state, result.payload)
    }
    return done(result.outcome, detection, result.record, state, null)
  }

  /** Write with the store's compare-and-set; one retry against the revision a conflict reveals. */
  private async persist(value: OptimalBackendCacheRecord | null): Promise<OptimalState> {
    let state = this.deps.optimalStore.get(this.provider)
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.deps.optimalStore.set(this.provider, value, state.revision)
      if (result.status === 'updated') return result.current
      state = result.current
    }
    this.log(
      'warn',
      `recommend: optimal-backend store moved twice under this pass; keeping revision ${state.revision}`
    )
    return state
  }

  private async probeTier(tier: string, facts: HardwareFacts): Promise<TierHealth> {
    const listDevices = this.deps.listDevices
    if (!listDevices) return 'unverified'
    return tierEnumeratesDevices(
      tier,
      facts.gpus,
      { listInstalled: () => this.installed(), listDevices },
      (message) => this.log('info', message)
    )
  }

  // -------------------------------------------------------------------------------------------
  // checkUpdates
  // -------------------------------------------------------------------------------------------

  /**
   * Whether a newer build of the current backend's type exists, plus what the app needs to decide
   * whether to offer it: `current_kind` (a missing `version_backend` is `update_needed: false`, not
   * the throw the plugin produced; a parked `latest/<id>` sentinel resolves to its concrete target),
   * `same_family` (a tag bump must never move anyone between backend families) and `offer`.
   */
  async checkUpdates(request: BackendUpdateCheckRequest = {}): Promise<BackendUpdateCheckResponse> {
    const current = stripBom(request.current ?? (await this.currentVersionBackend()))
    const kind = classifyCurrent(current)
    const catalog = await this.catalog({
      force: request.force ?? false,
      app_version: request.app_version ?? null,
      current_backend: current,
      proxy: request.proxy ?? null,
    })
    const base = { provider: this.provider, current, current_kind: kind }
    const none = (same_family: boolean): BackendUpdateCheckResponse => ({
      ...base,
      update_needed: false,
      new_version: '0',
      target_backend: null,
      same_family,
      offer: null,
    })

    if (kind === 'missing') return none(false)
    if (kind === 'sentinel') {
      const id = current.slice('latest/'.length).trim()
      const target = this.policy.resolveSentinel(id, catalog.available)
      if (!target) return none(true)
      return {
        ...base,
        update_needed: true,
        new_version: target.split('/')[0] ?? '',
        target_backend: target,
        same_family: true,
        offer: this.policy.acceptsUpdateTarget(target) ? target : null,
      }
    }

    if (catalog.available.length === 0) return none(false)
    let result
    try {
      result = this.policy.checkUpdates(current, catalog.available)
    } catch (err) {
      this.log('warn', `checkUpdates: ${err instanceof Error ? err.message : String(err)}`)
      return none(false)
    }
    const target = result.target_backend
    if (!result.update_needed || !target) return { ...base, ...result, same_family: false, offer: null }
    const currentType = current.split('/')[1]?.trim() ?? ''
    const targetType = target.split('/')[1]?.trim() ?? ''
    const sameFamily = !!targetType && this.policy.sameFamily(currentType, targetType)
    if (!sameFamily) {
      this.log('warn', `checkUpdates: refusing to switch backend type ${currentType} -> ${targetType}`)
    }
    return {
      ...base,
      ...result,
      same_family: sameFamily,
      offer: sameFamily && this.policy.acceptsUpdateTarget(target) ? target : null,
    }
  }

  // -------------------------------------------------------------------------------------------
  // seams
  // -------------------------------------------------------------------------------------------

  private async currentVersionBackend(): Promise<string> {
    return (await this.deps.currentVersionBackend()) ?? ''
  }

  private async installed(): Promise<BackendVersion[]> {
    try {
      return this.deps.installed
        ? await this.deps.installed()
        : await scanInstalledBackends(this.deps.layout, this.provider, this.deps.platform ?? process.platform)
    } catch (err) {
      this.log('warn', `catalog: installed scan failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  }

  private async rocmFacts(osType: string): Promise<RocmHostProbe | undefined> {
    if (this.provider !== 'llamacpp' || osType !== 'linux') return undefined
    try {
      return await (this.deps.rocmProbe ?? probeLinuxRocmHost)()
    } catch (err) {
      this.log('warn', `catalog: ROCm probe failed: ${err instanceof Error ? err.message : String(err)}`)
      return undefined
    }
  }

  private async rocmInput(osType: string): Promise<{ rocm?: RocmHostProbe }> {
    const rocm = await this.rocmFacts(osType)
    return rocm ? { rocm } : {}
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private log(level: 'info' | 'warn', message: string): void {
    this.deps.log?.(level, message)
  }
}

/** `missing` for nothing usable (`''`, `none`, no slash), `sentinel` for `latest/<id>`, else `concrete`. */
export function classifyCurrent(current: string): BackendCurrentKind {
  const value = stripBom(current).trim()
  if (!value || value === 'none' || !value.includes('/')) return 'missing'
  if (value.startsWith('latest/')) return 'sentinel'
  return 'concrete'
}

/**
 * The outcome vocabulary applied to a refresh record: `cpu_optimal`, `already_optimal` when the
 * concrete target is the current build, `no_catalog_entry` when none resolved, else `recommend`
 * (a refresh never emits; the record is what the app reads).
 */
export function refreshOutcome(
  record: OptimalBackendCacheRecord | null,
  current: string
): BackendRecommendationOutcome {
  if (!record || record.detectionKind === 'cpu-optimal') return 'cpu_optimal'
  if (!record.recommendedBackend) return 'no_catalog_entry'
  return record.recommendedBackend === current ? 'already_optimal' : 'recommend'
}

/** The event payload a `gpu` record with a concrete target other than the current build describes. */
export function recommendationOf(
  record: OptimalBackendCacheRecord | null,
  provider: LlamacppProviderId
): BackendRecommendation | null {
  if (!record || record.detectionKind !== 'gpu' || !record.recommendedBackend) return null
  if (record.recommendedBackend === record.currentBackend) return null
  const [version, backendId] = record.recommendedBackend.split('/')
  return {
    currentBackend: record.currentBackend,
    recommendedBackend: record.recommendedBackend,
    recommendedCategory: record.recommendedCategory,
    provider,
    version: version ?? '',
    backendId: backendId ?? '',
  }
}

function toCatalogRelease(release: TurboquantRelease): BackendCatalogRelease {
  return {
    tag: release.tag,
    ...(release.title !== undefined ? { title: release.title } : {}),
    ...(release.highlights !== undefined ? { highlights: release.highlights } : {}),
    ...(release.min_app_version !== undefined ? { min_app_version: release.min_app_version } : {}),
    variants: release.variants.map((v) => ({
      id: v.id,
      ...(v.asset !== undefined ? { asset: v.asset } : {}),
      ...(v.size !== undefined ? { size: v.size } : {}),
    })),
  }
}
