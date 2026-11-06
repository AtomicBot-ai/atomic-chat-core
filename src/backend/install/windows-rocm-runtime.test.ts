import { createHash } from 'node:crypto'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { storedZipFiles } from '../../../test/helpers/backend-install-e2e.js'
import { makeTmpDataFolder, type TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { BackendService } from './service.js'
import { deliverWindowsRocmRuntime } from './windows-rocm-runtime.js'
import { windowsRocmPackages } from './windows-rocm-packages.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('rocm-runtime-')
})
afterEach(() => data.cleanup())
const gpu = { vendor: 'AMD', vulkan_info: { device_id: 0x1114 } }
const backend = 'win-rocm-10.0-x64'
const target = () => ({ provider: 'llamacpp-upstream', backend, packDir: join(data.root, 'pack') })

function wheel(device: boolean, corrupt = false) {
  const files = device
    ? { '.kpack/blas_lib_gfx1152.kpack': 'kernels', 'bin/rocblas/library/Tensile.dat': 'data' }
    : Object.fromEntries(
        ['hipblas', 'rocblas', 'rocsolver', 'libhipblaslt', 'origami'].map((n) => [`bin/${n}.dll`, n])
      )
  const name = device ? 'rocm_sdk_device_gfx1152' : 'rocm_sdk_libraries'
  const entries = Object.entries(files).map(([path, value]) => ({
    name: `_rocm_sdk_libraries/${path}`,
    data: Buffer.from(value),
  }))
  const record = entries
    .map(
      (e) => `${e.name},sha256=${createHash('sha256').update(e.data).digest('base64url')},${e.data.length}`
    )
    .join('\n')
  entries.push({
    name: `${name}-10.0.0.dist-info/RECORD`,
    data: Buffer.from(record + `\n${name}-10.0.0.dist-info/RECORD,,\n`),
  })
  entries.push({ name: `${name}-10.0.0.dist-info/METADATA`, data: Buffer.from('') })
  // METADATA is a payload too; a missing RECORD entry is deliberately rejected.
  entries[entries.length - 2]!.data = Buffer.from(
    record +
      `\n${name}-10.0.0.dist-info/METADATA,sha256=${createHash('sha256').digest('base64url')},0\n${name}-10.0.0.dist-info/RECORD,,\n`
  )
  if (corrupt) entries[0]!.data = Buffer.from('corrupted')
  return storedZipFiles(entries.map((e) => [e.name, e.data]))
}
function deps(corrupt = false) {
  return {
    gpus: [gpu],
    taskId: 'install-rocm',
    proxy: { url: 'http://proxy.test:8080' },
    downloader: {
      download: vi.fn(async (_task: string, items: { url: string; save_path: string }[]) => {
        for (const item of items) await writeFile(item.save_path, wheel(item.url.includes('device'), corrupt))
      }),
    },
    verify: vi.fn(async () => {}),
  }
}

it('selects a pinned ABI and deduplicated packages for every known AMD GPU', () => {
  const packages = windowsRocmPackages(backend, [
    gpu,
    gpu,
    { vendor: 'AMD', vulkan_info: { device_id: 0x744c } },
  ])
  expect(packages.map((p) => p.name)).toEqual([
    'rocm_sdk_libraries',
    'rocm_sdk_device_gfx1100',
    'rocm_sdk_device_gfx1152',
  ])
  expect(packages.every((p) => p.url.includes('-10.0.0-py3-none-win_amd64.whl'))).toBe(true)
  expect(() => windowsRocmPackages('win-rocm-7.14-x64', [gpu])).toThrow(/supported runtime/)
  expect(() => windowsRocmPackages(backend, [{ vendor: 'AMD', vulkan_info: { device_id: 0xffff } }])).toThrow(
    /GPU architecture/
  )
})

