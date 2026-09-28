import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { HardwareInfoResponse, SystemInfo } from '../../contracts/index.js'
import { AtomicCore } from '../../core/index.js'
import { recordingIo } from '../io.js'
import { formatHardwareInfo, hardwareCommand } from './hardware.js'

let data: TmpDataFolder
const cores: AtomicCore[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-hardware-')
})
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()))
  await data.cleanup()
})

const io = () => recordingIo()
const folder = () => ['--data-folder', data.root]

const info: SystemInfo = {
  cpu: {
    name: 'AMD Ryzen 9 7950X',
    core_count: 16,
    arch: 'x86_64',
    extensions: ['sse4_2', 'avx', 'avx2', 'avx512_f'],
    extensions_known: true,
  },
  os_type: 'windows',
  os_name: 'Microsoft Windows 11 Pro',
  total_memory: 65_536,
  gpus: [
    {
      name: 'NVIDIA GeForce RTX 4090',
      total_memory: 24_564,
      vendor: 'NVIDIA',
      uuid: 'abc',
      driver_version: '581.42',
      nvidia_info: { index: 0, compute_capability: '8.9' },
      vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '1.3.290', device_id: 0x2684 },
    },
  ],
}

describe('hardware info', () => {
  it('prints the core’s probe, then re-probes with --refresh', async () => {
    let probes = 0
    const core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      hardware: {
        probe: async () => {
          probes++
          return { info: structuredClone(info), warnings: probes > 1 ? ['second probe'] : [] }
        },
      },
    })
    cores.push(core)
    const out = io()
    expect(await hardwareCommand(['info', ...folder()], out)).toBe(0)
    const text = out.out.join('')
    expect(text).toContain('Microsoft Windows 11 Pro (windows)')
    expect(text).toContain('AMD Ryzen 9 7950X, 16 cores, x86_64')
    expect(text).toContain('avx, avx2, avx512_f')
    expect(text).toContain(
      'NVIDIA, NVIDIA GeForce RTX 4090, 24.0 GiB, driver 581.42, cc 8.9, vulkan DiscreteGpu'
    )
    expect(text).toContain('Source    probe')

    const refreshed = io()
    expect(await hardwareCommand(['info', '--refresh', '--json', ...folder()], refreshed)).toBe(0)
    const parsed = JSON.parse(refreshed.out.join('')) as HardwareInfoResponse
    expect(parsed.warnings).toEqual(['second probe'])
    expect(probes).toBe(2)
  })

  it('rejects an unknown subcommand', async () => {
    const out = io()
    expect(await hardwareCommand(['usage', ...folder()], out)).toBe(2)
    expect(out.err.join('')).toContain('Unknown hardware subcommand')
  })
})

describe('formatHardwareInfo', () => {
  it('says when flags are unknown and when no GPU was found', () => {
    const text = formatHardwareInfo({
      info: {
        ...info,
        cpu: { ...info.cpu, extensions: [], extensions_known: false },
        gpus: [],
        total_memory: 512,
      },
      source: 'override',
      probed_at: 0,
      warnings: ['nvidia-smi: not found'],
    })
    expect(text).toContain('Flags     unknown')
    expect(text).toContain('Memory    512 MiB')
    expect(text).toContain('GPU       none detected')
    expect(text).toContain('Source    override at 1970-01-01T00:00:00.000Z')
    expect(text).toContain('Warning   nvidia-smi: not found')
  })

  it('says "no AVX" when the flags are known but carry none', () => {
    const text = formatHardwareInfo({
      info: { ...info, cpu: { ...info.cpu, extensions: ['sse2'] } },
      source: 'probe',
      probed_at: 1,
      warnings: [],
    })
    expect(text).toContain('Flags     no AVX')
  })
})
