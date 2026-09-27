import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import { failed, fakeProbeDeps, ok } from '../../test/helpers/fake-probe-deps.js'
import type { FakeProbeScript } from '../../test/helpers/fake-probe-deps.js'
import { probeLinux, prettyName } from './probe-linux.js'

const OS_RELEASE = 'PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\n'
const DRM = '/sys/class/drm'

/** A desktop: Ryzen 7950X, RTX 4090 on the nvidia driver, Intel iGPU on i915, both ICDs, vulkaninfo installed. */
const desktop = (): FakeProbeScript => ({
  platform: 'linux',
  arch: 'x64',
  env: { HOME: '/home/u' },
  totalmem: 64 * 2 ** 30,
  cpus: Array.from({ length: 32 }, () => ({ model: 'AMD Ryzen 9 7950X 16-Core Processor' })),
  files: {
    '/proc/cpuinfo': readHardwareFixture('proc-cpuinfo-ryzen-7950x.txt'),
    '/etc/os-release': OS_RELEASE,
    [`${DRM}/card0/device/vendor`]: '0x10de\n',
    [`${DRM}/card0/device/device`]: '0x2684\n',
    [`${DRM}/card0/device/boot_vga`]: '1\n',
    [`${DRM}/card1/device/vendor`]: '0x8086\n',
    [`${DRM}/card1/device/device`]: '0xa780\n',
    [`${DRM}/card1/device/boot_vga`]: '0\n',
  },
  dirs: {
    [DRM]: [
      'card0',
      'card0-DP-1',
      'card0-HDMI-A-1',
      'card1',
      'card1-eDP-1',
      'renderD128',
      'renderD129',
      'version',
    ],
    '/usr/share/vulkan/icd.d': [
      'nvidia_icd.json',
      'intel_icd.x86_64.json',
      'intel_hasvk_icd.x86_64.json',
      'lvp_icd.x86_64.json',
      'README',
    ],
    '/home/u/.local/share/vulkan/icd.d': [],
  },
  links: {
    [`${DRM}/card0/device`]: '../../../0000:01:00.0',
    [`${DRM}/card0/device/driver`]: '../../../../bus/pci/drivers/nvidia',
    [`${DRM}/card1/device`]: '../../../0000:00:02.0',
    [`${DRM}/card1/device/driver`]: '../../../../bus/pci/drivers/i915',
  },
  tools: {
    'nvidia-smi': ok(readHardwareFixture('nvidia-smi-rtx4090-rtx3060-modern.csv').split('\n')[0] + '\n'),
    'vulkaninfo': ok(readHardwareFixture('vulkaninfo-summary-linux-rtx4090-intel-llvmpipe.txt')),
  },
})

