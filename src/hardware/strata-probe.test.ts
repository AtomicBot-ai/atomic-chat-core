import { expect, it } from 'vitest'
import { nodeProbeDeps } from './probe.js'
import { probeStrataHost } from './strata-probe.js'
import type { SystemInfo } from '../contracts/index.js'
const info: SystemInfo = {
  os_type: 'linux',
  os_name: 'Ubuntu 24.04',
  total_memory: 131072,
  cpu: {
    name: 'Grace',
    arch: 'aarch64',
    core_count: 20,
    extensions: ['asimddp', 'asimdhp', 'i8mm'],
    extensions_known: true,
  },
  gpus: [
    {
      name: 'GB10',
      uuid: 'gpu',
      vendor: 'NVIDIA',
      driver_version: '580.65',
      total_memory: 131072,
      nvidia_info: { index: 0, compute_capability: '12.1' },
      vulkan_info: null,
    },
  ],
}
it('confirms Spark by device tree and reads distro/glibc without a shell', async () => {
  const calls: unknown[] = []
  const deps = nodeProbeDeps({
    platform: 'linux',
    arch: 'arm64',
    run: async (file, args) => {
      calls.push([file, args])
      return { code: 0, stdout: 'glibc 2.39\n', stderr: '' }
    },
  })
  deps.fs = {
    ...deps.fs,
    readFile: async (path) =>
      path === '/etc/os-release' ? 'ID=ubuntu\nVERSION_ID="24.04"\n' : 'NVIDIA DGX Spark\0',
  }
  expect(await probeStrataHost(info, deps)).toMatchObject({
    osVersion: '24.04',
    distribution: 'ubuntu',
    glibcVersion: '2.39',
    devices: [{ family: 'dgx-spark', unified: true }],
    cpuFeatures: ['dotprod', 'fp16', 'i8mm'],
  })
  expect(calls).toEqual([['getconf', ['GNU_LIBC_VERSION']]])
  deps.fs.readFile = async () => {
    throw new Error('missing')
  }
  expect((await probeStrataHost(info, deps)).devices[0]!.family).toBeUndefined()
})
it('keeps an unavailable OS/ABI measurement unknown', async () => {
  const deps = nodeProbeDeps({
    platform: 'linux',
    run: async () => {
      throw new Error('missing')
    },
  })
  deps.fs = {
    ...deps.fs,
    readFile: async () => {
      throw new Error('missing')
    },
  }
  expect(await probeStrataHost(info, deps)).not.toHaveProperty('osVersion')
  expect(await probeStrataHost(info, deps)).not.toHaveProperty('glibcVersion')
})

it('matches Linux HIP ordinals by PCI address and keeps CPU nodes out of the count', async () => {
  const amd: SystemInfo = {
    ...info,
    cpu: { ...info.cpu, arch: 'x86_64' },
    gpus: [
      {
        name: 'AMD',
        uuid: '0000:03:00.0',
        vendor: 'AMD',
        driver_version: '',
        total_memory: 16384,
        nvidia_info: null,
        vulkan_info: null,
      },
    ],
  }
  const deps = nodeProbeDeps({
    platform: 'linux',
    arch: 'x64',
    run: async () => ({ code: 0, stdout: 'glibc 2.39', stderr: '' }),
  })
  deps.fs = {
    ...deps.fs,
    readdir: async () => ['3', '1', '0'],
    readFile: async (path) => {
      if (path.endsWith('/0/properties')) return 'simd_count 0\n'
      if (path.endsWith('/1/properties'))
        return 'gfx_target_version 110000\nsimd_count 4\ndrm_render_minor 128\n'
      if (path.endsWith('/3/properties'))
        return 'gfx_target_version 120001\nsimd_count 4\ndrm_render_minor 129\n'
      return 'ID=ubuntu\nVERSION_ID="24.04"\n'
    },
    readlink: async (path) =>
      path.includes('renderD129') ? '../../../0000:03:00.0' : '../../../0000:02:00.0',
  }
  expect((await probeStrataHost(amd, deps)).devices).toMatchObject([{ architecture: 'gfx1201', ordinal: 1 }])
})

it('maps Intel Arc to a unique Level Zero ordinal and rejects ambiguous listings', async () => {
  const arc: SystemInfo = {
    ...info,
    cpu: { ...info.cpu, arch: 'x86_64' },
    gpus: [
      {
        name: 'Intel Arc A750 Graphics',
        uuid: '0000:03:00.0',
        vendor: 'Intel',
        driver_version: '',
        total_memory: 8192,
        nvidia_info: null,
        vulkan_info: { device_id: 0x56a1, device_type: 'DiscreteGpu', api_version: '', index: 0 },
      },
    ],
  }
  const row = '[level_zero:gpu:2] Intel(R) Level-Zero, Intel(R) Arc(TM) A750 Graphics 20.1 [1.6.0]\n'
  let listing = '[opencl:gpu:0] Intel OpenCL, Intel Arc A750 Graphics 3.0\n' + row
  const deps = nodeProbeDeps({
    platform: 'linux',
    arch: 'x64',
    run: async (file) => ({ code: 0, stdout: file === 'sycl-ls' ? listing : 'glibc 2.39', stderr: '' }),
  })
  deps.fs = { ...deps.fs, readFile: async () => 'ID=ubuntu\nVERSION_ID="24.04"\n' }
  expect((await probeStrataHost(arc, deps)).devices).toMatchObject([{ ordinal: 2 }])
  listing += row.replace(':2]', ':3]')
  expect((await probeStrataHost(arc, deps)).devices[0]).not.toHaveProperty('ordinal')
})
