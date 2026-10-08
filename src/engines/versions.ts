/**
 * `POST /engines/versions` (change `unify-engine-lifecycle`, spec `engine-lifecycle`, "Версии всех
 * движков хоста", "Описание установленной сборки", "Предложение обновления"; design D1, D2): one entry
 * per engine of this host, each built from the system that installs it, never by merging them.
 *
 *   - llama.cpp — the backend advisor's update check and catalog, and the packs on disk;
 *   - sd.cpp, MLX — the `engine-builds` catalog and update check;
 *   - TensorRT-LLM, vLLM — the installation record and the last accepted descriptor, ordered by
 *     `descriptor-order.ts`.
 *
 * Every builder only reads: it downloads nothing but the documents that say what exists, and changes
 * no build and no setting. The entries are built in parallel, and one engine's failure is that
 * engine's `error`, so a broken TurboQuant index never hides an MLX update.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type {
  BackendCatalogRequest,
  BackendCatalogResponse,
  BackendCatalogSource,
  BackendUpdateCheckRequest,
  BackendUpdateCheckResponse,
  EngineAvailableBuild,
  EngineBuild,
  EngineBuildCatalog,
  EngineBuildCatalogRequest,
  EngineBuildId,
  EngineBuildKey,
  EngineBuildUpdateCheck,
  EngineId,
  EngineKind,
  EngineNotRemovableReason,
  EngineUpdateOffer,
  EngineVersions,
  EngineVersionsRequest,
  EngineVersionsResponse,
  EngineVersionsSource,
  ErrorBody,
  LlamacppProviderId,
  RuntimeDescriptor,
} from '../contracts/index.js'
import { backendTypeEquivalents, compareVersions } from '../backend/index.js'
import type { InstalledBackendPack } from '../backend/index.js'
import type { InstallationRecord } from '../runtime/environment/index.js'
import { isNewerDescriptor } from './descriptor-order.js'

/** Who picks the active build, and how an update applies, by the system underneath. */
const ACTIVE_CHOICE = { 'llamacpp': 'client', 'engine-build': 'core', 'managed': 'core' } as const
const APPLY = { 'llamacpp': 'swap', 'engine-build': 'swap', 'managed': 'reinstall' } as const

const keyOf = (versionBackend: string): EngineBuildKey | null => {
  const [version, variant, ...rest] = versionBackend.trim().split('/')
  if (!version || !variant || rest.length > 0 || version === 'latest' || version === 'none') return null
  return { version, variant }
}

const sameKey = (a: EngineBuildKey | null, b: EngineBuildKey): boolean =>
  a !== null && a.version === b.version && a.variant === b.variant

/** The one reason a build cannot go, in the spec's order: an active build that is busy is `active`. */
function described(
  key: EngineBuildKey,
  origin: EngineBuild['origin'],
  active: boolean,
  inUse: boolean
): EngineBuild {
  const reason: EngineNotRemovableReason | undefined = active
    ? 'active'
    : origin === 'bundled'
      ? 'bundled'
      : inUse
        ? 'in-use'
        : undefined
  return {
    ...key,
    origin,
    active,
    in_use: inUse,
    removable: reason === undefined,
    ...(reason !== undefined ? { not_removable_reason: reason } : {}),
  }
}

/** An entry for an engine whose source gave nothing at all: `error` says so, with the offer blocked. */
const noSource = (message: string): ErrorBody => ({ code: 'UPSTREAM_ERROR', message })

function offer(
  kind: EngineKind,
  active: EngineBuildKey | null,
  target: EngineAvailableBuild | null,
  blocked?: EngineUpdateOffer['blocked_reason']
): EngineUpdateOffer {
  const apply = APPLY[kind]
  // Never without an active build, and never alongside a reason not to.
  if (active === null || blocked !== undefined || target === null)
    return {
      needed: false,
      target: null,
      apply,
      ...(active !== null && blocked ? { blocked_reason: blocked } : {}),
    }
  return { needed: true, target, apply }
}

// ---------------------------------------------------------------------------------------------
// llama.cpp
// ---------------------------------------------------------------------------------------------

export interface LlamacppVersionsDeps {
  engine: LlamacppProviderId
  /** The provider's `version_backend` in the core's settings. */
  current: () => string
  checkUpdates: (request: BackendUpdateCheckRequest) => Promise<BackendUpdateCheckResponse>
  catalog: (request: BackendCatalogRequest) => Promise<BackendCatalogResponse>
  listInstalled: (current: string) => Promise<InstalledBackendPack[]>
  bundledPack: () => Promise<{ version: string; backend: string } | null>
  inUse: (version: string, backend: string) => Promise<boolean>
}

