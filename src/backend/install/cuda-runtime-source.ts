/**
 * Put a Windows CUDA pack's runtime beside it — `cudart64_<N>`, `cublas64_<N>`, `cublasLt64_<N>` —
 * from the best source this machine has, so a CUDA build never runs without it (and never quietly
 * runs on the CPU). Sources, in order, until the whole set is in the pack's `build/bin`:
 *
 * 1. Already there.
 * 2. Offline: another installed llama.cpp pack of any provider with the same CUDA major and at least
 *    the same minor, or the legacy `<data>/llamacpp/lib` folder.
 * 3. Offline: a CUDA toolkit installed on the host (`CUDA_PATH*`, `Program Files\NVIDIA GPU Computing
 *    Toolkit\CUDA\vX.Y`), from `bin\x64` (CUDA 13) or `bin` (CUDA 12), same major, minor at least.
 * 4. The pack's own ggml-org companion for its release tag (the caller passes it, with its sha256
 *    when the release list names it).
 * 5. NVIDIA's own redistributable archives (`cuda_cudart` + `libcublas`, windows-x86_64) from the
 *    `redistrib_<X.Y.Z>.json` manifest of the same major and the nearest minor, verified by sha256.
 * 6. The pinned ggml-org companions below, verified by GitHub's digests.
 *
 * An incomplete runtime is replaced as a whole from one source: existing cuBLAS and cuBLASLt may
 * belong to different releases, so filling only the missing filenames is not enough. A failed copy is never reported as a successful repair; the caller decides how to
 * handle a pack that remains unusable.
 */

import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { DataLayout } from '../../config/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import type { DownloadItem, Downloader, ProxyConfig } from '../../downloads/index.js'
import { DOWNLOAD_CANCELLED, extractArchive } from '../../downloads/index.js'
import { getCudaToolkitVersion, windowsCudaBackendArch } from '../catalog/index.js'
import { missingWindowsCudaRuntimeDlls, windowsCudaRuntimeDlls } from '../installed/index.js'
import { turboquantCudaToolkit } from '../turboquant.js'
import { parseRustU32 } from '../version.js'

export const NVIDIA_CUDA_REDIST_BASE = 'https://developer.download.nvidia.com/compute/cuda/redist'

/** ggml-org's Windows runtime companions with GitHub's digests; the fallback when nothing better answers. */
export const PINNED_WINDOWS_CUDA_RUNTIMES: ReadonlyArray<{
  toolkit: string
  arch: 'x64' | 'arm64'
  url: string
  sha256: string
  size: number
}> = [
  {
    toolkit: '12.4',
    arch: 'x64',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10205/cudart-llama-bin-win-cuda-12.4-x64.zip',
    sha256: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6',
    size: 391_443_627,
  },
  {
    toolkit: '13.3',
    arch: 'x64',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b10205/cudart-llama-bin-win-cuda-13.3-x64.zip',
    sha256: '1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e',
    size: 390_970_417,
  },
  {
    toolkit: '13.4',
    arch: 'x64',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12019/cudart-llama-bin-win-cuda-13.4-x64.zip',
    sha256: '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668',
    size: 423_535_356,
  },
  {
    toolkit: '13.4',
    arch: 'arm64',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12019/cudart-llama-bin-win-cuda-13.4-arm64.zip',
    sha256: '642dcde8805b3e3165ca710a5443b3b4044b27d96bd3ee3132473988c9bcb774',
    size: 153_262_407,
  },
]

export type CudaRuntimeSource =
  'present' | 'installed-pack' | 'host-toolkit' | 'release-companion' | 'nvidia-redist' | 'pinned-companion'

export interface CudaRuntimeTarget {
  provider: string
  version: string
  backend: string
  /** The pack's directory (`…/<version>/<backend>`), or its staging directory during an install. */
  packDir: string
}

export interface CudaRuntimeDeps {
  layout: DataLayout
  downloader: Pick<Downloader, 'download'>
  taskId: string
  proxy?: ProxyConfig | null
  /** The pack's own ggml-org companion, with its sha256 and size when the release list names them. */
  releaseCompanion?: { url: string; sha256?: string | null; size?: number | null } | null
  /** For NVIDIA's manifests; without it the NVIDIA source is skipped. */
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
  /** Directory listing; injected by tests. */
  listDir?: (dir: string) => Promise<string[]>
}

