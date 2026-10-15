/**
 * Engine builds of sd.cpp and MLX: the catalog, the update check, the install, the removal and the
 * cleanup at start (openspec change `move-sdcpp-mlx-install-to-core`, spec `engine-builds`).
 *
 * The core advises and the client decides (ADR 2026-09-27): the catalog and the update check only
 * read; an install happens when a client calls it, and that call is also the client's consent to
 * unload whatever runs from another build of the engine.
 *
 * What a build is to each engine's runtime — which lock keeps loads off it, which directories its
 * sessions run from, what "activating" a build means — is an `EngineHost` the runtime provides;
 * this module only orders the steps:
 *
 *   install = (per-engine lock) → manifest → host build → refuse a downgrade → staged install →
 *             [under the engine's load lock] activate
 *
 * No install deletes another build, and neither does the start (change `unify-engine-lifecycle`, a
 * decision during its acceptance): the old ones stay listed, inactive, for the user to remove. The
 * `retired` and `kept_in_use` of an install answer are therefore always empty.
 *
 * sd.cpp walks down the host's ladder when a build unpacks but fails its probe (design D7): the pair
 * is remembered in `<data>/diffusion/failed-backends.json` and the next build is installed under the
 * same task id; only the last build's failure reaches the client.
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError, ENGINE_BUILD_IDS } from '../contracts/index.js'
import type {
  CoreEvents,
  EngineBuildCatalog,
  EngineBuildCatalogRequest,
  EngineBuildId,
  EngineBuildInstallRequest,
  EngineBuildInstallResult,
  EngineBuildManifestInfo,
  EngineBuildRef,
  EngineBuildRemoveResult,
  EngineBuildUpdateCheck,
  InstalledEngineBuild,
  ProxyConfig,
} from '../contracts/index.js'
import { samePath } from '../diffusion/containment.js'
import type { Downloader } from '../downloads/index.js'
import type { HardwareFacts } from '../hardware/index.js'
import { MLX_SERVER_BINARY, removeOwnedBuild } from './builds.js'
import { ENGINE_DESCRIPTORS } from './engines.js'
import type { Build, EngineContext, EngineDescriptor, HostChoice } from './engines.js'
import { installStaged } from './install.js'
import type { BuildArchive } from './install.js'
import { assetInstallable } from './manifest.js'
import type { ManifestOf, ManifestRead } from './manifest.js'
import { compareBuilds } from './order.js'

/** Any engine's manifest, where the service handles them alike. */
type AnyManifest = ManifestOf[EngineBuildId]

/** What an engine's runtime lends this module. */
export interface EngineHost {
  /** Run `fn` with this engine's model loads held off (sd.cpp's `loadLock`, MLX's load queue). */
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  /** The build directories sessions of this engine run from right now. */
  inUse(): Promise<string[]>
  /**
   * The build at `dir` is now the one the next load uses: unload what runs from any other build.
   * `replaced` — the same directory was swapped for a fresh tree (a forced reinstall). Called inside
   * `exclusive`.
   */
  activate(dir: string, replaced: boolean): Promise<void>
  /** A build went without an install: `uninstall` or `startup-cleanup`. sd.cpp re-reports its state. */
  changed?(reason: 'uninstall' | 'startup-cleanup'): Promise<void>
}

/** The host of an engine with no runtime in this core (MLX off macOS): nothing runs, so nothing to hold. */
export const IDLE_ENGINE_HOST: EngineHost = {
  exclusive: (fn) => fn(),
  inUse: async () => [],
  activate: async () => {},
}

