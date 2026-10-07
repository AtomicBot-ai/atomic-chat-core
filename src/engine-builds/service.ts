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
 *             [under the engine's load lock] activate → retire the other downloaded builds
 *
 * sd.cpp walks down the host's ladder when a build unpacks but fails its probe (design D7): the pair
 * is remembered in `<data>/diffusion/failed-backends.json` and the next build is installed under the
 * same task id; only the last build's failure reaches the client.
 */

import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
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
import { listInstalledBackends, prepareSdcppTree, writeInstallRecord } from '../diffusion/install.js'
import type { Downloader } from '../downloads/index.js'
import type { HardwareFacts } from '../hardware/index.js'
import {
  listDownloadedMlx,
  MLX_SERVER_BINARY,
  probeMlxServer,
  readBundledMlx,
  removeOwnedBuild,
  writeMlxInstallRecord,
} from './builds.js'
import type { BundledMlx } from './builds.js'
import { installStaged } from './install.js'
import type { BuildArchive } from './install.js'
import { assetInstallable, mlxAssetUrl, sdcppAssetUrl } from './manifest.js'
import type { ManifestRead, MlxManifest, SdcppManifest } from './manifest.js'
import { compareBuilds } from './order.js'
import {
  backendKindOf,
  companionFor,
  mlxHostChoice,
  readFailedBackends,
  rememberFailedBackend,
  sdcppHostChoice,
  sdcppHostOf,
} from './select.js'

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

/** One build on disk as this module sees it. */
interface Build extends EngineBuildRef {
  /** For a bundled MLX build, `resources-dir`; otherwise the build's own directory. */
  dir: string
  installed_at_ms: number | null
  published_at: string | null
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
    'sd-cpp': {
      read(options?: { force?: boolean; proxy?: ProxyConfig | null }): Promise<ManifestRead<SdcppManifest>>
    }
    'mlx': {
      read(options?: { force?: boolean; proxy?: ProxyConfig | null }): Promise<ManifestRead<MlxManifest>>
    }
  }
  hardware: () => Promise<Pick<HardwareFacts, 'osType' | 'arch' | 'cpuExtensions' | 'gpus'>>
  hosts: Record<EngineBuildId, EngineHost>
  availableSpace: (path: string) => Promise<number | undefined>
  emit: (name: 'engine-build:changed', payload: CoreEvents['engine-build:changed']) => void
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
  if (raw === 'sd-cpp' || raw === 'mlx') return raw
  throw new AtomicCoreError('INVALID_ARGUMENT', `Engine builds exist for sd-cpp and mlx, not ${raw}.`)
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
    const manifestTag = read.manifest?.tag_name
    const manifest: EngineBuildManifestInfo | null =
      read.manifest && manifestTag !== undefined && read.source && read.fetched_at !== null
        ? {
            tag: manifestTag,
            ...('published_at' in read.manifest ? { published_at: read.manifest.published_at } : {}),
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
    const candidate = { tag: read.manifest.tag_name, published_at: publishedAt(read.manifest) }
    if (compareBuilds(engine, candidate, active) <= 0) return { update_needed: false, current, target: null }
    const archives = this.archivesFor(engine, read.manifest, choice.backend_id)
    return {
      update_needed: true,
      current,
      target: {
        tag: read.manifest.tag_name,
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
    const tag = manifest.tag_name
    const target = { tag, published_at: publishedAt(manifest) }
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
        if (engine !== 'sd-cpp' || last || !probeFailed) throw error
        await rememberFailedBackend(this.deps.failedBackendsFile, tag, backendId)
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
    manifest: SdcppManifest | MlxManifest,
    backendId: string,
    request: EngineBuildInstallRequest,
    onProbeFailure: (error: unknown) => never
  ): Promise<Omit<EngineBuildInstallResult, 'failed_backend_ids'>> {
    const tag = manifest.tag_name
    const archives = this.archivesFor(engine, manifest, backendId)
    const unpinned = archives.find((archive) => !assetInstallable(archive))
    if (unpinned)
      throw new AtomicCoreError(
        'ENGINE_INSTALL_FAILED',
        'The manifest does not pin this build with a sha256 and a size; it is not installed.',
        `${tag}/${unpinned.name}`
      )
    const dir = join(this.deps.roots[engine], tag, backendId)
    const sha256 = archives[0]?.sha256 ?? null
    const probe =
      this.deps.probe?.[engine] ??
      (engine === 'sd-cpp'
        ? (staging: string) =>
            prepareSdcppTree(staging, {
              platform: this.deps.platform,
              ...(this.deps.log ? { log: this.deps.log } : {}),
            })
        : (staging: string) => probeMlxServer(staging, { platform: this.deps.platform }))
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
        engine === 'sd-cpp'
          ? writeInstallRecord(staging, {
              tag,
              backendId,
              backend: backendKindOf(backendId),
              engine: 'sd-cpp',
              sha256,
              installedAtMs: this.now(),
              dir: staging,
            })
          : writeMlxInstallRecord(staging, {
              tag,
              backendId,
              sha256,
              installedAtMs: this.now(),
              publishedAt: publishedAt(manifest),
            }),
    })
    const build: EngineBuildRef = { tag, backend_id: backendId, origin: 'downloaded' }
    const { retired, kept } = await this.activateAndRetire(engine, dir, replaced)
    this.deps.emit('engine-build:changed', { engine, reason: 'install' })
    return { installed: true, build, retired, kept_in_use: kept }
  }

  /**
   * Under the engine's load lock: make the new build active, then remove every other downloaded
   * build no session runs from. The bundled build is never touched.
   */
  private activateAndRetire(
    engine: EngineBuildId,
    dir: string,
    replaced: boolean
  ): Promise<{ retired: EngineBuildRef[]; kept: EngineBuildRef[] }> {
    const host = this.deps.hosts[engine]
    return host.exclusive(async () => {
      await host.activate(dir, replaced)
      const inUse = await host.inUse()
      const retired: EngineBuildRef[] = []
      const kept: EngineBuildRef[] = []
      for (const build of await this.builds(engine)) {
        if (build.origin !== 'downloaded' || (await samePath(build.dir, dir, this.deps.platform))) continue
        if (await this.isUsed(build, inUse)) {
          kept.push(ref(build))
          continue
        }
        try {
          await removeOwnedBuild(this.deps.roots[engine], build.dir, this.deps.platform)
          retired.push(ref(build))
        } catch (error) {
          this.deps.log?.('warn', `Could not retire ${build.tag}/${build.backend_id}: ${String(error)}`)
        }
      }
      return { retired, kept }
    })
  }

  // --- removal ---------------------------------------------------------------------------------

  /** Only a downloaded, marked build; under the engine's load lock, so it never races a load. */
  async remove(engine: EngineBuildId, tag: string, backendId: string): Promise<EngineBuildRemoveResult> {
    const host = this.deps.hosts[engine]
    const removed = await host.exclusive(async () => {
      const builds = await this.builds(engine)
      const bundled = builds.find(
        (build) => build.origin === 'bundled' && build.tag === tag && build.backend_id === backendId
      )
      if (bundled)
        throw new AtomicCoreError('INVALID_REQUEST', 'The build that ships with the app cannot be removed.')
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
      this.deps.emit('engine-build:changed', { engine, reason: 'uninstall' })
    }
    return { removed }
  }

  // --- start -----------------------------------------------------------------------------------

  /**
   * Before the first load (design D3, D5): every downloaded build that is not the active one goes —
   * the ones a session kept on the last install, and for MLX the downloads no newer than the build
   * the installer brought (an app update that ships a newer `mlx-server`). Leftovers of an install
   * the process did not live to finish (`*.incoming-*`, `*.retired-*`) go too. Under each engine's
   * load lock; nothing runs yet, so nothing is in use. One `startup-cleanup` per engine that lost a
   * build.
   */
  async startupCleanup(): Promise<void> {
    for (const engine of ['sd-cpp', 'mlx'] as const) {
      const removed = await this.deps.hosts[engine]
        .exclusive(async () => {
          // Leftovers of an interrupted install were never a build: they change nothing a client sees.
          await this.removeLeftovers(engine)
          let count = 0
          const builds = await this.builds(engine)
          const active = this.activeOf(engine, builds)
          const inUse = await this.deps.hosts[engine].inUse()
          for (const build of builds) {
            if (build.origin !== 'downloaded' || build === active || (await this.isUsed(build, inUse)))
              continue
            try {
              if (await removeOwnedBuild(this.deps.roots[engine], build.dir, this.deps.platform)) count++
            } catch (error) {
              this.deps.log?.(
                'warn',
                `Could not remove ${build.tag}/${build.backend_id} at start: ${String(error)}`
              )
            }
          }
          return count
        })
        .catch((error: unknown) => {
          this.deps.log?.('warn', `The ${engine} startup cleanup failed: ${String(error)}`)
          return 0
        })
      if (removed > 0) {
        await this.deps.hosts[engine].changed?.('startup-cleanup')
        this.deps.emit('engine-build:changed', { engine, reason: 'startup-cleanup' })
      }
    }
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

  private async builds(engine: EngineBuildId): Promise<Build[]> {
    if (engine === 'sd-cpp')
      return (await listInstalledBackends(this.deps.roots['sd-cpp'], this.deps.platform))
        .filter((record) => record.engine === 'sd-cpp')
        .map((record) => ({
          tag: record.tag,
          backend_id: record.backendId,
          origin: 'downloaded',
          dir: record.dir,
          installed_at_ms: record.installedAtMs,
          published_at: null,
        }))
    const out: Build[] = (await listDownloadedMlx(this.deps.roots.mlx)).map((record) => ({
      tag: record.tag,
      backend_id: record.backendId,
      origin: 'downloaded',
      dir: record.dir,
      installed_at_ms: record.installedAtMs,
      published_at: record.publishedAt,
    }))
    const bundled = await readBundledMlx(this.deps.resourcesDir)
    if (bundled) out.unshift(bundledBuild(bundled, this.deps.resourcesDir as string))
    return out
  }

  /**
   * sd.cpp: the newest install, which `selectModelInstall` hands the next load. MLX: the newest
   * build by `published_at`, the bundled one on a tie (spec "Две точки происхождения mlx-server").
   */
  private activeOf(engine: EngineBuildId, builds: Build[]): Build | undefined {
    if (engine === 'sd-cpp') return builds[0]
    let best: Build | undefined
    for (const build of builds) if (!best || compareBuilds('mlx', build, best) > 0) best = build
    return best
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
  ): Promise<ManifestRead<SdcppManifest> | ManifestRead<MlxManifest>> {
    const options = {
      ...(request.force ? { force: true } : {}),
      ...(request.proxy ? { proxy: request.proxy } : {}),
    }
    return engine === 'sd-cpp'
      ? this.deps.manifests['sd-cpp'].read(options)
      : this.deps.manifests.mlx.read(options)
  }

  private async hostChoice(
    engine: EngineBuildId,
    manifest: SdcppManifest | MlxManifest | null
  ): Promise<{ ladder: string[]; backend_id: string | null; reason: string | null }> {
    const facts = await this.deps.hardware()
    const host = sdcppHostOf(facts)
    if (engine === 'mlx') {
      const choice = mlxHostChoice(host, manifest)
      return { ...choice, ladder: choice.backend_id ? [choice.backend_id] : [] }
    }
    if (!manifest) return { ladder: [], backend_id: null, reason: 'The sd.cpp manifest is unavailable.' }
    return sdcppHostChoice(host, manifest, await readFailedBackends(this.deps.failedBackendsFile))
  }

  private archivesFor(
    engine: EngineBuildId,
    manifest: SdcppManifest | MlxManifest,
    backendId: string
  ): Array<Omit<BuildArchive, 'sha256' | 'size'> & { sha256?: string; size?: number }> {
    if (engine === 'mlx') {
      const mlx = manifest as MlxManifest
      return mlx.assets
        .filter((asset) => asset.backend === backendId)
        .map((asset) => ({ ...pin(asset), url: mlxAssetUrl(mlx, asset), name: asset.name }))
    }
    const sd = manifest as SdcppManifest
    const ids = [backendId, companionFor(backendId)]
    return ids.flatMap((id) => {
      const asset = sd.assets.find((candidate) => candidate.backend === id)
      return asset ? [{ ...pin(asset), url: sdcppAssetUrl(sd, asset), name: asset.name }] : []
    })
  }
}

const pin = (asset: { sha256?: string; size?: number }) => ({
  ...(asset.sha256 !== undefined ? { sha256: asset.sha256 } : {}),
  ...(asset.size !== undefined ? { size: asset.size } : {}),
})

function publishedAt(manifest: SdcppManifest | MlxManifest): string | null {
  return 'published_at' in manifest ? manifest.published_at : null
}

function bundledBuild(bundled: BundledMlx, resourcesDir: string): Build {
  return {
    tag: bundled.tag ?? 'bundled',
    backend_id: 'macos-arm64',
    origin: 'bundled',
    dir: resourcesDir,
    installed_at_ms: null,
    published_at: bundled.published_at,
  }
}