interface Toolkit {
  major: number
  minor: number
}

function parseToolkit(text: string | null | undefined): Toolkit | undefined {
  const [major, minor] = (text ?? '').split('.')
  const ma = parseRustU32(major ?? '')
  const mi = parseRustU32(minor ?? '0')
  return ma === undefined || mi === undefined ? undefined : { major: ma, minor: mi }
}

/** Same major, and at least the minor the pack was built with. */
function satisfies(candidate: Toolkit | undefined, wanted: Toolkit): boolean {
  return candidate !== undefined && candidate.major === wanted.major && candidate.minor >= wanted.minor
}

export function cudaToolkitOfPack(provider: string, backend: string): string | null {
  return provider === 'llamacpp' ? turboquantCudaToolkit(backend) : getCudaToolkitVersion(backend)
}

function archOfPack(provider: string, backend: string): 'x64' | 'arm64' {
  return provider === 'llamacpp' ? 'x64' : (windowsCudaBackendArch(backend) ?? 'x64')
}

const defaultList = (dir: string) => readdir(dir).catch(() => [] as string[])

/** Copy `names` from `fromDir` into `toDir` when it has every one of them (case-insensitive). */
async function copyAllFrom(
  fromDir: string,
  toDir: string,
  names: readonly string[],
  list: (dir: string) => Promise<string[]>
): Promise<boolean> {
  const byLower = new Map((await list(fromDir)).map((name) => [name.toLowerCase(), name]))
  const sources = names.map((name) => byLower.get(name.toLowerCase()))
  if (sources.some((s) => s === undefined)) return false
  await mkdir(toDir, { recursive: true })
  for (const [i, name] of names.entries())
    await copyFile(join(fromDir, sources[i] as string), join(toDir, name))
  return true
}

/** Installed packs and the legacy lib folder that may lend the runtime, best match first. */
async function localDonors(
  target: CudaRuntimeTarget,
  wanted: Toolkit,
  arch: 'x64' | 'arm64',
  deps: CudaRuntimeDeps,
  list: (dir: string) => Promise<string[]>
): Promise<string[]> {
  const scored: Array<{ dir: string; minor: number }> = []
  for (const provider of ['llamacpp-upstream', 'llamacpp', 'atomic-prism'] as const) {
    const root = deps.layout.provider(provider).backendsDir
    for (const version of await list(root)) {
      for (const backend of await list(join(root, version))) {
        if (provider === target.provider && version === target.version && backend === target.backend) continue
        const toolkit = parseToolkit(cudaToolkitOfPack(provider, backend))
        if (!satisfies(toolkit, wanted) || archOfPack(provider, backend) !== arch) continue
        scored.push({ dir: join(root, version, backend, 'build', 'bin'), minor: (toolkit as Toolkit).minor })
      }
    }
  }
  // The nearest minor first: the runtime closest to what the pack was built with.
  scored.sort((a, b) => a.minor - b.minor)
  return [...scored.map((s) => s.dir), join(deps.layout.root, 'llamacpp', 'lib')]
}

/** Host CUDA toolkits' DLL folders, nearest minor first. Windows only: other hosts have none. */
async function hostToolkitDirs(
  wanted: Toolkit,
  env: NodeJS.ProcessEnv,
  list: (dir: string) => Promise<string[]>
): Promise<string[]> {
  const roots = new Map<string, Toolkit | undefined>()
  const versionIn = (text: string) => {
    const m = /v(\d+)\.(\d+)/i.exec(text)
    return m ? parseToolkit(`${m[1]}.${m[2]}`) : undefined
  }
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue
    const keyed = /^CUDA_PATH_V(\d+)_(\d+)$/i.exec(key)
    if (keyed) roots.set(value, parseToolkit(`${keyed[1]}.${keyed[2]}`))
    else if (key.toUpperCase() === 'CUDA_PATH' && !roots.has(value)) roots.set(value, versionIn(value))
  }
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files'
  const toolkits = join(programFiles, 'NVIDIA GPU Computing Toolkit', 'CUDA')
  for (const name of await list(toolkits)) {
    const root = join(toolkits, name)
    if (!roots.has(root)) roots.set(root, versionIn(name))
  }
  return [...roots.entries()]
    .filter(([, toolkit]) => satisfies(toolkit, wanted))
    .sort((a, b) => (a[1] as Toolkit).minor - (b[1] as Toolkit).minor)
    .flatMap(([root]) => [join(root, 'bin', 'x64'), join(root, 'bin')])
}

