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

import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import { samePath } from '../../diffusion/containment.js'
import type { LocalProviderId } from '../../contracts/index.js'
import type { DataLayout } from '../../config/index.js'
import { validateProxyConfig } from '../../downloads/index.js'
import type { DownloadItem, Downloader, ProxyConfig } from '../../downloads/index.js'
import { extractArchive, normalizeBackendLayout } from '../../downloads/index.js'
import {
  findPrismRelease,
  getBackendArchiveName,
  getCudartArchiveName,
  getCudartDownloadUrl,
  prismArchiveSources,
  prismTagBuild,
  resolveBackendArchiveSource,
} from '../catalog/index.js'
import type { PrismCatalogService } from '../catalog/index.js'
import {
  backendTypeEquivalents,
  deletableBackendPack,
  getBackendDir,
  listInstalledBackendPacks,
  readBundledLlamacppPack,
} from '../installed/index.js'
import { scanInstalledBackends } from '../installed/index.js'
import { llamaServerExeName } from '../../config/index.js'
import type { InstalledBackendPack, UpstreamManifest } from '../types.js'
import type { OptimalBackendStore, OptimalState, OptimalUpdate } from '../optimal/index.js'
import { ensureTurboquantCudart, readTurboquantIndexedAsset, turboquantArchiveUrl } from '../turboquant.js'
import { parseBackendVersion, parseBinaryVersion } from '../version.js'

const execFileAsync = promisify(execFile)

/** Same launch gate as the former macOS extension, run on staging before replacing a working pack. */
export async function verifyMacBackendBinary(staging: string, version: string): Promise<void> {
  const bin = join(staging, 'build', 'bin')
  // The former Rust gate made every build/bin file executable, not just the main server.
  for (const entry of await readdir(bin, { withFileTypes: true })) {
    if (entry.isFile()) await chmod(join(bin, entry.name), 0o755)
  }
  const executable = join(bin, 'llama-server')
  const { stdout, stderr } = await execFileAsync(executable, ['--version'], { timeout: 15_000 })
  const expected = parseBackendVersion(version)
  if (expected !== 0 && parseBinaryVersion(`${stdout}\n${stderr}`) !== expected) {
    throw new Error(`backend did not report build ${version}`)
  }
}

/**
 * The Linux cudart companion unpacks into its own `cudart-llama-<tag>-bin-…/` directory, outside the
 * `build/bin` the runtime puts on `LD_LIBRARY_PATH`; its libraries are moved there.
 */
export async function mergeCudartIntoBin(staging: string): Promise<void> {
  const bin = join(staging, 'build', 'bin')
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('cudart-')) continue
    const dir = join(staging, entry.name)
    await mkdir(bin, { recursive: true })
    for (const inner of await readdir(dir)) {
      const to = join(bin, inner)
      await rm(to, { recursive: true, force: true })
      await rename(join(dir, inner), to)
    }
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * How long a PrismML pack's `llama-server --version` may take. Its macOS build initialises Metal
 * while it parses its arguments and compiles its shaders at runtime, and the shader cache follows
 * the executable's path, which is new on every install: the first run took 15.7 s on an M-series
 * Mac (0.05 s the second time), past the 15 s the upstream gate allows.
 */
export const PRISM_LAUNCH_CHECK_TIMEOUT_MS = 120_000

/**
 * The launch gate of a PrismML pack, on every platform: the server must start and report the build
 * its tag names (`prism-b10754-…` → `build 10754`). A pack that cannot is never published, so the
 * previous one stays selectable.
 */
export async function verifyPrismBackendBinary(
  staging: string,
  version: string,
  platform: NodeJS.Platform,
  timeoutMs = PRISM_LAUNCH_CHECK_TIMEOUT_MS
): Promise<void> {
  const expected = prismTagBuild(version)
  if (expected === null) throw new Error(`${version} is not a PrismML release tag`)
  const bin = join(staging, 'build', 'bin')
  if (platform !== 'win32') {
    for (const entry of await readdir(bin, { withFileTypes: true })) {
      if (entry.isFile()) await chmod(join(bin, entry.name), 0o755)
    }
  }
  let stdout: string
  let stderr: string
  try {
    ;({ stdout, stderr } = await execFileAsync(join(bin, llamaServerExeName(platform)), ['--version'], {
      timeout: timeoutMs,
      cwd: bin,
    }))
  } catch (error) {
    // `Command failed` alone says nothing: name the exit code or the signal, and what it printed.
    const e = error as { code?: unknown; signal?: unknown; killed?: unknown; stderr?: unknown }
    const how = e.signal
      ? `signal ${String(e.signal)}${e.killed ? ', timed out' : ''}`
      : `exit code ${String(e.code)}`
    const said = String(e.stderr ?? '')
      .trim()
      .split('\n')
      .slice(-3)
      .join(' | ')
    throw new Error(`llama-server --version failed (${how})${said ? `: ${said}` : ''}`)
  }
  if (parseBinaryVersion(`${stdout}\n${stderr}`) !== expected) {
    throw new Error(`backend did not report build ${expected}`)
  }
}

