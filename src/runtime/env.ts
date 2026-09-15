/**
 * Environment of a spawned backend process. Port of `setup_library_path`, `add_cuda_paths` and
 * `binary_requires_cuda` in `src-tauri/utils/src/system.rs`, as pure functions over injected facts.
 *
 * Deliberate deviation (PLAN.md §2 decision 15): on Windows the Rust code rebuilt `PATH` twice from
 * the *process* environment, so the CUDA directories were overwritten by the binary directory. Here
 * both are prepended: `<exe dir>;<cuda bins...>;<PATH>`.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface CudaPaths {
  /** Directories with CUDA libraries (Linux → LD_LIBRARY_PATH). */
  libDirs: string[]
  /** Directories with CUDA binaries/DLLs (→ PATH). */
  binDirs: string[]
}

/** The real filesystem probe used outside tests; `discoverCudaPaths` takes the seams instead of fs. */
export function nodeCudaProbeEnv(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): CudaProbeEnv {
  return {
    platform,
    env,
    exists: (path) => existsSync(path),
    listDir: (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name)
      } catch {
        return []
      }
    },
  }
}

export interface CudaProbeEnv {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  exists: (path: string) => boolean
  /** Directory names inside `dir`; [] when unreadable. */
  listDir: (dir: string) => string[]
}

const LINUX_COMMON_LIB_DIRS = [
  '/usr/local/cuda/lib64',
  '/usr/local/cuda/lib',
  '/usr/lib/cuda/lib64',
  '/usr/lib/cuda/lib',
  '/opt/cuda/lib64',
  '/opt/cuda/lib',
  '/usr/lib/x86_64-linux-gnu',
  '/usr/lib/x86_64-linux-gnu/nvidia',
]

/** Where a CUDA runtime might live on this host. Sorted, deduplicated, existing paths only. */
export function discoverCudaPaths(e: CudaProbeEnv): CudaPaths {
  const libs = new Set<string>()
  const bins = new Set<string>()
  if (e.platform === 'win32') {
    const cudaPath = e.env['CUDA_PATH']
    if (cudaPath) {
      const bin = `${cudaPath}\\bin`
      if (e.exists(bin)) bins.add(bin)
    }
    for (const [key, value] of Object.entries(e.env)) {
      if (key.startsWith('CUDA_PATH_V') && value) {
        const bin = `${value}\\bin`
        if (e.exists(bin)) bins.add(bin)
      }
    }
    const programFiles = e.env['ProgramFiles'] ?? 'C:\\Program Files'
    const toolkit = `${programFiles}\\NVIDIA GPU Computing Toolkit\\CUDA`
    for (const name of e.listDir(toolkit)) {
      const bin = `${toolkit}\\${name}\\bin`
      if (e.exists(bin)) bins.add(bin)
    }
  } else if (e.platform === 'linux') {
    const home = e.env['CUDA_HOME'] ?? e.env['CUDA_PATH']
    if (home) {
      for (const sub of ['lib64', 'lib']) if (e.exists(`${home}/${sub}`)) libs.add(`${home}/${sub}`)
      if (e.exists(`${home}/bin`)) bins.add(`${home}/bin`)
    }
    for (const p of LINUX_COMMON_LIB_DIRS) if (e.exists(p)) libs.add(p)
    for (const name of e.listDir('/usr/local')) {
      if (!name.startsWith('cuda-')) continue
      for (const sub of ['lib64', 'lib', 'bin']) {
        const p = `/usr/local/${name}/${sub}`
        if (!e.exists(p)) continue
        if (sub === 'bin') bins.add(p)
        else libs.add(p)
      }
    }
  }
  return { libDirs: [...libs].sort(), binDirs: [...bins].sort() }
}

/** CUDA library names that make a binary depend on a CUDA runtime, per platform probe. */
export function textMentionsCudaRuntime(text: string, platform: NodeJS.Platform, viaLdd = false): boolean {
  if (platform === 'win32') {
    return ['cudart', 'cublas', 'cufft', 'curand', 'cusparse', 'cusolver', 'cudnn'].some((n) =>
      text.includes(n)
    )
  }
  if (platform === 'linux') {
    const names = viaLdd
      ? ['libcudart', 'libcublas', 'libcufft', 'libcurand', 'libcusparse', 'libcusolver', 'libcudnn']
      : ['libcudart', 'libcublas', 'libcufft']
    return names.some((n) => text.includes(n))
  }
  return false
}

export interface ProcessEnvInput {
  platform: NodeJS.Platform
  baseEnv: NodeJS.ProcessEnv
  /** Directory of the backend executable (added to the library path; cwd on Windows). */
  exeDir: string
  cuda: CudaPaths
  /** Caller-supplied variables (`LLAMA_API_KEY`, user `llamacpp_env`); applied first, overridable by the path setup. */
  userEnv: Record<string, string>
}

export interface ProcessEnvResult {
  env: Record<string, string>
  cwd: string | undefined
  /** True when CUDA directories were found and injected. */
  cudaFound: boolean
}

/** Strip the Windows verbatim prefix the way the Rust code does before putting a dir on PATH. */
export function stripVerbatimPrefix(dir: string): string {
  return dir.startsWith('\\\\?\\') ? dir.slice(4) : dir
}

const prepend = (items: string[], existing: string | undefined, sep: string): string => {
  const rest = (existing ?? '').replace(new RegExp(`\\${sep}+$`), '')
  return rest === '' ? items.join(sep) : `${items.join(sep)}${sep}${rest}`
}

export function buildProcessEnv(input: ProcessEnvInput): ProcessEnvResult {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.baseEnv)) if (v !== undefined) env[k] = v
  Object.assign(env, input.userEnv)
  const cudaFound = input.cuda.libDirs.length > 0 || input.cuda.binDirs.length > 0
  let cwd: string | undefined
  switch (input.platform) {
    case 'linux': {
      const libs = [input.exeDir, ...input.cuda.libDirs]
      env['LD_LIBRARY_PATH'] = prepend(libs, env['LD_LIBRARY_PATH'], ':')
      if (input.cuda.binDirs.length) env['PATH'] = prepend(input.cuda.binDirs, env['PATH'], ':')
      break
    }
    case 'win32': {
      const dir = stripVerbatimPrefix(input.exeDir)
      env['PATH'] = prepend([dir, ...input.cuda.binDirs], env['PATH'] ?? env['Path'], ';')
      delete env['Path']
      cwd = input.exeDir
      break
    }
    case 'darwin': {
      env['DYLD_LIBRARY_PATH'] = prepend([input.exeDir], env['DYLD_LIBRARY_PATH'], ':')
      break
    }
    default:
      break
  }
  return { env, cwd, cudaFound }
}

/** `<exe dir>` from a full executable path, platform-agnostic. */
export function exeDirOf(exePath: string): string {
  const i = Math.max(exePath.lastIndexOf('/'), exePath.lastIndexOf('\\'))
  return i < 0 ? '.' : exePath.slice(0, i)
}

/** Join for the platform of the path rather than the host (used in tests and cross-platform planning). */
export function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? parts.join('\\') : join(...parts)
}