it('installs DLLs and relative kernel trees with one task and proxy, then skips repeated work', async () => {
  const d = deps()
  await deliverWindowsRocmRuntime(target(), d)
  expect(await readFile(join(target().packDir, 'build/bin/hipblas.dll'), 'utf8')).toBe('hipblas')
  expect(await readFile(join(target().packDir, 'build/.kpack/blas_lib_gfx1152.kpack'), 'utf8')).toBe(
    'kernels'
  )
  expect(await readFile(join(target().packDir, 'build/bin/rocblas/library/Tensile.dat'), 'utf8')).toBe('data')
  expect(d.downloader.download).toHaveBeenCalledWith(
    'install-rocm',
    expect.arrayContaining([expect.objectContaining({ proxy: d.proxy })])
  )
  expect(d.verify).toHaveBeenCalledTimes(1)
  await deliverWindowsRocmRuntime(target(), d)
  expect(d.downloader.download).toHaveBeenCalledTimes(1)
  expect(d.verify).toHaveBeenCalledTimes(1)
  await rm(join(target().packDir, 'build/bin/hipblas.dll'))
  await deliverWindowsRocmRuntime(target(), d)
  expect(d.downloader.download).toHaveBeenCalledTimes(2)
})

it('rejects corrupt wheel payload before publishing DLLs and cleans staging', async () => {
  await expect(deliverWindowsRocmRuntime(target(), deps(true))).rejects.toThrow(/integrity/)
  expect(await readdir(target().packDir)).toEqual([])
})

it('does not mark a CPU-only launch as ready and permits a later retry', async () => {
  const d = deps()
  d.verify.mockRejectedValueOnce(new Error('No ROCm GPU'))
  await expect(deliverWindowsRocmRuntime(target(), d)).rejects.toThrow('No ROCm GPU')
  await expect(readFile(join(target().packDir, 'rocm-runtime.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await deliverWindowsRocmRuntime(target(), d)
  expect(d.verify).toHaveBeenCalledTimes(2)
})

it('does not touch non-ROCm or self-contained Prism packs', async () => {
  const d = deps()
  await deliverWindowsRocmRuntime({ ...target(), backend: 'win-vulkan-x64' }, d)
  await deliverWindowsRocmRuntime({ ...target(), provider: 'atomic-prism' }, d)
  expect(d.downloader.download).not.toHaveBeenCalled()
})

it('refuses to alter a pack in use before downloading', async () => {
  const d = {
    ...deps(),
    beforeWrite: async () => {
      throw new Error('in use')
    },
  }
  await expect(deliverWindowsRocmRuntime(target(), d)).rejects.toThrow('in use')
  expect(d.downloader.download).not.toHaveBeenCalled()
})

it('repairs an existing upstream installation through BackendService without downloading llama.cpp again', async () => {
  await data.writeBackend('llamacpp-upstream', 'b12019', backend)
  const d = deps()
  const service = new BackendService({
    layout: data.layout,
    provider: 'llamacpp-upstream',
    downloader: d.downloader as never,
    platform: 'win32',
    readManifest: async () => null,
    readGpus: async () => [gpu],
    verifyRocmBackend: d.verify,
  })
  const result = await service.install('b12019', backend, { taskId: d.taskId, proxy: d.proxy })
  expect(result.installed).toBe(false)
  expect(await readFile(join(result.path, 'build/bin/hipblas.dll'), 'utf8')).toBe('hipblas')
  expect(d.downloader.download).toHaveBeenCalledTimes(1)
  expect(
    d.downloader.download.mock.calls[0]![1].every((item) => new URL(item.url).pathname.endsWith('.whl'))
  ).toBe(true)
})

it('keeps the old pack when a staged ROCm installation cannot enumerate a GPU', async () => {
  const exe = await data.writeBackend('llamacpp-upstream', 'b12019', backend, 'previous executable')
  const d = deps()
  const download = d.downloader.download.getMockImplementation()!
  d.downloader.download.mockImplementation(async (task, items) => {
    if (items[0]?.url.endsWith('.zip')) {
      await writeFile(
        items[0].save_path,
        storedZipFiles([['build/bin/llama-server.exe', Buffer.from('new executable')]])
      )
    } else await download(task, items)
  })
  const service = new BackendService({
    layout: data.layout,
    provider: 'llamacpp-upstream',
    downloader: d.downloader as never,
    platform: 'win32',
    readManifest: async () => null,
    readGpus: async () => [gpu],
    verifyRocmBackend: async () => {
      throw new Error('No HIP device')
    },
    verifyWindowsBackend: async () => {},
  })
  await expect(service.install('b12019', backend, { taskId: d.taskId, force: true })).rejects.toThrow(
    'No HIP device'
  )
  expect(await readFile(exe, 'utf8')).toBe('previous executable')
  expect(
    (await readdir(join(data.layout.provider('llamacpp-upstream').backendsDir, 'b12019'))).some((n) =>
      n.includes('incoming')
    )
  ).toBe(false)
})
