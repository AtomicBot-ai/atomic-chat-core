import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import { failed, fakeProbeDeps, ok } from '../../test/helpers/fake-probe-deps.js'
import type { FakeTool } from '../../test/helpers/fake-probe-deps.js'
import type { ToolResult } from './probe-common.js'
import { probeWindows } from './probe-windows.js'
import { WINDOWS_PROBE_SCRIPT } from './windows-video.js'

const REG = 'C:\\Windows\\System32\\reg.exe'
const NVIDIA_SMI = 'C:\\Windows\\System32\\nvidia-smi.exe'

/**
 * `reg.exe query <key>` (no `/s`) answered from a recursive dump: the key's own block, then its direct
 * subkeys as bare lines, CRLF like the real tool; a key the dump lacks fails as reg.exe does.
 */
function fakeRegExe(dump: string, extra: Record<string, string> = {}): (args: string[]) => ToolResult {
  const blocks = new Map<string, string[]>()
  let current: string[] | undefined
  for (const line of dump.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) blocks.set(line.toLowerCase(), (current = [line]))
    else if (current && line.startsWith('    ')) current.push(line)
  }
  return (args) => {
    const key = (args[1] ?? '').replace(/^HKLM\\/i, 'HKEY_LOCAL_MACHINE\\')
    if (extra[key] !== undefined) return ok(extra[key])
    const block = blocks.get(key.toLowerCase())
    if (args[0] !== 'query' || args.length !== 2 || !block)
      return failed(1, 'ERROR: The system was unable to find the specified registry key or value.')
    const children = [...blocks.values()]
      .map((b) => b[0] as string)
      .filter(
        (path) =>
          path.toLowerCase().startsWith(`${key.toLowerCase()}\\`) &&
          !path.slice(key.length + 1).includes('\\')
      )
    return ok(['', ...block, '', ...children, ''].join('\r\n'))
  }
}
const amdBoxReg = () => fakeRegExe(readHardwareFixture('windows-reg-display-class-rx7900xtx-uhd770.txt'))
const blocked = failed(1, 'Program blocked by group policy.')

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
    const result = await probeWindows(deps)
    const { info, warnings } = result
    expect(warnings).toEqual([])
    expect(result).toMatchObject({ gpuSource: 'powershell' })
    expect(result.degraded).toBeUndefined()
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
      `registry: ENOENT: no such file or directory, open '${REG}'`,
    ])
    expect(failedRun).toMatchObject({ gpuSource: 'nvidia-smi', degraded: true })
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
    expect(garbage.warnings).toEqual([
      expect.stringMatching(/^powershell: /),
      expect.stringMatching(/^registry: /),
    ])
    expect(garbage.info.gpus).toEqual([])
    expect(garbage).toMatchObject({ gpuSource: 'none', degraded: true })

    const hung = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        tools: { 'powershell.exe': new Error('powershell.exe did not finish in 15000 ms') },
      })
    )
    expect(hung.warnings).toEqual([
      'powershell: powershell.exe did not finish in 15000 ms',
      `registry: ENOENT: no such file or directory, open '${REG}'`,
    ])
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
  it('reads the AMD and Intel GPUs from reg.exe when PowerShell is blocked, CPU flags left unknown', async () => {
    const deps = fakeProbeDeps({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      cpus: [{ model: 'AMD Ryzen 7 7800X3D 8-Core Processor' }],
      files: { 'C:\\Windows\\System32\\vulkan-1.dll': '' },
      tools: {
        'powershell.exe': blocked,
        [REG]: fakeRegExe(readHardwareFixture('windows-reg-display-class-rx7900xtx-uhd770.txt'), {
          'HKEY_LOCAL_MACHINE\\SOFTWARE\\Khronos\\Vulkan\\Drivers':
            '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Khronos\\Vulkan\\Drivers\r\n    C:\\Windows\\System32\\DriverStore\\FileRepository\\u0405208.inf_amd64_3a1b2c3d4e5f6a7b\\B405148\\amd-vulkan64.json    REG_DWORD    0x0\r\n',
        }),
      },
    })
    const result = await probeWindows(deps)
    expect(result.warnings).toEqual([
      'powershell: powershell.exe exited with 1: Program blocked by group policy.',
      'Intel(R) UHD Graphics 770: VRAM read from HardwareInformation.MemorySize, which caps at 4 GiB',
    ])
    expect(result).toMatchObject({ gpuSource: 'registry' })
    expect(result.degraded).toBeUndefined()
    expect(result.info.cpu).toMatchObject({
      name: 'AMD Ryzen 7 7800X3D 8-Core Processor',
      extensions_known: false,
    })
    expect(result.info.gpus).toEqual([
      {
        name: 'AMD Radeon RX 7900 XTX',
        total_memory: 24_560,
        vendor: 'AMD',
        uuid: '{4d36e968-e325-11ce-bfc1-08002be10318}\\0000',
        driver_version: '32.0.12033.1030',
        nvidia_info: null,
        vulkan_info: { index: 0, device_type: 'Unknown', api_version: '', device_id: 0x744c },
      },
      {
        name: 'Intel(R) UHD Graphics 770',
        total_memory: 128,
        vendor: 'Intel',
        uuid: '{4d36e968-e325-11ce-bfc1-08002be10318}\\0001',
        driver_version: '32.0.101.6083',
        nvidia_info: null,
        vulkan_info: { index: 1, device_type: 'IntegratedGpu', api_version: '', device_id: 0x4680 },
      },
    ])
    // One query per driver instance and one for the Khronos key; never /s, never the Properties key.
    expect(
      deps.calls.filter((c) => c.file === REG).map((c) => c.args.join(' ').replace(/^.*\\/, ''))
    ).toEqual(['{4d36e968-e325-11ce-bfc1-08002be10318}', '0000', '0001', '0002', 'Drivers'])
    expect(deps.calls.find((c) => c.file === REG)?.timeoutMs).toBe(5_000)
  })

  it('also reads the registry when PowerShell ran but CIM answered no video controller, keeping its CPU flags', async () => {
    const brokenWmi = readHardwareFixture('windows-probe-hybrid-rtx4090-uhd770.json').replace(
      /"video":\[.*?\],"classKeys"/,
      '"video":[],"classKeys"'
    )
    const deps = fakeProbeDeps({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      files: { 'C:\\Windows\\System32\\vulkan-1.dll': '' },
      tools: {
        'powershell.exe': ok(brokenWmi),
        [NVIDIA_SMI]: ok(readHardwareFixture('nvidia-smi-rtx4090-rtx3060-modern.csv').split('\n')[0] + '\n'),
        [REG]: fakeRegExe(readHardwareFixture('windows-reg-display-class-rtx4090-uhd770-stale-gtx1080.txt')),
      },
    })
    const result = await probeWindows(deps)
    expect(result.warnings).toEqual([
      'powershell: Win32_VideoController answered nothing; reading GPUs from the registry',
    ])
    expect(result).toMatchObject({ gpuSource: 'registry' })
    expect(result.info.cpu.extensions_known).toBe(true)
    // nvidia-smi is authoritative for NVIDIA: the stale GTX 1080 key is not a GPU; the 4090 key lends its device id.
    expect(
      result.info.gpus.map((g) => [g.name, g.vendor, g.nvidia_info !== null, g.vulkan_info?.device_id])
    ).toEqual([
      ['NVIDIA GeForce RTX 4090', 'NVIDIA', true, 0x2684],
      ['Intel(R) UHD Graphics 770', 'Intel', false, 0x4680],
    ])
  })

  it('marks a registry answer with no GPU, or a registry that failed, as degraded and warns per unreadable key', async () => {
    const dump = readHardwareFixture('windows-reg-display-class-rx7900xtx-uhd770.txt')
    const regTool = fakeRegExe(dump)
    const flaky: FakeTool = (args) =>
      (args[1] ?? '').endsWith('\\0000') ? new Error('reg.exe did not finish in 5000 ms') : regTool(args)
    const partial = await probeWindows(
      fakeProbeDeps({ platform: 'win32', tools: { 'powershell.exe': blocked, [REG]: flaky } })
    )
    expect(partial.warnings).toContain('registry: reg.exe did not finish in 5000 ms')
    expect(partial.info.gpus.map((g) => g.name)).toEqual(['Intel(R) UHD Graphics 770'])
    expect(partial.degraded).toBeUndefined()
    // No Vulkan loader known from the registry path: no Vulkan facts, whatever the drivers registered.
    expect(partial.info.gpus[0]?.vulkan_info).toBeNull()

    const headless = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        tools: {
          'powershell.exe': blocked,
          [REG]: fakeRegExe(
            dump
              .split('\n')
              .filter((l) => !/0000|0001/.test(l))
              .join('\n')
          ),
        },
      })
    )
    expect(headless.info.gpus).toEqual([])
    expect(headless).toMatchObject({ gpuSource: 'registry', degraded: true })

    const refused = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        tools: { 'powershell.exe': blocked, [REG]: failed(1, 'ERROR: Access is denied.') },
      })
    )
    expect(refused.warnings).toEqual([
      'powershell: powershell.exe exited with 1: Program blocked by group policy.',
      `registry: reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318} exited with 1: ERROR: Access is denied.`,
    ])
    expect(refused).toMatchObject({ gpuSource: 'none', degraded: true })
    const signal = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        tools: { 'powershell.exe': blocked, [REG]: { stdout: 'partial', stderr: '', code: null } },
      })
    )
    expect(signal.warnings.at(-1)).toMatch(/exited with signal: partial$/)
  })

  it('uses the AMD box fixture through a CRLF reg.exe', async () => {
    const result = await probeWindows(
      fakeProbeDeps({
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        tools: { 'powershell.exe': blocked, [REG]: amdBoxReg() },
      })
    )
    expect(result.info.gpus.map((g) => g.vendor)).toEqual(['AMD', 'Intel'])
  })
})
