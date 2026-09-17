/**
 * The TurboQuant fork's backend policy — the `llamacpp` provider's half of `backend/`.
 *
 * Ported from: src-tauri/plugins/tauri-plugin-llamacpp/src/backend.rs (`map_old_backend_to_new`,
 * `determine_supported_backends`, `unified_release_rank`, `compare_backend_versions_for_sort`,
 * `get_supported_features` with the Linux ROCm probe, `get_backend_category`, `prioritize_backends`,
 * `copy_backend_dlls`, `is_cuda_installed`) and extensions/llamacpp-extension/src/backend.ts
 * (`isTurboQuantRelease`, `isStableReleaseTag`, `defaultAssetName`, `getBackendDownloadUrl`,
 * `getIndexedAssetName`, `getCudart*`, `findUpstreamCudaBinWithCudart`) and index.ts
 * (`determineBestBackend`, `ensureCudartReady`).
 *
 * Why it cannot share the upstream functions: the fork names its builds differently
 * (`windows-x64-cuda-13.3`, not `win-cuda-13.3-x64`), publishes Linux CUDA and ROCm builds upstream
 * does not, and versions them as `b<build>-<fork semver>`. Every upstream rule applied to these ids
 * silently misses: a CPU pack has no category, a fork build sorts below a plain `b8149`, and every
 * Windows TurboQuant pack is filtered out as unsupported.
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataLayout } from '../config/index.js'
import { AtomicCoreError } from '../contracts/index.js'
import type { Downloader, ProxyConfig } from '../downloads/index.js'
import { extractArchive } from '../downloads/index.js'
import { cudaRuntimeLibName } from './installed.js'
import type { BackendFeatures, BackendVersion, GpuProbeInfo, SupportedFeatures } from './types.js'
import { compareVersions, parseBackendVersion, parseRustU32, stripBom } from './version.js'
import { gpuMeetsCuda13ArchFloor, isAmdGpu } from './select.js'

export const TURBOQUANT_DOWNLOAD_BASE =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download'
export const TURBOQUANT_RELEASE_INDEX_URL =
  'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest/download/index.json'
/** The extension's disk copy of the last good release index (`<data>/llamacpp/release-index.cache.json`). */
export const TURBOQUANT_RELEASE_INDEX_CACHE_FILE = 'release-index.cache.json'
export const GGML_ORG_CUDART_DOWNLOAD_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download'
/** The ggml-org tag that ships `cudart-llama-bin-win-cuda-{12.4,13.3}-x64.zip` (a real pin, see the extension). */
export const GGML_ORG_CUDART_PINNED_TAG = 'b10205'

/**
 * A GPU below this many MiB keeps the CPU build ahead of Vulkan and ROCm (the extension's
 * `determineBestBackend`). Upstream lowered its own threshold to 2 GiB; the fork never did.
 */
export const TURBOQUANT_GPU_MIN_VRAM_MIB = 6 * 1024

/** Windows CUDA driver floors of the fork plugin; CUDA 12's is lower than upstream's (527.41 vs 551.61). */
export const TURBOQUANT_CUDA_DRIVER_FLOORS = {
  linux: { cuda11: '450.80.02', cuda12: '525.60.13', cuda13: '580' },
  windows: { cuda11: '452.39', cuda12: '527.41', cuda13: '581.15' },
} as const

/** RDNA2–RDNA4 as amdkfd `gfx_target_version` values: the architectures the fork's ROCm build carries. */
export const ROCM_SUPPORTED_GFX_TARGET_VERSIONS: readonly number[] = [
  100300, 110000, 110100, 110200, 115100, 120000, 120100,
]

const CLEAN_IDS = new Set([
  'windows-x64-cpu',
  'windows-x64-cuda-12.4',
  'windows-x64-cuda-13.3',
  'windows-x64-vulkan',
  'linux-x64-cpu',
  'linux-x64-cuda-12.4',
  'linux-x64-cuda-13.3',
  'linux-x64-rocm',
  'linux-x64-vulkan',
  'linux-arm64-cuda-13.3',
  'macos-arm64',
  'macos-x64',
])

const UNIFIED_TAG = /^b(\d+)-(\d+)\.(\d+)\.(\d+)$/
const WINDOWS_CUDA_BACKEND = /^windows-x64-cuda-(12\.\d+|13\.\d+)$/