describe('probeLinux', () => {
  it('assembles a desktop from cpuinfo, os-release, sysfs, the ICDs, nvidia-smi and vulkaninfo', async () => {
    const deps = fakeProbeDeps(desktop())
    const { info, warnings } = await probeLinux(deps)
    expect(warnings).toEqual([])
    expect(info.cpu).toEqual({
      name: 'AMD Ryzen 9 7950X 16-Core Processor',
      core_count: 3, // the fixture lists core ids 0, 1, 2, 0
      arch: 'x86_64',
      extensions: expect.arrayContaining(['fpu', 'avx', 'avx2', 'avx512_f']),
      extensions_known: true,
    })
    expect(info).toMatchObject({ os_type: 'linux', os_name: 'Ubuntu 24.04.1 LTS', total_memory: 65_536 })
    expect(info.gpus).toEqual([
      {
        name: 'NVIDIA GeForce RTX 4090',
        total_memory: 24_564,
        vendor: 'NVIDIA',
        uuid: '0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
        driver_version: '581.42',
        nvidia_info: { index: 0, compute_capability: '8.9' },
        vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '1.3.277', device_id: 0x2684 },
      },
      {
        name: 'Intel(R) Graphics (RPL-S)',
        total_memory: 0,
        vendor: 'Intel',
        uuid: '0000:00:02.0',
        driver_version: '24.0.9',
        nvidia_info: null,
        vulkan_info: { index: 1, device_type: 'IntegratedGpu', api_version: '1.3.278', device_id: 0xa780 },
      },
    ])
    // Tools run from PATH with the per-tool budget; connectors and render nodes were not read.
    expect(deps.calls).toEqual([
      {
        file: 'nvidia-smi',
        args: [expect.stringMatching(/^--query-gpu=/), '--format=csv,noheader,nounits'],
        timeoutMs: 5_000,
      },
      { file: 'vulkaninfo', args: ['--summary'], timeoutMs: 5_000 },
    ])
  })

  it('reads an arm64 box without GPUs or tools: flags known-empty, nothing to warn about but the missing DRM tree', async () => {
    const deps = fakeProbeDeps({
      platform: 'linux',
      arch: 'arm64',
      cpus: Array.from({ length: 4 }, () => ({ model: 'Neoverse-N1' })),
      files: {
        '/proc/cpuinfo': readHardwareFixture('proc-cpuinfo-graviton-arm64.txt'),
        '/etc/os-release': 'NAME="Amazon Linux"\n',
      },
    })
    const { info, warnings } = await probeLinux(deps)
    expect(info.cpu).toEqual({
      name: 'Neoverse-N1',
      core_count: 4,
      arch: 'arm64',
      extensions: [],
      extensions_known: true,
    })
    expect(info).toMatchObject({ os_name: 'Amazon Linux', gpus: [] })
    expect(warnings).toEqual([expect.stringMatching(/^\/sys\/class\/drm: ENOENT/)])
  })

  it('leaves the flags unknown when cpuinfo is unreadable or has no flags line on x86', async () => {
    const unreadable = await probeLinux(
      fakeProbeDeps({ platform: 'linux', arch: 'x64', dirs: { [DRM]: [] } })
    )
    expect(unreadable.info.cpu).toMatchObject({
      name: 'Fake CPU',
      core_count: 2,
      extensions: [],
      extensions_known: false,
    })
    expect(unreadable.info.os_name).toBe('Linux')
    expect(unreadable.warnings).toEqual([
      expect.stringMatching(/^\/proc\/cpuinfo: ENOENT/),
      expect.stringMatching(/^\/etc\/os-release: ENOENT/),
    ])
    const flagless = await probeLinux(
      fakeProbeDeps({
        platform: 'linux',
        arch: 'x64',
        files: { '/proc/cpuinfo': 'model name\t: Something\n' },
        dirs: { [DRM]: [] },
      })
    )
    expect(flagless.info.cpu).toMatchObject({ name: 'Something', extensions_known: false })
  })

  it('retries nvidia-smi with the legacy fields where the driver refuses compute_cap, on the candidate that exists', async () => {
    const script = desktop()
    script.tools = {
      '/usr/bin/nvidia-smi': (args) =>
        args[0]?.includes('compute_cap')
          ? failed(2, readHardwareFixture('nvidia-smi-unknown-field.stderr.txt'))
          : ok(readHardwareFixture('nvidia-smi-gtx1080-legacy.csv')),
    }
    const deps = fakeProbeDeps(script)
    const { info, warnings } = await probeLinux(deps)
    expect(info.gpus[0]).toMatchObject({
      name: 'GeForce GTX 1080',
      driver_version: '460.91.03',
      nvidia_info: { compute_capability: '' },
      // Matched to card0 by bus id, so it carries the PCI device id and the guessed type from the ICD.
      vulkan_info: { device_type: 'DiscreteGpu', api_version: '', device_id: 0x2684 },
    })
    // The tools run in parallel, so only the set of runs is stable: PATH miss, refusal, legacy retry, vulkaninfo.
    expect(deps.calls.map((c) => c.file).sort()).toEqual([
      '/usr/bin/nvidia-smi',
      '/usr/bin/nvidia-smi',
      'nvidia-smi',
      'vulkaninfo',
    ])
    expect(warnings).toEqual([])
  })

  it('warns when nvidia-smi or vulkaninfo exist but fail, and still lists the sysfs GPUs', async () => {
    const script = desktop()
    script.tools = {
      'nvidia-smi': failed(
        9,
        "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."
      ),
      'vulkaninfo': failed(1, '', 'ERROR: [Loader Message] Code 0 : vkCreateInstance: Found no drivers!'),
    }
    const { info, warnings } = await probeLinux(fakeProbeDeps(script))
    expect(info.gpus.map((g) => [g.vendor, g.nvidia_info, g.vulkan_info?.device_type])).toEqual([
      ['NVIDIA', null, 'DiscreteGpu'],
      ['Intel', null, 'IntegratedGpu'],
    ])
    expect(warnings).toEqual([
      "nvidia-smi: nvidia-smi exited with 9: NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.",
      'vulkaninfo: vulkaninfo exited with 1: ERROR: [Loader Message] Code 0 : vkCreateInstance: Found no drivers!',
      'NVIDIA GPU 0x2684: NVIDIA GPU without an nvidia-smi answer; driver version and compute capability unknown',
    ])
  })

  it('treats a hung vulkaninfo as a warning and a missing one as silence', async () => {
    const script = desktop()
    script.tools = { vulkaninfo: new Error('vulkaninfo did not finish in 5000 ms') }
    const hung = await probeLinux(fakeProbeDeps(script))
    expect(hung.warnings).toEqual([
      'vulkaninfo: vulkaninfo did not finish in 5000 ms',
      expect.stringMatching(/^NVIDIA GPU 0x2684/),
    ])
    script.tools = {}
    const missing = await probeLinux(fakeProbeDeps(script))
    expect(missing.warnings).toEqual([expect.stringMatching(/^NVIDIA GPU 0x2684/)])
  })

  it('skips DRM nodes without PCI ids and reads amdgpu VRAM', async () => {
    const deps = fakeProbeDeps({
      platform: 'linux',
      files: {
        [`${DRM}/card0/device/vendor`]: '0x1002\n',
        [`${DRM}/card0/device/device`]: '0x744c\n',
        [`${DRM}/card0/device/mem_info_vram_total`]: '25753026560\n',
        [`${DRM}/card2/device/vendor`]: 'garbage\n',
        [`${DRM}/card2/device/device`]: '0x1\n',
      },
      dirs: { [DRM]: ['card2', 'card1', 'card0'], '/usr/share/vulkan/icd.d': ['radeon_icd.x86_64.json'] },
      links: {
        [`${DRM}/card0/device`]: '../../../0000:03:00.0',
        [`${DRM}/card0/device/driver`]: '../../../../bus/pci/drivers/amdgpu',
      },
    })
    const { info } = await probeLinux(deps)
    expect(info.gpus).toEqual([
      {
        name: 'AMD GPU 0x744c',
        total_memory: 24_560,
        vendor: 'AMD',
        uuid: '0000:03:00.0',
        driver_version: '',
        nvidia_info: null,
        vulkan_info: { index: 0, device_type: 'Unknown', api_version: '', device_id: 0x744c },
      },
    ])
  })
})

describe('prettyName', () => {
  it.each([
    ['PRETTY_NAME="Ubuntu 24.04.1 LTS"\nNAME="Ubuntu"\n', 'Ubuntu 24.04.1 LTS'],
    ["NAME='Arch Linux'\nPRETTY_NAME='Arch Linux'\n", 'Arch Linux'],
    ['NAME=Fedora\nVERSION_ID=40\n', 'Fedora'],
    ['PRETTY_NAME=""\nNAME="X"\n', 'X'],
    ['ID=nothing\n', undefined],
  ])('%j → %s', (text, expected) => expect(prettyName(text)).toBe(expected))
})
