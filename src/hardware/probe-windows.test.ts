import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import { failed, fakeProbeDeps, ok } from '../../test/helpers/fake-probe-deps.js'
import { probeWindows } from './probe-windows.js'
import { WINDOWS_PROBE_SCRIPT } from './windows-video.js'

const hybrid = () => ok(readHardwareFixture('windows-probe-hybrid-rtx4090-uhd770.json'))

describe('probeWindows', () => {
  it('assembles the hybrid desktop from one PowerShell run and nvidia-smi, both in parallel', async () => {
    const deps = fakeProbeDeps({
      platform: 'win32',
      arch: 'x64',
      env: { SystemRoot: 'C:\\Windows' },
      totalmem: 32 * 2 ** 30,
      tools: {
        'powershell.exe': hybrid(),
        'C:\\Windows\\System32\\nvidia-smi.exe': ok(
          readHardwareFixture('nvidia-smi-rtx4090-rtx3060-modern.csv').split('\n')[0] + '\n'
        ),
      },
    })
    const { info, warnings } = await probeWindows(deps)
    expect(warnings).toEqual([])
    expect(info.cpu).toEqual({
      name: '13th Gen Intel(R) Core(TM) i9-13900K',
      core_count: 24,
      arch: 'x86_64',
      extensions: ['fpu', 'mmx', 'sse', 'sse2', 'sse3', 'ssse3', 'sse4_1', 'sse4_2', 'avx', 'avx2'],
      extensions_known: true,
    })
    expect(info).toMatchObject({
      os_type: 'windows',
      os_name: 'Microsoft Windows 11 Pro',
      total_memory: 32_768,
    })
    expect(info.gpus).toEqual([
      {
        name: 'NVIDIA GeForce RTX 4090',
        total_memory: 24_564,
        vendor: 'NVIDIA',
        uuid: '0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
        driver_version: '581.42',
        nvidia_info: { index: 0, compute_capability: '8.9' },
        vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '', device_id: 0x2684 },
      },
      {
        name: 'Intel(R) UHD Graphics 770',
        total_memory: 128,
        vendor: 'Intel',
        uuid: 'PCI\\VEN_8086&DEV_4680&SUBSYS_88941043&REV_0C\\3&11583659&0&10',
        driver_version: '32.0.101.6083',
        nvidia_info: null,
        vulkan_info: { index: 1, device_type: 'IntegratedGpu', api_version: '', device_id: 0x4680 },
      },
    ])
    expect(deps.calls[0]).toEqual({
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_PROBE_SCRIPT],
      timeoutMs: 15_000,
    })
    expect(deps.calls.slice(1).map((c) => c.file)).toEqual([
      'nvidia-smi',
      'C:\\Windows\\System32\\nvidia-smi.exe',
    ])
  })

  it('reads the AMD box through the PowerShell 5.1 document: ROCm-relevant device id, flags unknown on an old build', async () => {
    const deps = fakeProbeDeps({
      platform: 'win32',
      tools: { 'powershell.exe': ok(readHardwareFixture('windows-probe-rx7900xtx-ps51.json')) },
    })
    const { info, warnings } = await probeWindows(deps)
    expect(warnings).toEqual([])
    expect(info.cpu).toMatchObject({
      name: 'AMD Ryzen 7 7800X3D 8-Core Processor',
      core_count: 8,
      extensions: [],
      extensions_known: false,
    })
    expect(info.os_name).toBe('Microsoft Windows 10 Pro')
    expect(info.gpus).toEqual([
      {
        name: 'AMD Radeon RX 7900 XTX',
        total_memory: 24_560,
        vendor: 'AMD',
        uuid: 'PCI\\VEN_1002&DEV_744C&SUBSYS_E4711DA2&REV_C8\\6&2D31F8A6&0&00000019',
        driver_version: '32.0.12033.1030',
        nvidia_info: null,
        vulkan_info: { index: 0, device_type: 'Unknown', api_version: '', device_id: 0x744c },
      },
    ])
  })

  it('reads a headless server: no GPUs, flags unknown because Add-Type failed', async () => {
    const deps = fakeProbeDeps({
      platform: 'win32',
      tools: { 'powershell.exe': ok(readHardwareFixture('windows-probe-no-gpu-server2022.json')) },
    })
    const { info, warnings } = await probeWindows(deps)
    expect(info.cpu).toMatchObject({
      name: 'AMD EPYC 7763 64-Core Processor',
      core_count: 4,
      extensions_known: false,
    })
    expect(info.gpus).toEqual([])
    expect(warnings).toEqual([])
    const arm = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        arch: 'arm64',
        tools: { 'powershell.exe': ok(readHardwareFixture('windows-probe-no-gpu-server2022.json')) },
      })
    )
    expect(arm.info.cpu).toMatchObject({ arch: 'arm64', extensions: [], extensions_known: true })
  })

  it('falls back to node:os and nvidia-smi alone when PowerShell fails or answers garbage', async () => {
    const nvidia = ok(readHardwareFixture('nvidia-smi-rtx4090-rtx3060-modern.csv'))
    const failedRun = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        cpus: [{ model: 'Intel Core' }, { model: 'Intel Core' }],
        tools: { 'powershell.exe': failed(1, 'The term is not recognized'), 'nvidia-smi': nvidia },
      })
    )
    expect(failedRun.warnings).toEqual([
      'powershell: powershell.exe exited with 1: The term is not recognized',
    ])
    expect(failedRun.info.cpu).toEqual({
      name: 'Intel Core',
      core_count: 2,
      arch: 'x86_64',
      extensions: [],
      extensions_known: false,
    })
    expect(failedRun.info.os_name).toBe('Windows')
    expect(failedRun.info.gpus.map((g) => [g.name, g.vulkan_info])).toEqual([
      ['NVIDIA GeForce RTX 4090', null],
      ['NVIDIA GeForce RTX 3060', null],
    ])

    const garbage = await probeWindows(
      fakeProbeDeps({ platform: 'win32', tools: { 'powershell.exe': ok('not json at all') } })
    )
    expect(garbage.warnings).toEqual([expect.stringMatching(/^powershell: /)])
    expect(garbage.info.gpus).toEqual([])

    const hung = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        tools: { 'powershell.exe': new Error('powershell.exe did not finish in 15000 ms') },
      })
    )
    expect(hung.warnings).toEqual(['powershell: powershell.exe did not finish in 15000 ms'])
  })

  it('surfaces the AdapterRAM cap and a failing nvidia-smi as warnings', async () => {
    const text = readHardwareFixture('windows-probe-hybrid-rtx4090-uhd770.json').replaceAll(
      /"qwMemorySize":\d+/g,
      '"qwMemorySize":null'
    )
    const { info, warnings } = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        tools: { 'powershell.exe': ok(text), 'nvidia-smi': failed(9, 'NVIDIA-SMI has failed') },
      })
    )
    expect(warnings).toEqual([
      'nvidia-smi: nvidia-smi exited with 9: NVIDIA-SMI has failed',
      'NVIDIA GeForce RTX 4090: VRAM read from Win32_VideoController.AdapterRAM, which caps at 4 GiB',
      'Intel(R) UHD Graphics 770: VRAM read from Win32_VideoController.AdapterRAM, which caps at 4 GiB',
      'NVIDIA GeForce RTX 4090: NVIDIA GPU without an nvidia-smi answer; driver version and compute capability unknown',
    ])
    expect(info.gpus[0]).toMatchObject({
      vendor: 'NVIDIA',
      nvidia_info: null,
      total_memory: 4095,
      driver_version: '32.0.15.8142',
    })
  })
})