/** The advisor's catalog sources, read as fetched now, accepted before, or nothing. */
function llamacppSource(source: BackendCatalogSource): { source: EngineVersionsSource; failed: boolean } {
  switch (source) {
    case 'live':
    case 'index':
    case 'redirect':
    case 'legacy-manifest':
      return { source: 'remote', failed: false }
    // Fetched earlier in this process and kept for the session: nothing failed.
    case 'session-cache':
      return { source: 'cache', failed: false }
    case 'disk-cache':
    case 'bundled-baseline':
      return { source: 'cache', failed: true }
    case 'none':
      return { source: null, failed: true }
  }
}

function llamacppSize(
  catalog: BackendCatalogResponse,
  updates: BackendUpdateCheckResponse,
  key: EngineBuildKey
): number | undefined {
  if (updates.offer === `${key.version}/${key.variant}` && updates.download_size !== undefined)
    return updates.download_size
  return catalog.releases
    ?.find((release) => release.tag === key.version)
    ?.variants.find((v) => v.id === key.variant)?.size
}

export async function llamacppVersions(
  deps: LlamacppVersionsDeps,
  request: EngineVersionsRequest
): Promise<EngineVersions> {
  const current = deps.current().trim()
  const proxy = request.proxy ?? null
  const appVersion = request.app_version ?? null
  // The update check reads the catalog itself, with `force`; the second read is served from that.
  const updates = await deps.checkUpdates({
    current,
    force: request.force ?? false,
    app_version: appVersion,
    proxy,
  })
  const catalog = await deps.catalog({
    current_backend: current,
    force: false,
    app_version: appVersion,
    proxy,
  })
  const [packs, bundled] = await Promise.all([deps.listInstalled(current), deps.bundledPack()])
  const active = updates.current_kind === 'concrete' ? keyOf(current) : null

  const builds: EngineBuild[] = []
  for (const pack of packs) {
    const key = { version: pack.version, variant: pack.backend }
    const origin =
      bundled && bundled.version === pack.version && bundled.backend === pack.backend
        ? 'bundled'
        : 'downloaded'
    builds.push(described(key, origin, sameKey(active, key), await deps.inUse(pack.version, pack.backend)))
  }

  const sized = (key: EngineBuildKey | null): EngineAvailableBuild | null => {
    if (key === null) return null
    const size = llamacppSize(catalog, updates, key)
    return { ...key, ...(size !== undefined ? { download_bytes: size } : {}) }
  }
  const { source, failed } = llamacppSource(catalog.source)
  const target = updates.offer ? sized(keyOf(updates.offer)) : null
  // The newest build of the active one's type; without an active build, what the advisor recommends.
  const sameType = active
    ? catalog.available.find((entry) => backendTypeEquivalents(active.variant).has(entry.backend))
    : undefined
  const latest =
    target ??
    sized(
      sameType ? { version: sameType.version, variant: sameType.backend } : keyOf(catalog.recommended ?? '')
    )

  const newer = updates.update_needed && updates.target_backend !== null
  const blocked =
    source === null
      ? 'source-unavailable'
      : newer && !updates.same_family
        ? 'family-change'
        : newer && !updates.offer && deps.engine === 'llamacpp'
          ? 'unstable'
          : undefined
  const sourceError = failed
    ? source === null
      ? `No ${deps.engine} release source answered and nothing was accepted before.`
      : `The ${deps.engine} release source was not reachable; the builds offered are the ones accepted before.`
    : null
  return {
    engine: deps.engine,
    kind: 'llamacpp',
    active_choice: ACTIVE_CHOICE.llamacpp,
    builds,
    active,
    latest: source === null ? null : latest,
    update: offer('llamacpp', active, blocked ? null : target, blocked),
    source,
    source_error: sourceError,
    error: source === null ? noSource(sourceError as string) : null,
  }
}

// ---------------------------------------------------------------------------------------------
// sd.cpp and MLX
// ---------------------------------------------------------------------------------------------

export interface EngineBuildVersionsDeps {
  engine: EngineBuildId
  catalog: (request: EngineBuildCatalogRequest) => Promise<EngineBuildCatalog>
  checkUpdates: (request: EngineBuildCatalogRequest) => Promise<EngineBuildUpdateCheck>
}