export interface EngineBuildsDeps {
  dataFolder: string
  /** `<data>/diffusion/backends` and `<data>/mlx/backends`. */
  roots: Record<EngineBuildId, string>
  /** `<data>/diffusion/failed-backends.json`. */
  failedBackendsFile: string
  /** The desktop app's `resources/bin`; absent on `atc`. */
  resourcesDir?: string | undefined
  platform: NodeJS.Platform
  downloader: Pick<Downloader, 'download'>
  manifests: {
    [K in EngineBuildId]: {
      read(options?: { force?: boolean; proxy?: ProxyConfig | null }): Promise<ManifestRead<ManifestOf[K]>>
    }
  }
  hardware: () => Promise<Pick<HardwareFacts, 'osType' | 'arch' | 'cpuExtensions' | 'gpus'>>
  hosts: Record<EngineBuildId, EngineHost>
  availableSpace: (path: string) => Promise<number | undefined>
  /**
   * `engine-build:changed`, and the same change as `engine:changed` (change `unify-engine-lifecycle`,
   * design D8): the desktop releases out there listen to the first, this change's to the second.
   */
  emit: <K extends 'engine-build:changed' | 'engine:changed'>(name: K, payload: CoreEvents[K]) => void
  now?: () => number
  log?: (level: 'info' | 'warn', message: string) => void
  /** Test seams for the two probes. */
  probe?: Partial<Record<EngineBuildId, (dir: string) => Promise<void>>>
}

const sameRef = (a: EngineBuildRef, b: EngineBuildRef): boolean =>
  a.tag === b.tag && a.backend_id === b.backend_id && a.origin === b.origin

const ref = (build: Build): EngineBuildRef => ({
  tag: build.tag,
  backend_id: build.backend_id,
  origin: build.origin,
})

export function parseEngineBuildId(raw: string): EngineBuildId {
  const known = ENGINE_BUILD_IDS.find((id) => id === raw)
  if (known) return known
  const names = `${ENGINE_BUILD_IDS.slice(0, -1).join(', ')} and ${ENGINE_BUILD_IDS.at(-1)}`
  throw new AtomicCoreError('INVALID_ARGUMENT', `Engine builds exist for ${names}, not ${raw}.`)
}

export class EngineBuildsService {
  private readonly installing = new Set<EngineBuildId>()
  private readonly now: () => number

  constructor(private readonly deps: EngineBuildsDeps) {
    this.now = deps.now ?? Date.now
  }

  // --- reading ---------------------------------------------------------------------------------

  async catalog(engine: EngineBuildId, request: EngineBuildCatalogRequest = {}): Promise<EngineBuildCatalog> {
    const read = await this.readManifest(engine, request)
    const choice = await this.hostChoice(engine, read.manifest)
    const builds = await this.builds(engine)
    const active = this.activeOf(engine, builds)
    const inUse = await this.deps.hosts[engine].inUse()
    const installed: InstalledEngineBuild[] = []
    for (const build of builds) installed.push(await this.describe(build, active, inUse))
    const release = read.manifest ? this.engine(engine).release(read.manifest) : null
    const manifest: EngineBuildManifestInfo | null =
      release && read.source && read.fetched_at !== null
        ? {
            tag: release.tag,
            ...(release.published_at !== null ? { published_at: release.published_at } : {}),
            source: read.source,
            fetched_at: read.fetched_at,
            error: read.error,
          }
        : null
    return {
      engine,
      manifest,
      manifest_error: manifest ? null : read.error,
      host_backend_id: choice.backend_id,
      host_reason: choice.reason,
      installed,
      active: installed.find((build) => build.active) ?? null,
    }
  }

  async checkUpdates(
    engine: EngineBuildId,
    request: EngineBuildCatalogRequest = {}
  ): Promise<EngineBuildUpdateCheck> {
    const read = await this.readManifest(engine, request)
    const active = this.activeOf(engine, await this.builds(engine))
    const current = active ? ref(active) : null
    const choice = await this.hostChoice(engine, read.manifest)
    if (!active || !read.manifest || !choice.backend_id)
      return { update_needed: false, current, target: null }
    const candidate = this.engine(engine).release(read.manifest)
    if (compareBuilds(engine, candidate, active) <= 0) return { update_needed: false, current, target: null }
    const archives = this.engine(engine).archives(read.manifest, choice.backend_id)
    return {
      update_needed: true,
      current,
      target: {
        tag: candidate.tag,
        backend_id: choice.backend_id,
        ...(candidate.published_at ? { published_at: candidate.published_at } : {}),
        download_bytes: archives.reduce((sum, archive) => sum + (archive.size ?? 0), 0),
      },
    }
  }