// ---------------------------------------------------------------------------------------------
// Release tags
// ---------------------------------------------------------------------------------------------

/** A build of the fork: a legacy `turboquant-<id>-<sha>` tag or a unified `b10018-1.3.0` one. */
export function isTurboQuantRelease(versionOrPair: string): boolean {
  const version = versionOrPair.split('/')[0] ?? ''
  return version.startsWith('turboquant-') || UNIFIED_TAG.test(version)
}

/** An installable stable release: unified tags only (legacy and `dev-latest` are prereleases). */
export function isStableReleaseTag(versionOrPair: string): boolean {
  return UNIFIED_TAG.test(stripBom(versionOrPair ?? '').split('/')[0] ?? '')
}

/** `(build, major, minor, patch)` of a unified tag, as Rust `unified_release_rank` parses it (u32 parts). */
export function unifiedReleaseRank(version: string): [number, number, number, number] | undefined {
  if (!version.startsWith('b')) return undefined
  const dash = version.indexOf('-')
  if (dash < 0) return undefined
  const u32 = (text: string | undefined) => (text === undefined ? undefined : parseRustU32(text))
  const build = u32(version.slice(1, dash))
  const parts = version.slice(dash + 1).split('.')
  if (parts.length !== 3) return undefined
  const [major, minor, patch] = parts.map(u32)
  if (build === undefined || major === undefined || minor === undefined || patch === undefined)
    return undefined
  return [build, major, minor, patch]
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Newest first. Unified tags decide by rank and outrank every legacy tag; legacy tags carry no
 * order, so they fall through to the Windows numeric compare (legacy janhq `win-*` ids), install
 * order, then the strings.
 */
export function compareTurboquantBackendsForSort(left: BackendVersion, right: BackendVersion): number {
  const l = unifiedReleaseRank(left.version)
  const r = unifiedReleaseRank(right.version)
  if (l && r) {
    for (let i = 0; i < 4; i++) if (l[i] !== r[i]) return (r[i] as number) < (l[i] as number) ? -1 : 1
  } else if (l) return -1
  else if (r) return 1

  const windows = (backend: string) => backend.startsWith('win-') || backend.startsWith('windows-')
  if (windows(left.backend) && windows(right.backend)) {
    const lv = parseBackendVersion(left.version)
    const rv = parseBackendVersion(right.version)
    if (lv !== rv) return rv < lv ? -1 : 1
  }
  const lo = left.order ?? 0
  const ro = right.order ?? 0
  if (lo !== ro) return ro < lo ? -1 : 1
  const versionCmp = compareStrings(right.version, left.version)
  if (versionCmp !== 0) return versionCmp
  return compareStrings(left.backend, right.backend)
}

// ---------------------------------------------------------------------------------------------
// Backend ids, features, matrix
// ---------------------------------------------------------------------------------------------

/** Any persisted id (legacy janhq or clean) onto the fork's clean ids. Idempotent. */
export function mapOldTurboquantBackendToNew(oldBackend: string): string {
  const b = stripBom(oldBackend)
  if (CLEAN_IDS.has(b)) return b
  if (b.startsWith('win-') || b.startsWith('windows-')) {
    if (b.includes('cuda-13') || b.includes('cu13.0')) return 'windows-x64-cuda-13.3'
    if (b.includes('cuda-12') || b.includes('cu12.0')) return 'windows-x64-cuda-12.4'
    if (b.includes('cuda-11') || b.includes('cu11.7')) return 'windows-x64-cpu'
    if (b.includes('vulkan')) return 'windows-x64-vulkan'
    return 'windows-x64-cpu'
  }
  if (b.startsWith('linux-')) {
    if (b.includes('arm64') || b.includes('aarch64')) return b
    return 'linux-x64-vulkan'
  }
  return b
}

/** What the ROCm decision needs from the host: amdkfd architectures and whether HIP is installed. */
export interface RocmHostProbe {
  gfxTargetVersions: readonly number[]
  hasRuntime: boolean
}

/** Every input must be affirmative; anything uncertain stays on Vulkan, which works. */
export function rocmSupportedLinux(hasAmdGpu: boolean, probe: RocmHostProbe): boolean {
  return (
    hasAmdGpu &&
    probe.hasRuntime &&
    probe.gfxTargetVersions.some((v) => ROCM_SUPPORTED_GFX_TARGET_VERSIONS.includes(v))
  )
}

export interface RocmProbeFs {
  readdir: (path: string) => Promise<string[]>
  readFile: (path: string) => Promise<string>
  exists: (path: string) => Promise<boolean>
}

const nodeProbeFs: RocmProbeFs = {
  readdir: (path) => readdir(path),
  readFile: (path) => readFile(path, 'utf8'),
  exists: (path) =>
    stat(path).then(
      () => true,
      () => false
    ),
}

/**
 * The Linux host facts, read the way the plugin reads them: `gfx_target_version` from
 * `/sys/class/kfd/kfd/topology/nodes/<n>/properties` (zeros are CPU nodes), and `libamdhip64.so`
 * in a ROCm prefix or on the default library path.
 */
export async function probeLinuxRocmHost(fs: RocmProbeFs = nodeProbeFs): Promise<RocmHostProbe> {
  const nodesDir = '/sys/class/kfd/kfd/topology/nodes'
  const gfxTargetVersions: number[] = []
  for (const node of await fs.readdir(nodesDir).catch(() => [] as string[])) {
    const properties = await fs.readFile(join(nodesDir, node, 'properties')).catch(() => undefined)
    for (const line of properties?.split('\n') ?? []) {
      if (!line.startsWith('gfx_target_version ')) continue
      const value = line.slice('gfx_target_version '.length).trim()
      if (/^\d+$/.test(value) && Number(value) !== 0) gfxTargetVersions.push(Number(value))
    }
  }
  const libraryDirs = [
    '/opt/rocm/lib',
    '/opt/rocm/lib64',
    '/usr/lib/x86_64-linux-gnu',
    '/usr/lib64',
    '/usr/lib',
  ]
  let hasRuntime = false
  for (const dir of libraryDirs) if (await fs.exists(join(dir, 'libamdhip64.so'))) hasRuntime = true
  if (!hasRuntime) {
    for (const entry of await fs.readdir('/opt').catch(() => [] as string[])) {
      if (!entry.startsWith('rocm-')) continue
      if (
        (await fs.exists(join('/opt', entry, 'lib', 'libamdhip64.so'))) ||
        (await fs.exists(join('/opt', entry, 'lib64', 'libamdhip64.so')))
      )
        hasRuntime = true
    }
  }
  return { gfxTargetVersions, hasRuntime }
}

/** `get_supported_features` of the fork: its own Windows CUDA 12 floor, and ROCm on Linux only. */
export function getTurboquantSupportedFeatures(
  osType: string,
  cpuExtensions: readonly string[],
  gpus: readonly GpuProbeInfo[],
  rocm: RocmHostProbe = { gfxTargetVersions: [], hasRuntime: false }
): SupportedFeatures {
  const features: SupportedFeatures = {
    avx: cpuExtensions.includes('avx'),
    avx2: cpuExtensions.includes('avx2'),
    avx512: cpuExtensions.includes('avx512'),
    cuda11: false,
    cuda12: false,
    cuda13: false,
    vulkan: false,
    rocm: false,
  }
  if (osType === 'linux') features.rocm = rocmSupportedLinux(gpus.some(isAmdGpu), rocm)
  const floors =
    osType === 'linux' || osType === 'windows' ? TURBOQUANT_CUDA_DRIVER_FLOORS[osType] : undefined
  if (!floors) return features
  let allNvidiaMeetCuda13Arch = true
  for (const gpu of gpus) {
    const driver = gpu.driver_version ?? ''
    if (gpu.nvidia_info) {
      if (compareVersions(driver, floors.cuda11) >= 0) features.cuda11 = true
      if (compareVersions(driver, floors.cuda12) >= 0) features.cuda12 = true
      if (compareVersions(driver, floors.cuda13) >= 0) features.cuda13 = true
      if (!gpuMeetsCuda13ArchFloor(gpu.nvidia_info.compute_capability)) allNvidiaMeetCuda13Arch = false
    }
    if (gpu.vulkan_info) features.vulkan = true
  }
  features.cuda13 = features.cuda13 && allNvidiaMeetCuda13Arch
  return features
}

/**
 * Backend ids the fork publishes for `<osType>-<arch>`. Linux x64 always offers Vulkan (it carries a
 * portable CPU path and is the bundled fallback); Linux arm64 has only the CUDA 13 build; Windows
 * arm64 gets a placeholder that matches no asset, exactly as the plugin reports it.
 */
export function determineTurboquantSupportedBackends(
  osType: string,
  arch: string,
  features: BackendFeatures
): string[] {
  const sysType = `${osType}-${arch}`
  const supported: string[] = []
  switch (sysType) {
    case 'windows-x86_64':
      supported.push('windows-x64-cpu')
      if (features.cuda12) supported.push('windows-x64-cuda-12.4')
      if (features.cuda13) supported.push('windows-x64-cuda-13.3')
      if (features.vulkan) supported.push('windows-x64-vulkan')
      break
    case 'windows-aarch64':
    case 'windows-arm64':
      supported.push('windows-arm64')
      break
    case 'linux-x86_64':
    case 'linux-x86':
      supported.push('linux-x64-cpu')
      if (features.cuda12) supported.push('linux-x64-cuda-12.4')
      if (features.cuda13) supported.push('linux-x64-cuda-13.3')
      if (features.rocm) supported.push('linux-x64-rocm')
      supported.push('linux-x64-vulkan')
      break
    case 'linux-aarch64':
    case 'linux-arm64':
      if (features.cuda13) supported.push('linux-arm64-cuda-13.3')
      break
    case 'macos-x86_64':
    case 'macos-x86':
      supported.push('macos-x64')
      break
    case 'macos-aarch64':
    case 'macos-arm64':
      supported.push('macos-arm64')
      break
    default:
      throw new AtomicCoreError('INVALID_ARGUMENT', `Unsupported system type: ${sysType}`)
  }
  return supported
}

/** The extension's hardware gate, on every OS: keep what maps onto a supported id. */
export function filterTurboquantBackendsBySupport(
  backends: readonly BackendVersion[],
  supported: readonly string[]
): BackendVersion[] {
  const set = new Set(supported)
  return backends.filter((b) => set.has(mapOldTurboquantBackendToNew(b.backend)))
}

// ---------------------------------------------------------------------------------------------
// Categories and priority
// ---------------------------------------------------------------------------------------------

/** Rust `get_backend_category` of the fork; `-cpu` ids are `common_cpus` here. */
export function getTurboquantBackendCategory(backend: string): string | null {
  if (backend.includes('cuda-13') || backend.includes('cu13.0')) return 'cuda-cu13.0'
  if (backend.includes('cuda-12') || backend.includes('cu12.0')) return 'cuda-cu12.0'
  if (backend.includes('cuda-11') || backend.includes('cu11.7')) return 'cuda-cu11.7'
  if (backend.includes('rocm')) return 'rocm'
  if (backend.includes('vulkan')) return 'vulkan'
  if (backend.includes('common_cpus') || backend.includes('-cpu')) return 'common_cpus'
  if (backend.includes('avx512')) return 'avx512'
  if (backend.includes('avx2')) return 'avx2'
  if (backend.includes('avx') && !backend.includes('avx2') && !backend.includes('avx512')) return 'avx'
  if (backend.includes('noavx')) return 'noavx'
  if (backend.endsWith('arm64')) return 'arm64'
  if (backend.endsWith('x64')) return 'x64'
  return null
}

const PRIORITY_ENOUGH_VRAM = [
  'cuda-cu13.0',
  'cuda-cu12.0',
  'cuda-cu11.7',
  'rocm',
  'vulkan',
  'common_cpus',
  'avx512',
  'avx2',
  'avx',
  'noavx',
  'arm64',
  'x64',
]
const PRIORITY_LOW_VRAM = [
  'cuda-cu13.0',
  'cuda-cu12.0',
  'cuda-cu11.7',
  'common_cpus',
  'avx512',
  'avx2',
  'avx',
  'noavx',
  'arm64',
  'x64',
  'rocm',
  'vulkan',
]

/** Rust `prioritize_backends`: the newest build of the first category present, else the first entry. */
export function prioritizeTurboquantBackends(
  backends: readonly BackendVersion[],
  hasEnoughGpuMemory: boolean
): string {
  if (backends.length === 0) throw new AtomicCoreError('INVALID_ARGUMENT', 'No backends available')
  for (const category of hasEnoughGpuMemory ? PRIORITY_ENOUGH_VRAM : PRIORITY_LOW_VRAM) {
    const matching = backends.filter((b) => getTurboquantBackendCategory(b.backend) === category)
    if (matching.length === 0) continue
    const best = [...matching].sort(compareTurboquantBackendsForSort)[0] as BackendVersion
    return `${best.version}/${best.backend}`
  }
  const fallback = backends[0] as BackendVersion
  return `${fallback.version}/${fallback.backend}`
}

/** The extension's `determineBestBackend`: 6 GiB on any GPU counts as enough memory. */
export function determineBestTurboquantBackend(
  backends: readonly BackendVersion[],
  gpus: readonly GpuProbeInfo[]
): string {
  if (backends.length === 0) return ''
  const hasEnough = gpus.some((gpu) => (gpu.total_memory ?? 0) >= TURBOQUANT_GPU_MIN_VRAM_MIB)
  return prioritizeTurboquantBackends(backends, hasEnough)
}

// ---------------------------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------------------------

/** `llama-turboquant-<id>.{zip|tar.gz}`: the id prefix decides, then the host OS. */
export function turboquantDefaultAssetName(
  backend: string,
  platform: NodeJS.Platform = process.platform
): string {
  const id = stripBom(backend)
  const windows = /^win(dows)?-/.test(id)
    ? true
    : /^(linux|macos|mac)-/.test(id)
      ? false
      : platform === 'win32'
  return `llama-turboquant-${id}.${windows ? 'zip' : 'tar.gz'}`
}

export function turboquantArchiveUrl(
  version: string,
  backend: string,
  assetName?: string,
  platform?: NodeJS.Platform
): string {
  const asset = stripBom(assetName ?? '') || turboquantDefaultAssetName(backend, platform)
  return `${TURBOQUANT_DOWNLOAD_BASE}/${stripBom(version)}/${asset}`
}

/**
 * The asset the release index names for `tag/backend`, from the extension's disk cache of the index.
 * The extension read its in-memory copy; the disk copy is the same data and survives a restart.
 */
export async function readTurboquantIndexedAsset(
  layout: DataLayout,
  version: string,
  backend: string
): Promise<string | undefined> {
  try {
    const cache = JSON.parse(
      await readFile(join(layout.provider('llamacpp').root, TURBOQUANT_RELEASE_INDEX_CACHE_FILE), 'utf8')
    ) as {
      catalog?: { releases?: Array<{ tag?: unknown; variants?: Array<{ id?: unknown; asset?: unknown }> }> }
    }
    const release = cache.catalog?.releases?.find((r) => r.tag === stripBom(version))
    const asset = release?.variants?.find((v) => v.id === stripBom(backend))?.asset
    return typeof asset === 'string' && asset.trim() ? asset.trim() : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------
// CUDA runtime companion (Windows)
// ---------------------------------------------------------------------------------------------

/** CUDA toolkit minor (`13.3`) of a Windows CUDA id of the fork, else `null`. */
export function turboquantCudaToolkit(backend: string): string | null {
  return WINDOWS_CUDA_BACKEND.exec(stripBom(backend))?.[1] ?? null
}

export function turboquantCudartArchiveName(backend: string): string | null {
  const toolkit = turboquantCudaToolkit(backend)
  return toolkit ? `cudart-llama-bin-win-cuda-${toolkit}-x64.zip` : null
}

export function turboquantCudartUrl(backend: string, tag = GGML_ORG_CUDART_PINNED_TAG): string | null {
  const name = turboquantCudartArchiveName(backend)
  const pinned = stripBom(tag)
  return name && pinned ? `${GGML_ORG_CUDART_DOWNLOAD_BASE}/${pinned}/${name}` : null
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )

/**
 * An installed upstream CUDA pack of the same minor that carries the runtime DLL — the no-network
 * source. Version folders are tried in reverse string order, as the extension did.
 */
export async function findUpstreamCudaDonor(
  layout: DataLayout,
  toolkit: string
): Promise<string | undefined> {
  const lib = cudaRuntimeLibName('windows', toolkit)
  if (!lib) return undefined
  const root = layout.provider('llamacpp-upstream').backendsDir
  const versions = await readdir(root).catch(() => [] as string[])
  for (const version of [...versions].sort().reverse()) {
    const bin = join(root, version, `win-cuda-${toolkit}-x64`, 'build', 'bin')
    if (await exists(join(bin, lib))) return bin
  }
  return undefined
}

/** Rust `copy_backend_dlls`: `.dll` files whose lowercase name starts with a prefix; the source stays. */
export async function copyBackendDlls(
  srcDir: string,
  dstDir: string,
  prefixes: readonly string[]
): Promise<number> {
  const entries = await readdir(srcDir, { withFileTypes: true }).catch(() => {
    throw new AtomicCoreError('IO_ERROR', `source dir does not exist: ${srcDir}`)
  })
  await mkdir(dstDir, { recursive: true })
  const lower = prefixes.map((p) => p.toLowerCase())
  let copied = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const name = entry.name.toLowerCase()
    if (!name.endsWith('.dll') || !lower.some((p) => name.startsWith(p))) continue
    await copyFile(join(srcDir, entry.name), join(dstDir, entry.name))
    copied++
  }
  return copied
}

export interface CudartRepairDeps {
  layout: DataLayout
  downloader: Pick<Downloader, 'download'>
  platform?: NodeJS.Platform
  proxy?: ProxyConfig | null
  log?: (message: string) => void
}

/**
 * Make a Windows TurboQuant CUDA pack carry its CUDA runtime: nothing to do when `cudart64_<major>`
 * is already in `build/bin`; otherwise copy it from an upstream pack of the same minor, and only
 * then download the pinned ggml-org companion and move its DLLs in. Some fork release zips ship
 * without the runtime, and without it `--list-devices` is empty on a host with no CUDA toolkit.
 *
 * Returns what it did. Throws only for a download or an archive with no DLLs; the callers — install
 * and load — treat that as a warning, as the extension did, because the pack may still run.
 */
export async function ensureTurboquantCudart(
  backend: string,
  backendDir: string,
  taskId: string,
  deps: CudartRepairDeps
): Promise<'not-needed' | 'present' | 'copied' | 'downloaded'> {
  if ((deps.platform ?? process.platform) !== 'win32') return 'not-needed'
  const toolkit = turboquantCudaToolkit(backend)
  const url = turboquantCudartUrl(backend)
  const archiveName = turboquantCudartArchiveName(backend)
  const lib = toolkit ? cudaRuntimeLibName('windows', toolkit) : null
  if (!toolkit || !url || !archiveName || !lib) return 'not-needed'
  const bin = join(backendDir, 'build', 'bin')
  if (await exists(join(bin, lib))) return 'present'
  await mkdir(bin, { recursive: true })

  const donor = await findUpstreamCudaDonor(deps.layout, toolkit)
  if (donor) {
    const copied = await copyBackendDlls(donor, bin, ['cudart', 'cublas']).catch((e: unknown) => {
      deps.log?.(`copy-from-upstream cudart for ${backend} failed, will download: ${String(e)}`)
      return 0
    })
    if (copied > 0 && (await exists(join(bin, lib)))) return 'copied'
  }

  const tmp = deps.layout.provider('llamacpp').tmpDir
  const archive = join(tmp, archiveName)
  const extractDir = join(tmp, `cudart-${backend}-${toolkit}`)
  await mkdir(tmp, { recursive: true })
  try {
    await deps.downloader.download(taskId, [
      { url, save_path: archive, ...(deps.proxy ? { proxy: deps.proxy } : {}) },
    ])
    await mkdir(extractDir, { recursive: true })
    await extractArchive(archive, extractDir)
    let moved = 0
    const stack = [extractDir]
    while (stack.length > 0) {
      const dir = stack.pop() as string
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isDirectory()) stack.push(path)
        else if (entry.name.toLowerCase().endsWith('.dll')) {
          await rename(path, join(bin, entry.name))
          moved++
        }
      }
    }
    if (moved === 0) throw new AtomicCoreError('IO_ERROR', `cudart archive for ${backend} contained no DLLs`)
    return 'downloaded'
  } finally {
    await rm(archive, { force: true }).catch(() => {})
    await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  }
}