export async function engineBuildVersions(
  deps: EngineBuildVersionsDeps,
  request: EngineVersionsRequest
): Promise<EngineVersions> {
  const proxy = request.proxy ?? null
  const catalog = await deps.catalog({ force: request.force ?? false, proxy })
  const check = await deps.checkUpdates({ proxy })
  const active = catalog.active ? { version: catalog.active.tag, variant: catalog.active.backend_id } : null
  const builds = catalog.installed.map((build) =>
    described({ version: build.tag, variant: build.backend_id }, build.origin, build.active, build.in_use)
  )
  const target: EngineAvailableBuild | null =
    check.update_needed && check.target
      ? {
          version: check.target.tag,
          variant: check.target.backend_id,
          ...(check.target.published_at !== undefined ? { published_at: check.target.published_at } : {}),
          download_bytes: check.target.download_bytes,
        }
      : null
  const manifest = catalog.manifest
  const latest: EngineAvailableBuild | null =
    target ??
    (manifest && catalog.host_backend_id
      ? {
          version: manifest.tag,
          variant: catalog.host_backend_id,
          ...(manifest.published_at !== undefined ? { published_at: manifest.published_at } : {}),
        }
      : null)
  const source = manifest?.source ?? null
  const sourceError = manifest
    ? manifest.error
    : (catalog.manifest_error ?? `The ${deps.engine} manifest is unavailable.`)
  return {
    engine: deps.engine,
    kind: 'engine-build',
    active_choice: ACTIVE_CHOICE['engine-build'],
    builds,
    active,
    latest,
    update: offer('engine-build', active, target, source === null ? 'source-unavailable' : undefined),
    source,
    source_error: sourceError,
    error: source === null ? noSource(sourceError ?? '') : null,
  }
}

// ---------------------------------------------------------------------------------------------
// TensorRT-LLM and vLLM
// ---------------------------------------------------------------------------------------------

/** What a fresh setup would use now: the descriptor just fetched, the last one accepted, or neither. */
export type LatestDescriptor =
  | { kind: 'available'; descriptor: RuntimeDescriptor; source: 'remote' | 'cache' }
  | { kind: 'unavailable'; error: AtomicCoreError }

export interface ManagedVersionsDeps {
  engine: EngineId
  /** The engine's installation in this user's environment, or `null` when it is not installed. */
  installation: () => Promise<InstallationRecord | null>
  latest: () => Promise<LatestDescriptor>
  /** A model of this engine is resident. */
  inUse: () => boolean
  /** The image platform a setup on this host pulls. */
  platform: 'linux/amd64' | 'linux/arm64'
}

export async function managedVersions(
  deps: ManagedVersionsDeps,
  request: EngineVersionsRequest
): Promise<EngineVersions> {
  const [record, latestRead] = await Promise.all([deps.installation(), deps.latest()])
  const installedId = record?.installation.active_descriptor_id ?? null
  const active = record && installedId ? { version: installedId, variant: record.platform } : null
  // The one installation is what a removal takes: the engine as a whole, so it is always removable.
  const builds: EngineBuild[] = active
    ? [{ ...active, origin: 'managed', active: true, in_use: deps.inUse(), removable: true }]
    : []

  if (latestRead.kind === 'unavailable')
    return {
      engine: deps.engine,
      kind: 'managed',
      active_choice: ACTIVE_CHOICE.managed,
      builds,
      active,
      latest: null,
      update: offer('managed', active, null, 'source-unavailable'),
      source: null,
      source_error: latestRead.error.message,
      error: latestRead.error.toJSON(),
    }

  const { descriptor } = latestRead
  const latest: EngineAvailableBuild = {
    version: descriptor.descriptor_id,
    variant: deps.platform,
    download_bytes: descriptor.download_bytes,
  }
  const newer = installedId !== null && isNewerDescriptor(deps.engine, descriptor.descriptor_id, installedId)
  const appVersion = request.app_version ?? null
  // Without the client's version there is nothing to compare; `atc` has no app to update.
  const tooOld = appVersion !== null && compareVersions(appVersion, descriptor.minimum_app_version) < 0
  return {
    engine: deps.engine,
    kind: 'managed',
    active_choice: ACTIVE_CHOICE.managed,
    builds,
    active,
    latest,
    update: offer(
      'managed',
      active,
      newer ? latest : null,
      newer && tooOld ? 'requires-newer-app' : undefined
    ),
    source: latestRead.source,
    source_error: null,
    error: null,
  }
}

// ---------------------------------------------------------------------------------------------
// Every engine
// ---------------------------------------------------------------------------------------------

export interface EngineVersionsReader {
  engine: EngineId
  kind: EngineKind
  read: () => Promise<EngineVersions>
}

/** All entries at once, in the order given; a reader that throws becomes its engine's `error`. */
export async function collectEngineVersions(
  readers: readonly EngineVersionsReader[]
): Promise<EngineVersionsResponse> {
  const engines = await Promise.all(
    readers.map(async (reader): Promise<EngineVersions> => {
      try {
        return await reader.read()
      } catch (error) {
        const body: ErrorBody =
          error instanceof AtomicCoreError
            ? error.toJSON()
            : { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) }
        return {
          engine: reader.engine,
          kind: reader.kind,
          active_choice: ACTIVE_CHOICE[reader.kind],
          builds: [],
          active: null,
          latest: null,
          update: { needed: false, target: null, apply: APPLY[reader.kind] },
          source: null,
          source_error: null,
          error: body,
        }
      }
    })
  )
  return { engines }
}
