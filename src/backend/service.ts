/**
 * Installing and updating llama.cpp backends (PLAN.md §4, stage 3c).
 *
 * The pieces this composes already existed — the manifest reader, the archive URL builder, the
 * downloader, the extractor, the installed-pack scanner. What was missing is the thing that puts
 * them in order and gives the result the names the app's "Backend updater" screen already calls.
 *
 * Two properties it owes the UI.
 *
 * *One task id per install, and it is the download's.* The app's progress bar listens on an event
 * named after the task, and a backend install that invented a second id mid-flight would leave the
 * bar stuck at whatever it last saw. So the caller names the task and everything — the archive, the
 * CUDA runtime that some Windows backends need alongside it — reports under that one name.
 *
 * *A failed install leaves nothing installed.* An extracted-but-incomplete pack is worse than no
 * pack: `selectInstalledBackend` would find it, the runtime would spawn from it, and the failure
 * would surface as a model that will not load rather than as a download that did not finish. The
 * install therefore extracts into a temporary directory and moves it into place only once every
 * part has arrived.
 */

import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LocalProviderId } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import { validateProxyConfig } from '../downloads/index.js'
import type { DownloadItem, Downloader, ProxyConfig } from '../downloads/index.js'
import { extractArchive, normalizeBackendLayout } from '../downloads/index.js'
import {
  getBackendArchiveName,
  getCudartArchiveName,
  getCudartDownloadUrl,
  resolveBackendArchiveSource,
} from './archive.js'
import { getBackendDir, listInstalledBackendPacks } from './installed.js'
import { scanInstalledBackends } from './scan.js'
import { llamaServerExeName } from '../config/index.js'
import type { InstalledBackendPack, UpstreamManifest } from './types.js'
import type { OptimalBackendStore, OptimalState, OptimalUpdate } from './optimal-store.js'
import { ensureTurboquantCudart, readTurboquantIndexedAsset, turboquantArchiveUrl } from './turboquant.js'

/** The server executable inside a pack; the only name `normalizeBackendLayout` looks for. */
export function backendExeName(osType: string): string {
  return osType === 'windows' ? 'llama-server.exe' : 'llama-server'
}

export interface BackendServiceDeps {
  layout: DataLayout
  provider: LocalProviderId
  downloader: Downloader
  /** The live manifest for this platform, or `null` when it could not be fetched. */
  readManifest: (proxy?: ProxyConfig | null) => Promise<UpstreamManifest | null>
  optimalStore?: OptimalBackendStore
  /** Decides the executable name inside a pack (`llama-server` vs `llama-server.exe`). */
  platform?: NodeJS.Platform
  /** Test seam for the staging directory's name. */
  now?: () => number
  log?: (message: string) => void
}

export interface InstallBackendOptions {
  /** Event/task name the progress is reported under. The caller owns it; see the module note. */
  taskId: string
  /** Reinstall even when the pack is already on disk. */
  force?: boolean
  /** Current app proxy policy; never persisted. */
  proxy?: ProxyConfig | null
  /**
   * TurboQuant only: the asset the release index names for this pair. Without it the index cache on
   * disk is read, then the fork's naming convention is used.
   */
  assetName?: string
}

export interface InstallBackendResult {
  version: string
  backend: string
  /** `false` when the pack was already installed and `force` was not set. */
  installed: boolean
  path: string
}

export class BackendService {
  constructor(private readonly deps: BackendServiceDeps) {}

  /**
   * Every backend pack on disk — what the updater screen lists.
   *
   * `currentVersionBackend` decides which row is marked as the one in use; the caller passes what
   * the provider's settings say, because the service has no opinion about which backend is selected.
   */
  async listInstalled(currentVersionBackend = ''): Promise<InstalledBackendPack[]> {
    const entries = await scanInstalledBackends(this.deps.layout, this.deps.provider)
    return listInstalledBackendPacks(
      this.deps.layout.provider(this.deps.provider),
      entries,
      currentVersionBackend
    )
  }

  async isInstalled(version: string, backend: string): Promise<boolean> {
    const packs = await this.listInstalled()
    return packs.some((pack) => pack.version === version && pack.backend === backend)
  }

  /**
   * Download and unpack a backend.
   *
   * Idempotent by default: a pack already on disk is reported as `installed: false` rather than
   * downloaded again, because the updater screen calls this for every row it offers and a user
   * clicking twice should not re-fetch half a gigabyte.
   */
  async install(
    version: string,
    backend: string,
    options: InstallBackendOptions
  ): Promise<InstallBackendResult> {
    if (options.proxy) {
      const problem = validateProxyConfig(options.proxy)
      if (problem) throw new Error(problem)
    }
    const target = getBackendDir(this.deps.layout.provider(this.deps.provider), backend, version)
    if (!options.force && (await this.isInstalled(version, backend))) {
      return { version, backend, installed: false, path: target }
    }

    // Staging directory beside the target, so the move at the end is a rename on the same volume
    // rather than a copy across one.
    const staging = `${target}.incoming-${this.deps.now?.() ?? Date.now()}`
    const plan =
      this.deps.provider === 'llamacpp'
        ? await this.turboquantDownloads(version, backend, staging, options)
        : await this.upstreamDownloads(version, backend, staging, options)

    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      await this.deps.downloader.download(options.taskId, plan.items)
      for (const archive of plan.archives) {
        await extractArchive(archive, staging)
        await rm(archive, { force: true })
      }
      await normalizeBackendLayout(staging, llamaServerExeName(this.deps.platform ?? process.platform))

      await rm(target, { recursive: true, force: true })
      await mkdir(join(target, '..'), { recursive: true })
      await rename(staging, target)
    } catch (e) {
      // Nothing half-installed survives: a partial pack would be picked up by backend selection and
      // would fail later as a model that will not load.
      await rm(staging, { recursive: true, force: true })
      throw e
    }