/** Download archives into a scratch folder, extract them, and copy `names` out if all are inside. */
async function fromArchives(
  items: Array<Omit<DownloadItem, 'save_path'> & { name: string }>,
  binDir: string,
  names: readonly string[],
  deps: CudaRuntimeDeps
): Promise<boolean> {
  const scratch = join(deps.layout.provider('llamacpp-upstream').tmpDir, `cuda-runtime-${Date.now()}`)
  await mkdir(scratch, { recursive: true })
  try {
    const download: DownloadItem[] = items.map(({ name, ...item }) => ({
      ...item,
      save_path: join(scratch, name),
      ...(deps.proxy ? { proxy: deps.proxy } : {}),
    }))
    await deps.downloader.download(deps.taskId, download)
    const found = new Map<string, string>()
    for (const [i, item] of items.entries()) {
      const out = join(scratch, `x${i}`)
      await mkdir(out, { recursive: true })
      await extractArchive(join(scratch, item.name), out)
      const stack = [out]
      while (stack.length > 0) {
        const dir = stack.pop() as string
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name)
          if (entry.isDirectory()) stack.push(path)
          else if (entry.name.toLowerCase().endsWith('.dll')) found.set(entry.name.toLowerCase(), path)
        }
      }
    }
    const sources = names.map((name) => found.get(name.toLowerCase()))
    if (sources.some((s) => s === undefined)) return false
    await mkdir(binDir, { recursive: true })
    for (const [i, name] of names.entries()) await copyFile(sources[i] as string, join(binDir, name))
    return true
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

interface RedistEntry {
  relative_path: string
  sha256: string
  size: string | number
}

/** NVIDIA's cudart + cuBLAS archives for the nearest release of the same major, or nothing. */
export async function nvidiaRedistArchives(
  wanted: Toolkit,
  fetchImpl: typeof fetch
): Promise<Array<{ url: string; sha256: string; size: number; name: string }> | undefined> {
  const index = await fetchImpl(`${NVIDIA_CUDA_REDIST_BASE}/`)
  if (!index.ok) return undefined
  const releases = [
    ...new Set([...(await index.text()).matchAll(/redistrib_(\d+)\.(\d+)\.(\d+)\.json/g)].map((m) => m[0])),
  ]
    .map((file) => {
      const [, ma, mi, pa] = /redistrib_(\d+)\.(\d+)\.(\d+)\.json/.exec(file) as RegExpExecArray
      return { file, major: Number(ma), minor: Number(mi), patch: Number(pa) }
    })
    .filter((r) => r.major === wanted.major && r.minor >= wanted.minor)
    // The same minor's newest patch first, then the next minors up.
    .sort((a, b) => a.minor - b.minor || b.patch - a.patch)
  for (const release of releases) {
    const res = await fetchImpl(`${NVIDIA_CUDA_REDIST_BASE}/${release.file}`)
    if (!res.ok) continue
    const manifest = (await res.json()) as Record<string, Record<string, RedistEntry | undefined> | undefined>
    const cudart = manifest['cuda_cudart']?.['windows-x86_64']
    const cublas = manifest['libcublas']?.['windows-x86_64']
    if (!cudart?.relative_path || !cublas?.relative_path || !cudart.sha256 || !cublas.sha256) continue
    return [cudart, cublas].map((entry) => ({
      url: `${NVIDIA_CUDA_REDIST_BASE}/${entry.relative_path}`,
      sha256: entry.sha256,
      size: Number(entry.size),
      name: entry.relative_path.split('/').pop() as string,
    }))
  }
  return undefined
}

