import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import { enoent, failed, fakeProbeDeps, ok } from '../../test/helpers/fake-probe-deps.js'
import { NVIDIA_SMI_FIELDS_LEGACY, nvidiaSmiArgs } from './nvidia-smi.js'
import {
  PROBE_POWERSHELL_TIMEOUT_MS,
  PROBE_TOOL_TIMEOUT_MS,
  commonFacts,
  fallbackProbe,
  firstLine,
  runNvidiaSmi,
  settledOrWarn,
  warningOf,
} from './probe-common.js'

describe('budgets', () => {
  it('gives PowerShell three times the tool budget', () => {
    expect(PROBE_TOOL_TIMEOUT_MS).toBe(5_000)
    expect(PROBE_POWERSHELL_TIMEOUT_MS).toBe(15_000)
  })
})

describe('commonFacts', () => {
  it('converts the arch, floors the memory to MiB and names the CPU from node:os', () => {
    const deps = fakeProbeDeps({
      platform: 'linux',
      arch: 'x64',
      totalmem: 16 * 2 ** 30 + 12345,
      cpus: [{ model: ' Intel Core ' }, { model: 'x' }],
    })
    expect(commonFacts(deps)).toEqual({
      arch: 'x86_64',
      totalMemoryMiB: 16_384,
      cpuName: 'Intel Core',
      logicalCores: 2,
    })
  })

  it('survives node:os refusing to answer', () => {
    const deps = fakeProbeDeps({ platform: 'linux', arch: 'arm64' })
    deps.os = {
      totalmem: () => {
        throw new Error('nope')
      },
      cpus: () => {
        throw new Error('nope')
      },
    }
    expect(commonFacts(deps)).toEqual({
      arch: 'arm64',
      totalMemoryMiB: 0,
      cpuName: undefined,
      logicalCores: 0,
    })
    expect(
      commonFacts(fakeProbeDeps({ platform: 'linux', cpus: [{ model: '  ' }], totalmem: Number.NaN })).cpuName
    ).toBeUndefined()
  })
})

describe('warningOf / settledOrWarn / firstLine', () => {
  it('renders one line per failure', () => {
    expect(warningOf('nvidia-smi', new Error('boom'))).toBe('nvidia-smi: boom')
    expect(warningOf('step', 'text')).toBe('step: text')
    const warnings: string[] = []
    expect(settledOrWarn({ status: 'fulfilled', value: 1 }, 'a', warnings)).toBe(1)
    expect(settledOrWarn({ status: 'rejected', reason: new Error('x') }, 'b', warnings)).toBeUndefined()
    expect(warnings).toEqual(['b: x'])
    expect(firstLine('\n\n  first \nsecond')).toBe('first')
    expect(firstLine('')).toBe('')
  })
})

describe('fallbackProbe', () => {
  it('answers what node:os knows, with unknown flags and no GPUs', () => {
    const { info, warnings } = fallbackProbe(
      fakeProbeDeps({ platform: 'freebsd', arch: 'x64', cpus: [{ model: 'Zen' }] })
    )
    expect(info).toEqual({
      cpu: { name: 'Zen', core_count: 1, arch: 'x86_64', extensions: [], extensions_known: false },
      os_type: 'unknown',
      os_name: 'freebsd',
      total_memory: 65_536,
      gpus: [],
    })
    expect(warnings).toEqual([])
    expect(fallbackProbe(fakeProbeDeps({ platform: 'darwin', cpus: [] })).info.cpu.name).toBe('Unknown CPU')
  })
})

describe('runNvidiaSmi', () => {
  const modern = readHardwareFixture('nvidia-smi-rtx4090-rtx3060-modern.csv')

  it('answers nothing, silently, when no candidate exists', async () => {
    const deps = fakeProbeDeps({ platform: 'linux' })
    await expect(runNvidiaSmi(deps)).resolves.toEqual([])
    expect(deps.calls.map((c) => c.file)).toEqual([
      'nvidia-smi',
      '/usr/bin/nvidia-smi',
      '/usr/lib/wsl/lib/nvidia-smi',
    ])
    expect(deps.calls.every((c) => c.timeoutMs === PROBE_TOOL_TIMEOUT_MS)).toBe(true)
    await expect(runNvidiaSmi(fakeProbeDeps({ platform: 'darwin' }))).resolves.toEqual([])
  })

  it('takes the first candidate that starts and reads its rows with bus ids', async () => {
    const deps = fakeProbeDeps({ platform: 'linux', tools: { '/usr/lib/wsl/lib/nvidia-smi': ok(modern) } })
    const rows = await runNvidiaSmi(deps)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ busId: '0000:01:00.0', gpu: { name: 'NVIDIA GeForce RTX 4090' } })
    expect(deps.calls).toHaveLength(3)
  })

  it('retries the same binary with the legacy fields when compute_cap is refused', async () => {
    const legacy = readHardwareFixture('nvidia-smi-gtx1080-legacy.csv')
    const refusal = readHardwareFixture('nvidia-smi-unknown-field.stderr.txt')
    const deps = fakeProbeDeps({
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      tools: {
        'C:\\Windows\\System32\\nvidia-smi.exe': (args) =>
          args[0]?.includes('compute_cap') ? failed(2, refusal) : ok(legacy),
      },
    })
    const rows = await runNvidiaSmi(deps)
    expect(rows).toEqual([
      {
        gpu: {
          name: 'GeForce GTX 1080',
          total_memory: 8192,
          vendor: 'NVIDIA',
          uuid: '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f',
          driver_version: '460.91.03',
          nvidia_info: { index: 0, compute_capability: '' },
          vulkan_info: null,
        },
        busId: '0000:01:00.0',
      },
    ])
    expect(deps.calls.slice(1).map((c) => c.args)).toEqual([
      [
        '--query-gpu=index,name,uuid,memory.total,driver_version,compute_cap,pci.bus_id',
        '--format=csv,noheader,nounits',
      ],
      nvidiaSmiArgs(NVIDIA_SMI_FIELDS_LEGACY),
    ])
  })

  it('reports a binary that exists but fails, and one that hangs', async () => {
    const broken = fakeProbeDeps({
      platform: 'linux',
      tools: {
        'nvidia-smi': failed(
          9,
          "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver."
        ),
      },
    })
    await expect(runNvidiaSmi(broken)).rejects.toThrow(/nvidia-smi exited with 9: NVIDIA-SMI has failed/)
    const hung = fakeProbeDeps({
      platform: 'linux',
      tools: { '/usr/bin/nvidia-smi': new Error('nvidia-smi did not finish in 5000 ms') },
    })
    await expect(runNvidiaSmi(hung)).rejects.toThrow(/did not finish/)
    expect(hung.calls).toHaveLength(2)
    const signalled = fakeProbeDeps({
      platform: 'linux',
      tools: { 'nvidia-smi': { stdout: '', stderr: '', code: null } },
    })
    await expect(runNvidiaSmi(signalled)).rejects.toThrow(/exited with signal/)
    expect(enoent('x').code).toBe('ENOENT')
  })
})