  // --- install ---------------------------------------------------------------------------------

  async install(
    engine: EngineBuildId,
    request: EngineBuildInstallRequest
  ): Promise<EngineBuildInstallResult> {
    if (this.installing.has(engine))
      throw new AtomicCoreError(
        'ENGINE_INSTALL_IN_PROGRESS',
        `The ${engine} engine is already being installed; wait for that install to finish.`
      )
    this.installing.add(engine)
    try {
      return await this.installLocked(engine, request)
    } finally {
      this.installing.delete(engine)
    }
  }

  private async installLocked(
    engine: EngineBuildId,
    request: EngineBuildInstallRequest
  ): Promise<EngineBuildInstallResult> {
    const read = await this.readManifest(engine, { proxy: request.proxy ?? null })
    const manifest = read.manifest
    if (!manifest)
      throw new AtomicCoreError(
        'UPSTREAM_ERROR',
        `The ${engine} manifest is unavailable; nothing was downloaded.`,
        read.error ?? undefined
      )
    const choice = await this.hostChoice(engine, manifest)
    if (!choice.backend_id)
      throw new AtomicCoreError(
        'UNSUPPORTED_BACKEND',
        choice.reason ?? 'No build of this engine fits this computer.'
      )
    const target = this.engine(engine).release(manifest)
    const tag = target.tag
    const top: EngineBuildRef = { tag, backend_id: choice.backend_id, origin: 'downloaded' }

    const builds = await this.builds(engine)
    const active = this.activeOf(engine, builds)
    // The core never moves an engine back, `force` or not: a manifest rolled back to an older tag
    // must not replace a newer build (spec "Установка сборки").
    if (active && compareBuilds(engine, active, target) > 0)
      return { installed: false, reason: 'active-is-newer', build: top, retired: [], kept_in_use: [] }
    const present = builds.find(
      (build) => build.tag === tag && build.backend_id === choice.backend_id && build.origin === 'downloaded'
    )
    // A bundled MLX build of the manifest's tag, or one as recent, is that build already: on a tie the
    // installer's build runs, so a copy would never be started (and startup cleanup would delete it).
    const bundledSame = builds.some(
      (build) =>
        build.origin === 'bundled' && (build.tag === tag || compareBuilds(engine, build, target) === 0)
    )
    if ((present && !request.force) || bundledSame)
      return {
        installed: false,
        reason: 'already-installed',
        build: bundledSame ? { ...top, origin: 'bundled' } : top,
        retired: [],
        kept_in_use: [],
      }

    const rememberFailedRung = this.engine(engine).rememberFailedRung
    const failed: string[] = []
    for (const [index, backendId] of choice.ladder.entries()) {
      const last = index === choice.ladder.length - 1
      let probeFailed = false
      try {
        const outcome = await this.installOne(engine, manifest, backendId, request, (e) => {
          probeFailed = true
          throw e
        })
        return { ...outcome, ...(failed.length > 0 ? { failed_backend_ids: failed } : {}) }
      } catch (error) {
        if (!rememberFailedRung || last || !probeFailed) throw error
        await rememberFailedRung(this.context(engine), tag, backendId)
        failed.push(backendId)
        this.deps.log?.(
          'warn',
          `${tag}/${backendId} does not run on this machine (${error instanceof Error ? error.message : String(error)}); trying ${choice.ladder[index + 1]}`
        )
      }
    }
    // The ladder is never empty when a backend was chosen.
    throw new AtomicCoreError('INTERNAL_ERROR', 'The install ladder was empty.')
  }