/**
 * A companion archive (the Windows CUDA runtime) unpacked into `build/bin`, beside `llama-server`:
 * flat, or under one top directory, which is dropped.
 */
export async function mergeCompanionIntoBin(staging: string, archive: string): Promise<void> {
  const scratch = join(staging, '.companion')
  await rm(scratch, { recursive: true, force: true })
  await mkdir(scratch, { recursive: true })
  await extractArchive(archive, scratch)
  let from = scratch
  const top = await readdir(scratch, { withFileTypes: true })
  if (top.length === 1 && top[0]?.isDirectory()) from = join(scratch, top[0].name)
  const bin = join(staging, 'build', 'bin')
  await mkdir(bin, { recursive: true })
  for (const inner of await readdir(from)) {
    const to = join(bin, inner)
    await rm(to, { recursive: true, force: true })
    await rename(join(from, inner), to)
  }
  await rm(scratch, { recursive: true, force: true })
}

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
  /** Test seam for the macOS launch gate. */
  verifyMacBackend?: (staging: string, version: string) => Promise<void>
  /** `atomic-prism` only: where its packs, sizes and hashes come from. */
  prismCatalog?: Pick<PrismCatalogService, 'catalog'>
  /** Test seam for the PrismML launch gate. */
  verifyPrismBackend?: (staging: string, version: string) => Promise<void>
  /**
   * What runs this provider's packs (change `unify-engine-lifecycle`, task 2.4): the runtime's load
   * queue, and the pack directories its sessions and the decision and embedding models run from.
   * Absent — nothing runs (a test, a provider with no runtime).
   */
  host?: BackendHost
  /** The desktop's `resources/bin`, beside which the installer's pack sits; absent on `atc`. */
  resourcesDir?: string | undefined
  /**
   * A pack was installed or removed (`engine:changed`, change `unify-engine-lifecycle`, design D8).
   * Not for an install an update makes: the update reports itself once it has switched.
   */
  onChanged?: (reason: 'install' | 'uninstall') => void
  log?: (message: string) => void
}

export interface BackendHost {
  /** Run `fn` once the load in flight is done, with every new load held until it returns. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  /** The pack directories something runs from right now. */
  inUse(): Promise<string[]>
}

const IDLE_HOST: BackendHost = { exclusive: (fn) => fn(), inUse: async () => [] }

/** An update, activation or removal of one provider's builds; at most one runs at a time. */
export type BackendOperationKind = 'update' | 'activate' | 'remove'

/** Held by the operation running; an install that carries it is part of that operation. */
export interface BackendOperation {
  readonly kind: BackendOperationKind
}

export interface RemoveBackendOptions {
  /**
   * The code the selected pack is refused with: `INVALID_ARGUMENT` on `DELETE /backends` (as it was),
   * `INVALID_REQUEST` with `details: active` on `DELETE /engines`.
   */
  refuseActiveAs?: 'INVALID_ARGUMENT' | 'INVALID_REQUEST'
}

interface DownloadPlan {
  items: DownloadItem[]
  archives: string[]
  /** Unpacked into `build/bin` after the layout is normalised. */
  companions?: string[]
}

export interface InstallBackendOptions {
  /** Event/task name the progress is reported under. The caller owns it; see the module note. */
  taskId: string
  /** Reinstall even when the pack is already on disk. */
  force?: boolean
  /** The update this install belongs to; without it an install is refused while one runs. */
  operation?: BackendOperation
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
  private operation: BackendOperation | null = null

  constructor(private readonly deps: BackendServiceDeps) {}

  private get host(): BackendHost {
    return this.deps.host ?? IDLE_HOST
  }