    if (this.deps.provider === 'llamacpp') {
      // Some fork zips ship without the CUDA runtime. The extension repaired it after installing and
      // only warned on failure: the pack may still run on a host with a CUDA toolkit.
      await ensureTurboquantCudart(backend, target, options.taskId, {
        layout: this.deps.layout,
        downloader: this.deps.downloader,
        ...(this.deps.platform ? { platform: this.deps.platform } : {}),
        ...(options.proxy ? { proxy: options.proxy } : {}),
        ...(this.deps.log ? { log: this.deps.log } : {}),
      }).catch((e: unknown) =>
        this.deps.log?.(`cudart repair for ${version}/${backend} failed: ${String(e)}`)
      )
    }

    return { version, backend, installed: true, path: target }
  }

  /**
   * An upstream pack: from the signed mirror when the manifest lists this exact asset, otherwise the
   * ggml-org CDN without a checksum — the app's behaviour, and the reason a build the mirror has not
   * caught up with still installs; a wrong tag then fails as a 404 during the download. Some Windows
   * CUDA backends ship without the CUDA runtime, which is fetched beside them under the same task,
   * because to the user this is one install with one progress bar.
   */
  private async upstreamDownloads(
    version: string,
    backend: string,
    staging: string,
    options: InstallBackendOptions
  ): Promise<{ items: DownloadItem[]; archives: string[] }> {
    const manifest = await this.deps.readManifest(options.proxy)
    const source = resolveBackendArchiveSource(version, backend, manifest ?? undefined)
    const archivePath = join(staging, getBackendArchiveName(version, backend))
    const cudartName = getCudartArchiveName(backend)
    const cudartUrl = getCudartDownloadUrl(version, backend)
    const proxy = options.proxy ? { proxy: options.proxy } : {}
    const items: DownloadItem[] = [
      {
        url: source.url,
        save_path: archivePath,
        ...(source.sha256 ? { sha256: source.sha256 } : {}),
        ...(source.size ? { size: source.size } : {}),
        ...proxy,
      },
    ]
    const archives = [archivePath]
    if (cudartName && cudartUrl) {
      items.push({ url: cudartUrl, save_path: join(staging, cudartName), ...proxy })
      archives.push(join(staging, cudartName))
    }
    return { items, archives }
  }

  /**
   * A TurboQuant pack from the fork's release CDN, under the asset name its release index gives.
   * The index carries sizes and hashes, but the extension never checked them; neither does this, so
   * a republished asset installs the same way it did.
   */
  private async turboquantDownloads(
    version: string,
    backend: string,
    staging: string,
    options: InstallBackendOptions
  ): Promise<{ items: DownloadItem[]; archives: string[] }> {
    const asset = options.assetName ?? (await readTurboquantIndexedAsset(this.deps.layout, version, backend))
    const url = turboquantArchiveUrl(version, backend, asset, this.deps.platform)
    const archivePath = join(staging, url.slice(url.lastIndexOf('/') + 1))
    return {
      items: [{ url, save_path: archivePath, ...(options.proxy ? { proxy: options.proxy } : {}) }],
      archives: [archivePath],
    }
  }

  /**
   * The optimal-backend record for a provider, or `null` when nothing has been detected yet.
   *
   * The app used to keep this in `localStorage`, where the CLI could not see it. It now lives beside
   * the data it describes (`<data>/atomic-core/optimal-backend.json`, PLAN.md §3.4) and is keyed by
   * provider, because the two llama.cpp providers can be on different builds. Moving the data folder
   * to new hardware is not detected by this format; that requires a separate invalidation rule.
   */
  async getOptimalCache(): Promise<OptimalState> {
    if (!this.deps.optimalStore) throw new Error('Optimal-backend store is not configured')
    return this.deps.optimalStore.get(this.deps.provider)
  }

  /**
   * Store a detection result. Writing `null` forgets it, which is what a "Find optimal backend"
   * that finds nothing must do — leaving the previous answer would keep recommending a backend for
   * hardware that is no longer there.
   */
  async setOptimalCache(record: OptimalState['optimal'], expectedRevision: number): Promise<OptimalUpdate> {
    if (!this.deps.optimalStore) throw new Error('Optimal-backend store is not configured')
    return this.deps.optimalStore.set(this.deps.provider, record, expectedRevision)
  }

  /** Remove an installed pack. Silent when it is not there — the end state is what was asked for. */
  async remove(version: string, backend: string): Promise<boolean> {
    const target = getBackendDir(this.deps.layout.provider(this.deps.provider), backend, version)
    const existed = await this.isInstalled(version, backend)
    await rm(target, { recursive: true, force: true })
    return existed
  }
}