  private async installOne(
    engine: EngineBuildId,
    manifest: AnyManifest,
    backendId: string,
    request: EngineBuildInstallRequest,
    onProbeFailure: (error: unknown) => never
  ): Promise<Omit<EngineBuildInstallResult, 'failed_backend_ids'>> {
    const descriptor = this.engine(engine)
    const { tag, published_at: publishedAt } = descriptor.release(manifest)
    const archives = descriptor.archives(manifest, backendId)
    const unpinned = archives.find((archive) => !assetInstallable(archive))
    if (unpinned)
      throw new AtomicCoreError(
        'ENGINE_INSTALL_FAILED',
        'The manifest does not pin this build with a sha256 and a size; it is not installed.',
        `${tag}/${unpinned.name}`
      )
    const dir = join(this.deps.roots[engine], tag, backendId)
    const sha256 = archives[0]?.sha256 ?? null
    const context = this.context(engine)
    const probe = this.deps.probe?.[engine] ?? ((staging: string) => descriptor.probe(staging, context))
    const { replaced } = await installStaged({
      dataFolder: this.deps.dataFolder,
      target: dir,
      archives: archives as BuildArchive[],
      taskId: request.task_id,
      ...(request.proxy ? { proxy: request.proxy } : {}),
      downloader: this.deps.downloader,
      availableSpace: this.deps.availableSpace,
      now: this.now,
      verify: (staging) => probe(staging).catch(onProbeFailure),
      record: (staging) =>
        descriptor.record(staging, { tag, backendId, sha256, installedAtMs: this.now(), publishedAt }),
    })
    const build: EngineBuildRef = { tag, backend_id: backendId, origin: 'downloaded' }
    const host = this.deps.hosts[engine]
    await host.exclusive(() => host.activate(dir, replaced))
    this.changed(engine, 'install')
    return { installed: true, build, retired: [], kept_in_use: [] }
  }

  private changed(engine: EngineBuildId, reason: CoreEvents['engine-build:changed']['reason']): void {
    this.deps.emit('engine-build:changed', { engine, reason })
    this.deps.emit('engine:changed', { engine, reason })
  }

  // --- removal ---------------------------------------------------------------------------------

  /**
   * Only a downloaded, marked build; under the engine's load lock, so it never races a load.
   * `refuseActive` (`DELETE /engines/…`, change `unify-engine-lifecycle`) also refuses the build the
   * next load would use, judged inside that lock; `DELETE /engine-builds/…` keeps allowing it.
   */
  async remove(
    engine: EngineBuildId,
    tag: string,
    backendId: string,
    options: { refuseActive?: boolean } = {}
  ): Promise<EngineBuildRemoveResult> {
    const host = this.deps.hosts[engine]
    const removed = await host.exclusive(async () => {
      const builds = await this.builds(engine)
      const bundled = builds.find(
        (build) => build.origin === 'bundled' && build.tag === tag && build.backend_id === backendId
      )
      if (bundled)
        throw new AtomicCoreError(
          'INVALID_REQUEST',
          'The build that ships with the app cannot be removed.',
          'bundled'
        )
      const active = this.activeOf(engine, builds)
      if (options.refuseActive && active && active.tag === tag && active.backend_id === backendId)
        throw new AtomicCoreError('INVALID_REQUEST', 'The active build cannot be removed.', 'active')
      const dir = join(this.deps.roots[engine], tag, backendId)
      const build = builds.find((candidate) => candidate.tag === tag && candidate.backend_id === backendId)
      if (build && (await this.isUsed(build, await host.inUse())))
        throw new AtomicCoreError(
          'BACKEND_IN_USE',
          'Unload the model running from this build before removing it.'
        )
      return removeOwnedBuild(this.deps.roots[engine], dir, this.deps.platform)
    })
    if (removed) {
      await this.deps.hosts[engine].changed?.('uninstall')
      this.changed(engine, 'uninstall')
    }
    return { removed }
  }

