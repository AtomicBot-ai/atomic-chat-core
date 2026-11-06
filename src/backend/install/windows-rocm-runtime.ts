/** Complete upstream Windows HIP packs from AMD's matching portable runtime, without a host SDK. */
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { AtomicCoreError, type GpuProbeInfo } from '../../contracts/index.js'
import { extractArchive, type Downloader, type ProxyConfig } from '../../downloads/index.js'
import { buildProcessEnv, discoverCudaPaths, nodeCudaProbeEnv } from '../../runtime/shared/index.js'
import { parseDeviceOutput } from '../../runtime/llamacpp/index.js'
import { windowsRocmPackages, WINDOWS_ROCM_VERSION } from './windows-rocm-packages.js'
import { verifyRocmWheel } from './windows-rocm-wheel.js'

export interface RocmRuntimeTarget {
  provider: string
  backend: string
  packDir: string
}
export interface RocmRuntimeDeps {
  gpus: readonly GpuProbeInfo[]
  downloader: Pick<Downloader, 'download'>
  taskId: string
  proxy?: ProxyConfig | null
  env?: NodeJS.ProcessEnv
  beforeWrite?: () => Promise<void>
  verify?: (packDir: string) => Promise<void>
}

async function verifyGpu(packDir: string, baseEnv: NodeJS.ProcessEnv): Promise<void> {
  const bin = join(packDir, 'build', 'bin')
  const { env, cwd } = buildProcessEnv({
    platform: 'win32',
    baseEnv,
    exeDir: bin,
    cuda: discoverCudaPaths(nodeCudaProbeEnv('win32', baseEnv)),
    userEnv: {},
  })
  try {
    const { stdout, stderr } = await promisify(execFile)(join(bin, 'llama-server.exe'), ['--list-devices'], {
      env,
      cwd,
      windowsHide: true,
      timeout: 60000,
    })
    if (parseDeviceOutput(`${stdout}\n${stderr}`).some((device) => /^ROCm\d+$/i.test(device.id))) return
    throw new Error(`${stdout}\n${stderr}`.slice(-1200))
  } catch (error) {
    throw new AtomicCoreError(
      'GPU_BACKEND_INCOMPATIBLE',
      'The ROCm runtime was downloaded but HIP could not enumerate an AMD GPU. Update the AMD graphics driver or select Vulkan.',
      String(error)
    )
  }
}

export async function deliverWindowsRocmRuntime(
  target: RocmRuntimeTarget,
  deps: RocmRuntimeDeps
): Promise<void> {
  if (target.provider !== 'llamacpp-upstream' || !/^win-rocm-(?:\d+\.\d+-)?x64$/.test(target.backend)) return
  // Older/self-contained HIP bundles retain their existing runtime; never inject a mismatched ABI.
  if (
    target.backend !== 'win-rocm-10.0-x64' &&
    (
      await Promise.all(
        ['hipblas.dll', 'rocblas.dll'].map((name) =>
          stat(join(target.packDir, 'build/bin', name))
            .then((s) => s.isFile())
            .catch(() => false)
        )
      )
    ).every(Boolean)
  )
    return
  const packages = windowsRocmPackages(target.backend, deps.gpus)
  const names = packages.map((p) => p.name)
  const required = [
    ...['hipblas', 'rocblas', 'rocsolver', 'libhipblaslt', 'origami'].map((name) => `build/bin/${name}.dll`),
    ...names
      .filter((name) => name.startsWith('rocm_sdk_device_'))
      .map((name) => `build/.kpack/blas_lib_${name.slice('rocm_sdk_device_'.length)}.kpack`),
  ]
  const receipt = join(target.packDir, 'rocm-runtime.json')
  const expected = JSON.stringify({ version: WINDOWS_ROCM_VERSION, packages: names })
  if (
    (await readFile(receipt, 'utf8').catch(() => '')) === expected &&
    (
      await Promise.all(
        required.map((path) =>
          stat(join(target.packDir, path))
            .then((s) => s.isFile() && s.size > 0)
            .catch(() => false)
        )
      )
    ).every(Boolean)
  )
    return
  await deps.beforeWrite?.()
  await mkdir(target.packDir, { recursive: true })
  const staging = await mkdtemp(join(target.packDir, '.rocm-incoming-'))
  try {
    await deps.downloader.download(
      deps.taskId,
      packages.map((p) => ({
        url: p.url,
        save_path: join(staging, `${p.name}.whl`),
        ...(p.sha256 ? { sha256: p.sha256 } : {}),
        ...(p.size ? { size: p.size } : {}),
        ...(deps.proxy ? { proxy: deps.proxy } : {}),
      }))
    )
    // Verify every package before publishing any file. Keep bin/.kpack relative paths intact:
    // copying only DLLs enumerates the GPU but fails when rocBLAS actually executes a kernel.
    for (const p of packages) {
      const dir = join(staging, p.name)
      await extractArchive(join(staging, `${p.name}.whl`), dir, true)
      await verifyRocmWheel(dir, p.name, WINDOWS_ROCM_VERSION)
    }
    // A failed repair must not leave an old success receipt behind.
    await rm(receipt, { force: true })
    for (const p of packages) {
      const dir = join(staging, p.name)
      await cp(join(dir, '_rocm_sdk_libraries'), join(target.packDir, 'build'), { recursive: true })
      // Preserve the original package metadata, RECORD and any upstream notices alongside the pack.
      for (const entry of await readdir(dir))
        if (entry !== '_rocm_sdk_libraries') {
          await cp(join(dir, entry), join(target.packDir, 'rocm-metadata', entry), { recursive: true })
        }
    }
    if (
      !(
        await Promise.all(
          required.map((path) =>
            stat(join(target.packDir, path))
              .then((s) => s.isFile() && s.size > 0)
              .catch(() => false)
          )
        )
      ).every(Boolean)
    ) {
      throw new AtomicCoreError('ENGINE_BINARY_BROKEN', 'The downloaded ROCm runtime is incomplete.')
    }
    await (deps.verify ?? ((dir) => verifyGpu(dir, deps.env ?? process.env)))(target.packDir)
    await writeFile(receipt, expected)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
