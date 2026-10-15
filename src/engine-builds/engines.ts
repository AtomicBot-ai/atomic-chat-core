/**
 * Everything that differs between the engines `EngineBuildsService` installs, as one table (openspec
 * change `add-foundry-local`, task 4.1): which release a manifest offers, which build fits this host,
 * which archives make it, how it is probed and recorded, what is on disk and which build is active.
 * The service only orders the steps; a new engine is a new row here, not another branch there.
 */

import { AtomicCoreError } from '../contracts/index.js'
import type { EngineBuildId, EngineBuildRef } from '../contracts/index.js'
import { listInstalledBackends, prepareSdcppTree, writeInstallRecord } from '../diffusion/install.js'
import type { HardwareFacts } from '../hardware/index.js'
import { listDownloadedMlx, probeMlxServer, readBundledMlx, writeMlxInstallRecord } from './builds.js'
import type { BundledMlx } from './builds.js'
import type { BuildArchive } from './install.js'
import {
  listFoundryLocalBuilds,
  prepareFoundryLocalTree,
  writeFoundryLocalInstallRecord,
} from './foundry-local.js'
import { FOUNDRY_LOCAL_C_API_VERSIONS, foundryLocalAssetUrl, mlxAssetUrl, sdcppAssetUrl } from './manifest.js'
import type { FoundryLocalManifest, ManifestOf, MlxManifest, SdcppManifest } from './manifest.js'
import { compareBuilds } from './order.js'
import {
  backendKindOf,
  companionFor,
  foundryLocalHostChoice,
  mlxHostChoice,
  readFailedBackends,
  rememberFailedBackend,
  sdcppHostChoice,
  sdcppHostOf,
} from './select.js'
import type { FoundryLocalHostPlatform } from './select.js'

/** One build on disk as the service sees it. */
export interface Build extends EngineBuildRef {
  /** For a bundled MLX build, `resources-dir`; otherwise the build's own directory. */
  dir: string
  installed_at_ms: number | null
  published_at: string | null
  /** Foundry Local: the C API version recorded at install; `null` when unknown. */
  c_api_version?: number | null
}

/** What a row may read from the service's dependencies. */
export interface EngineContext {
  /** This engine's `<data>/…/backends`. */
  root: string
  failedBackendsFile: string
  resourcesDir?: string | undefined
  platform: NodeJS.Platform
  hardware: () => Promise<Pick<HardwareFacts, 'osType' | 'arch' | 'cpuExtensions' | 'gpus'>>
  log?: ((level: 'info' | 'warn', message: string) => void) | undefined
  /** Which Foundry Local archive this host runs (`foundryLocalHostPlatform`), or why none. */
  foundryLocalHost: FoundryLocalHostPlatform
  /** `foundry-host probe --lib <dir>` of this core; throws `ENGINE_INSTALL_FAILED` with what it printed. */
  foundryHostProbe?: ((libDir: string) => Promise<void>) | undefined
}

export interface HostChoice {
  /** What this host would install, best first. */
  ladder: string[]
  backend_id: string | null
  /** Why `backend_id` is `null`. */
  reason: string | null
}

/** An archive of a build; `sha256` and `size` are absent when the manifest does not pin them. */
export type ArchiveRef = Omit<BuildArchive, 'sha256' | 'size'> & { sha256?: string; size?: number }

export interface BuildRecordInfo {
  tag: string
  backendId: string
  sha256: string | null
  installedAtMs: number
  publishedAt: string | null
  /** Foundry Local: the release's C API version. */
  cApiVersion: number | null
}

export interface EngineDescriptor<M> {
  /** The release an install takes from the manifest, and the order key it carries. */
  release(manifest: M): { tag: string; published_at: string | null; c_api_version?: number }
  hostChoice(ctx: EngineContext, manifest: M | null): Promise<HostChoice>
  /** The build's archive first, companions after; all unpack into one directory. */
  archives(manifest: M, backendId: string): ArchiveRef[]
  /** Fix the unpacked tree up before the probe; runs even when a test replaces the probe. */
  prepare?(staging: string, ctx: EngineContext): Promise<void>
  /** Make the unpacked tree runnable and prove it runs here; throws `ENGINE_INSTALL_FAILED`. */
  probe(staging: string, ctx: EngineContext): Promise<void>
  /** The ownership marker and `install.json`. */
  record(staging: string, info: BuildRecordInfo): Promise<void>
  builds(ctx: EngineContext): Promise<Build[]>
  /** The build the next load uses. */
  active(builds: Build[]): Build | undefined
  /**
   * Present when a build that fails its probe sends the install down the host's ladder (sd.cpp,
   * design D7 of `move-sdcpp-mlx-install-to-core`): remember the failed rung for this tag.
   */
  rememberFailedRung?(ctx: EngineContext, tag: string, backendId: string): Promise<void>
}

const pin = (asset: { sha256?: string; size?: number }) => ({
  ...(asset.sha256 !== undefined ? { sha256: asset.sha256 } : {}),
  ...(asset.size !== undefined ? { size: asset.size } : {}),
})

/** The newest of `builds` by the engine's order; the first one wins a tie. */
function newest(engine: EngineBuildId, builds: Build[]): Build | undefined {
  let best: Build | undefined
  for (const build of builds) if (!best || compareBuilds(engine, build, best) > 0) best = build
  return best
}