  // --- start -----------------------------------------------------------------------------------

  /**
   * Before the first load: the leftovers of an install the process did not live to finish
   * (`*.incoming-*`, `*.retired-*`). They were never a build, so no client hears of it; a build on
   * disk, active or not, always stays. Under each engine's load lock.
   */
  async startupCleanup(): Promise<void> {
    for (const engine of ENGINE_BUILD_IDS)
      await this.deps.hosts[engine]
        .exclusive(() => this.removeLeftovers(engine))
        .catch((error: unknown) => {
          this.deps.log?.('warn', `The ${engine} startup cleanup failed: ${String(error)}`)
        })
  }

  /** `<root>/<tag>/<backend>.incoming-<n>[.download]` and `.retired-<n>`: only ever this module's. */
  private async removeLeftovers(engine: EngineBuildId): Promise<void> {
    const root = this.deps.roots[engine]
    for (const tag of await readdir(root).catch(() => [] as string[]))
      for (const name of await readdir(join(root, tag)).catch(() => [] as string[]))
        if (/\.(incoming|retired)-\d+(\.download)?$/.test(name))
          await rm(join(root, tag, name), { recursive: true, force: true }).catch(() => {})
  }

  // --- what is on disk -------------------------------------------------------------------------

  /** The build the next MLX load starts: the newest of bundled and downloaded, bundled on a tie. */
  async resolveMlxBinary(): Promise<string | undefined> {
    const active = this.activeOf('mlx', await this.builds('mlx'))
    return active ? join(active.dir, MLX_SERVER_BINARY) : undefined
  }

  private builds(engine: EngineBuildId): Promise<Build[]> {
    return this.engine(engine).builds(this.context(engine))
  }

  private activeOf(engine: EngineBuildId, builds: Build[]): Build | undefined {
    return this.engine(engine).active(builds)
  }

  /** The table row of `engine`; one cast, since TypeScript cannot correlate a key with its row. */
  private engine(engine: EngineBuildId): EngineDescriptor<AnyManifest> {
    return ENGINE_DESCRIPTORS[engine] as EngineDescriptor<AnyManifest>
  }

  private context(engine: EngineBuildId): EngineContext {
    return {
      root: this.deps.roots[engine],
      failedBackendsFile: this.deps.failedBackendsFile,
      resourcesDir: this.deps.resourcesDir,
      platform: this.deps.platform,
      hardware: this.deps.hardware,
      log: this.deps.log,
    }
  }

  private async isUsed(build: Build, inUse: string[]): Promise<boolean> {
    for (const dir of inUse) if (await samePath(dir, build.dir, this.deps.platform)) return true
    return false
  }

  private async describe(
    build: Build,
    active: Build | undefined,
    inUse: string[]
  ): Promise<InstalledEngineBuild> {
    return {
      ...ref(build),
      installed_at_ms: build.installed_at_ms,
      ...(build.origin === 'bundled' || build.published_at !== null
        ? { published_at: build.published_at }
        : {}),
      removable: build.origin === 'downloaded',
      in_use: await this.isUsed(build, inUse),
      active: active !== undefined && sameRef(ref(build), ref(active)),
    }
  }

  // --- manifests and the host ------------------------------------------------------------------

  private readManifest(
    engine: EngineBuildId,
    request: EngineBuildCatalogRequest
  ): Promise<ManifestRead<AnyManifest>> {
    const options = {
      ...(request.force ? { force: true } : {}),
      ...(request.proxy ? { proxy: request.proxy } : {}),
    }
    return this.deps.manifests[engine].read(options)
  }

  private hostChoice(engine: EngineBuildId, manifest: AnyManifest | null): Promise<HostChoice> {
    return this.engine(engine).hostChoice(this.context(engine), manifest)
  }
}