  /**
   * Run one update, activation or removal of this provider's builds. A second one, or an install
   * from outside it, is refused with `ENGINE_INSTALL_IN_PROGRESS` rather than queued: the caller
   * asked for a change against a state that is about to be different.
   */
  async operate<T>(kind: BackendOperationKind, fn: (operation: BackendOperation) => Promise<T>): Promise<T> {
    if (this.operation !== null) throw this.busy()
    const operation: BackendOperation = { kind }
    this.operation = operation
    try {
      return await fn(operation)
    } finally {
      this.operation = null
    }
  }

  /** Run `fn` with this provider's loads held off (inside an operation). */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    return this.host.exclusive(fn)
  }

  private busy(): AtomicCoreError {
    return new AtomicCoreError(
      'ENGINE_INSTALL_IN_PROGRESS',
      `The ${this.deps.provider} engine is being ${this.operation?.kind === 'remove' ? 'changed' : 'updated'}; wait for that to finish.`
    )
  }

  /** The installer's pack of this provider, which the core never deletes; `null` on `atc`. */
  bundledPack(): Promise<{ version: string; backend: string } | null> {
    return readBundledLlamacppPack(this.deps.resourcesDir, this.deps.provider)
  }

  /** Whether something runs from this pack right now. */
  async inUse(version: string, backend: string): Promise<boolean> {
    return (await this.busyChecker())(version, backend)
  }

  /**
   * One look at what runs now, asked about many packs: the busy directories are read once (the
   * runtime's sessions, the decision and embedding models), not once per pack.
   */
  async busyChecker(): Promise<(version: string, backend: string) => Promise<boolean>> {
    const used = await this.host.inUse()
    const platform = this.deps.platform ?? process.platform
    return async (version, backend) => {
      const dir = getBackendDir(this.deps.layout.provider(this.deps.provider), backend, version)
      for (const busy of used) if (await samePath(busy, dir, platform)) return true
      return false
    }
  }

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
    if (this.operation !== null && options.operation !== this.operation) throw this.busy()
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
        : this.deps.provider === 'atomic-prism'
          ? await this.prismDownloads(version, backend, staging, options)
          : await this.upstreamDownloads(version, backend, staging, options)
    const platform = this.deps.platform ?? process.platform

    await rm(staging, { recursive: true, force: true })
    await mkdir(staging, { recursive: true })
    try {
      await this.deps.downloader.download(options.taskId, plan.items)
      for (const archive of plan.archives) {
        await extractArchive(archive, staging)
        await rm(archive, { force: true })
      }
      await normalizeBackendLayout(staging, llamaServerExeName(platform))
      await mergeCudartIntoBin(staging)
      for (const companion of plan.companions ?? []) {
        await mergeCompanionIntoBin(staging, companion)
        await rm(companion, { force: true })
      }

      const verify =
        this.deps.provider === 'atomic-prism'
          ? (this.deps.verifyPrismBackend ?? ((dir, tag) => verifyPrismBackendBinary(dir, tag, platform)))
          : this.deps.provider === 'llamacpp-upstream' && platform === 'darwin'
            ? (this.deps.verifyMacBackend ?? verifyMacBackendBinary)
            : null
      if (verify) {
        try {
          await verify(staging, version)
        } catch (error) {
          throw new Error(
            `The downloaded ${version}/${backend} backend failed its launch check (${String(error)}). Keeping the current backend.`
          )
        }
      }

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

    if (options.operation === undefined) this.deps.onChanged?.('install')
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
  ): Promise<DownloadPlan> {
    const manifest = await this.deps.readManifest(options.proxy)
    const source = resolveBackendArchiveSource(version, backend, manifest ?? undefined)
    const archivePath = join(staging, getBackendArchiveName(version, backend))
    const cudartName = getCudartArchiveName(backend, version)
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
   * A PrismML pack: only an asset the conf manifest lists, always with its size and sha256 — the
   * releases are a third party's, and the manifest is what this product vouches for. A withdrawn
   * release is refused. The Windows CUDA runtime the manifest pairs with the pack downloads under
   * the same task and lands in the same `build/bin`.
   */
  private async prismDownloads(
    version: string,
    backend: string,
    staging: string,
    options: InstallBackendOptions
  ): Promise<DownloadPlan> {
    if (!this.deps.prismCatalog) throw new Error('The PrismML catalog is not configured')
    const { manifest } = await this.deps.prismCatalog.catalog(options.proxy ? { proxy: options.proxy } : {})
    if (findPrismRelease(manifest, version)?.withdrawn) {
      throw new AtomicCoreError(
        'BACKEND_TAG_UNRESOLVED',
        `PrismML ${version} was withdrawn; pick another build`
      )
    }
    const sources = prismArchiveSources(manifest, version, backend)
    if (!sources) {
      throw new AtomicCoreError(
        'BACKEND_TAG_UNRESOLVED',
        `PrismML ${version}/${backend} is not in the Atomic Chat manifest`
      )
    }
    const proxy = options.proxy ? { proxy: options.proxy } : {}
    const plan: DownloadPlan = { items: [], archives: [], companions: [] }
    for (const source of sources) {
      const savePath = join(staging, source.name)
      plan.items.push({
        url: source.url,
        save_path: savePath,
        sha256: source.sha256,
        size: source.size,
        ...proxy,
      })
      ;(source.companion ? plan.companions! : plan.archives).push(savePath)
    }
    return plan
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
  ): Promise<DownloadPlan> {
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

  /**
   * After an update made `keep` active (design D5): delete the other versions of the same backend
   * (by `backendTypeEquivalents`: `ubuntu-x64` on disk is `linux-cpu-x64`),
   * except the installer's pack and the ones something still runs from, which are reported as kept.
   * Packs of other backends stay (a CPU pack kept as a fallback). Inside the update's operation and
   * its `exclusive` turn; a pack that cannot be deleted (Windows holding a file open) is kept too.
   */
  async retireOthers(
    keep: { version: string; backend: string },
    operation: BackendOperation
  ): Promise<{ retired: InstalledBackendPack[]; kept: InstalledBackendPack[] }> {
    if (operation !== this.operation) throw this.busy()
    const bundled = await this.bundledPack()
    const busy = await this.busyChecker()
    const retired: InstalledBackendPack[] = []
    const kept: InstalledBackendPack[] = []
    for (const pack of await this.listInstalled()) {
      if (!backendTypeEquivalents(keep.backend).has(pack.backend) || pack.version === keep.version) continue
      if (bundled && bundled.version === pack.version && bundled.backend === pack.backend) continue
      if (await busy(pack.version, pack.backend)) {
        kept.push(pack)
        continue
      }
      try {
        await rm(pack.path, { recursive: true, force: true })
        retired.push(pack)
      } catch (error) {
        this.deps.log?.(`Could not retire ${pack.version}/${pack.backend}: ${String(error)}`)
        kept.push(pack)
      }
    }
    return { retired, kept }
  }

  /**
   * Delete a pack. Silent when it is not there — the end state is what was asked for. Refuses ids that
   * would leave the backends directory, the pack the provider's settings select, the installer's pack
   * (`INVALID_REQUEST`, `details: bundled`: it comes back at the next launch) and a pack something runs
   * from (`BACKEND_IN_USE`). Runs as an operation and in the load queue's turn, so it waits for a load
   * in flight and no load starts from a pack half-deleted; the selection is read inside that turn.
   */
  async remove(
    version: string,
    backend: string,
    currentVersionBackend: string | (() => string) = '',
    options: RemoveBackendOptions = {}
  ): Promise<boolean> {
    const pack = deletableBackendPack('', version, backend)
    return this.operate('remove', () =>
      this.host.exclusive(async () => {
        const current =
          typeof currentVersionBackend === 'function' ? currentVersionBackend() : currentVersionBackend
        if (options.refuseActiveAs === 'INVALID_REQUEST') {
          if (`${pack.version}/${pack.backend}` === current.trim())
            throw new AtomicCoreError('INVALID_REQUEST', 'The active build cannot be removed.', 'active')
        } else deletableBackendPack(current, pack.version, pack.backend)
        const bundled = await this.bundledPack()
        if (bundled && bundled.version === pack.version && bundled.backend === pack.backend)
          throw new AtomicCoreError(
            'INVALID_REQUEST',
            'The build that ships with the app cannot be removed.',
            'bundled'
          )
        if (await this.inUse(pack.version, pack.backend))
          throw new AtomicCoreError(
            'BACKEND_IN_USE',
            'Unload the model running from this build before removing it.'
          )
        const target = getBackendDir(
          this.deps.layout.provider(this.deps.provider),
          pack.backend,
          pack.version
        )
        const existed = await this.isInstalled(pack.version, pack.backend)
        await rm(target, { recursive: true, force: true })
        if (existed) this.deps.onChanged?.('uninstall')
        return existed
      })
    )
  }
}