const sdcpp: EngineDescriptor<SdcppManifest> = {
  release: (manifest) => ({ tag: manifest.tag_name, published_at: null }),
  async hostChoice(ctx, manifest) {
    const host = sdcppHostOf(await ctx.hardware())
    if (!manifest) return { ladder: [], backend_id: null, reason: 'The sd.cpp manifest is unavailable.' }
    return sdcppHostChoice(host, manifest, await readFailedBackends(ctx.failedBackendsFile))
  },
  archives(manifest, backendId) {
    const ids = [backendId, companionFor(backendId)]
    return ids.flatMap((id) => {
      const asset = manifest.assets.find((candidate) => candidate.backend === id)
      return asset ? [{ ...pin(asset), url: sdcppAssetUrl(manifest, asset), name: asset.name }] : []
    })
  },
  probe: (staging, ctx) =>
    prepareSdcppTree(staging, { platform: ctx.platform, ...(ctx.log ? { log: ctx.log } : {}) }),
  record: (staging, info) =>
    writeInstallRecord(staging, {
      tag: info.tag,
      backendId: info.backendId,
      backend: backendKindOf(info.backendId),
      engine: 'sd-cpp',
      sha256: info.sha256,
      installedAtMs: info.installedAtMs,
      dir: staging,
    }),
  async builds(ctx) {
    return (await listInstalledBackends(ctx.root, ctx.platform))
      .filter((record) => record.engine === 'sd-cpp')
      .map((record) => ({
        tag: record.tag,
        backend_id: record.backendId,
        origin: 'downloaded',
        dir: record.dir,
        installed_at_ms: record.installedAtMs,
        published_at: null,
      }))
  },
  /** The newest install, which `selectModelInstall` hands the next load. */
  active: (builds) => builds[0],
  rememberFailedRung: (ctx, tag, backendId) => rememberFailedBackend(ctx.failedBackendsFile, tag, backendId),
}

const mlx: EngineDescriptor<MlxManifest> = {
  release: (manifest) => ({ tag: manifest.tag_name, published_at: manifest.published_at }),
  async hostChoice(ctx, manifest) {
    const choice = mlxHostChoice(sdcppHostOf(await ctx.hardware()), manifest)
    return { ...choice, ladder: choice.backend_id ? [choice.backend_id] : [] }
  },
  archives: (manifest, backendId) =>
    manifest.assets
      .filter((asset) => asset.backend === backendId)
      .map((asset) => ({ ...pin(asset), url: mlxAssetUrl(manifest, asset), name: asset.name })),
  probe: (staging, ctx) => probeMlxServer(staging, { platform: ctx.platform }),
  record: (staging, { cApiVersion: _cApiVersion, ...info }) => writeMlxInstallRecord(staging, info),
  async builds(ctx) {
    const out: Build[] = (await listDownloadedMlx(ctx.root)).map((record) => ({
      tag: record.tag,
      backend_id: record.backendId,
      origin: 'downloaded',
      dir: record.dir,
      installed_at_ms: record.installedAtMs,
      published_at: record.publishedAt,
    }))
    const bundled = await readBundledMlx(ctx.resourcesDir)
    if (bundled) out.unshift(bundledMlxBuild(bundled, ctx.resourcesDir as string))
    return out
  },
  /** The newest build by `published_at`, the bundled one on a tie (spec "Две точки происхождения mlx-server"). */
  active: (builds) => newest('mlx', builds),
}

function bundledMlxBuild(bundled: BundledMlx, resourcesDir: string): Build {
  return {
    tag: bundled.tag ?? 'bundled',
    backend_id: 'macos-arm64',
    origin: 'bundled',
    dir: resourcesDir,
    installed_at_ms: null,
    published_at: bundled.published_at,
  }
}

const foundryLocal: EngineDescriptor<FoundryLocalManifest> = {
  release: (manifest) => {
    const newest = manifest.releases[0] as FoundryLocalManifest['releases'][number]
    return { tag: newest.tag, published_at: newest.published_at, c_api_version: newest.c_api_version }
  },
  hostChoice: async (ctx, manifest) =>
    foundryLocalHostChoice(ctx.foundryLocalHost, manifest?.releases[0] ?? null),
  archives(manifest, backendId) {
    const release = manifest.releases[0]
    const asset = release?.assets.find((candidate) => candidate.platform === backendId)
    return release && asset
      ? [{ ...pin(asset), url: foundryLocalAssetUrl(manifest, release, asset), name: asset.name }]
      : []
  },
  prepare: (staging, ctx) => prepareFoundryLocalTree(staging, ctx.platform),
  async probe(staging, ctx) {
    if (!ctx.foundryHostProbe)
      throw new AtomicCoreError(
        'ENGINE_INSTALL_FAILED',
        'This core has no Foundry Local host to check the build with.'
      )
    await ctx.foundryHostProbe(staging)
  },
  record: (staging, info) => writeFoundryLocalInstallRecord(staging, info),
  async builds(ctx) {
    return (await listFoundryLocalBuilds(ctx.root)).map((record) => ({
      tag: record.tag,
      backend_id: record.backendId,
      origin: 'downloaded',
      dir: record.dir,
      installed_at_ms: record.installedAtMs,
      published_at: record.publishedAt,
      c_api_version: record.cApiVersion,
    }))
  },
  /** The newest by `published_at` among the builds whose C API this core's host binds (design D2). */
  active: (builds) =>
    newest(
      'foundry-local',
      builds.filter(
        (build) => build.c_api_version != null && FOUNDRY_LOCAL_C_API_VERSIONS.includes(build.c_api_version)
      )
    ),
}

export const ENGINE_DESCRIPTORS: { [K in EngineBuildId]: EngineDescriptor<ManifestOf[K]> } = {
  'sd-cpp': sdcpp,
  'mlx': mlx,
  'foundry-local': foundryLocal,
}