/**
 * Make `target` carry its whole CUDA runtime; answer where it came from. Not a CUDA pack, or not
 * Windows: `'present'` with nothing done. Throws `ENGINE_BINARY_BROKEN` naming the missing DLLs and
 * every source tried when none could supply them.
 */
export async function deliverWindowsCudaRuntime(
  target: CudaRuntimeTarget,
  deps: CudaRuntimeDeps
): Promise<CudaRuntimeSource> {
  const toolkitText = cudaToolkitOfPack(target.provider, target.backend)
  const wanted = parseToolkit(toolkitText)
  if (!toolkitText || !wanted) return 'present'
  const list = deps.listDir ?? defaultList
  const binDir = join(target.packDir, 'build', 'bin')
  const arch = archOfPack(target.provider, target.backend)
  const missing = () => missingWindowsCudaRuntimeDlls(binDir, toolkitText, list)
  const tried: string[] = []
  const log = (source: CudaRuntimeSource, from: string) =>
    deps.log?.(`CUDA runtime for ${target.version}/${target.backend}: ${source} (${from})`)

  let need = await missing()
  if (need.length === 0) return 'present'
  const runtimeDlls = windowsCudaRuntimeDlls(toolkitText) ?? need

  for (const dir of await localDonors(target, wanted, arch, deps, list)) {
    if (await copyAllFrom(dir, binDir, runtimeDlls, list)) {
      log('installed-pack', dir)
      return 'installed-pack'
    }
  }
  tried.push('installed packs')

  for (const dir of await hostToolkitDirs(wanted, deps.env ?? process.env, list)) {
    if (await copyAllFrom(dir, binDir, runtimeDlls, list)) {
      log('host-toolkit', dir)
      return 'host-toolkit'
    }
  }
  tried.push('CUDA toolkit on this computer')

  const attempt = async (
    source: CudaRuntimeSource,
    label: string,
    items: Array<Omit<DownloadItem, 'save_path'> & { name: string }>
  ): Promise<boolean> => {
    try {
      if (await fromArchives(items, binDir, runtimeDlls, deps)) {
        log(source, label)
        return true
      }
      tried.push(`${label}: did not contain ${runtimeDlls.join(', ')}`)
    } catch (error) {
      if (error instanceof Error && error.message === DOWNLOAD_CANCELLED) throw error
      tried.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return false
  }

  const companion = deps.releaseCompanion
  if (companion) {
    const name = companion.url.split('/').pop() || 'cudart.zip'
    const item = {
      url: companion.url,
      name,
      ...(companion.sha256 ? { sha256: companion.sha256 } : {}),
      ...(companion.size ? { size: companion.size } : {}),
    }
    if (await attempt('release-companion', companion.url, [item])) return 'release-companion'
  }

  if (deps.fetch && arch === 'x64') {
    const archives = await nvidiaRedistArchives(wanted, deps.fetch).catch((error: unknown) => {
      tried.push(`NVIDIA redist manifest: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
    if (archives && (await attempt('nvidia-redist', 'NVIDIA CUDA redistributables', archives)))
      return 'nvidia-redist'
    if (!archives) tried.push('NVIDIA redist: no release for this CUDA version')
  }

  const pinned = PINNED_WINDOWS_CUDA_RUNTIMES.filter(
    (p) => p.arch === arch && satisfies(parseToolkit(p.toolkit), wanted)
  ).sort((a, b) => (parseToolkit(a.toolkit) as Toolkit).minor - (parseToolkit(b.toolkit) as Toolkit).minor)
  for (const p of pinned) {
    if (companion && companion.url === p.url) continue
    const name = p.url.split('/').pop() as string
    if (await attempt('pinned-companion', p.url, [{ url: p.url, name, sha256: p.sha256, size: p.size }]))
      return 'pinned-companion'
  }

  need = await missing()
  if (need.length === 0) need = runtimeDlls
  throw new AtomicCoreError(
    'ENGINE_BINARY_BROKEN',
    `The ${target.version}/${target.backend} backend is missing its CUDA runtime (${need.join(', ')}) and it could not be downloaded. Check the connection and install the backend again, or install the NVIDIA CUDA Toolkit ${toolkitText}.`,
    `tried: ${tried.join('; ')}`
  )
}
