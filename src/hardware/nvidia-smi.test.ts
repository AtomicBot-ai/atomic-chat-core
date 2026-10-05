import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import {
  NVIDIA_SMI_FIELDS,
  NVIDIA_SMI_FIELDS_LEGACY,
  isUnknownFieldError,
  normalizePciBusId,
  nvidiaBusIdOf,
  nvidiaGpuFromRow,
  nvidiaSmiArgs,
  nvidiaSmiCandidates,
  parseNvidiaSmiCsv,
} from './nvidia-smi.js'

describe('nvidiaSmiArgs', () => {
  it('asks for the fields as one csv query without units or header', () => {
    expect(nvidiaSmiArgs(NVIDIA_SMI_FIELDS)).toEqual([
      '--query-gpu=index,name,uuid,memory.total,driver_version,compute_cap,pci.bus_id',
      '--format=csv,noheader,nounits',
    ])
    expect(NVIDIA_SMI_FIELDS_LEGACY).toEqual(NVIDIA_SMI_FIELDS.filter((f) => f !== 'compute_cap'))
  })
})

describe('isUnknownFieldError', () => {
  it('recognises the pre-470 refusal of compute_cap and nothing else', () => {
    expect(isUnknownFieldError(readHardwareFixture('nvidia-smi-unknown-field.stderr.txt'))).toBe(true)
    expect(
      isUnknownFieldError("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")
    ).toBe(false)
    expect(isUnknownFieldError('')).toBe(false)
  })
})

describe('parseNvidiaSmiCsv / nvidiaGpuFromRow', () => {
  it('reads two modern GPUs into plugin GpuInfo records', () => {
    const rows = parseNvidiaSmiCsv(
      readHardwareFixture('nvidia-smi-rtx4090-rtx3060-modern.csv'),
      NVIDIA_SMI_FIELDS
    )
    expect(rows).toHaveLength(2)
    expect(nvidiaGpuFromRow(rows[0]!)).toEqual({
      name: 'NVIDIA GeForce RTX 4090',
      total_memory: 24_564,
      vendor: 'NVIDIA',
      uuid: '0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
      driver_version: '581.42',
      nvidia_info: { index: 0, compute_capability: '8.9' },
      vulkan_info: null,
    })
    expect(nvidiaGpuFromRow(rows[1]!)).toMatchObject({ nvidia_info: { index: 1, compute_capability: '8.6' } })
    expect(nvidiaBusIdOf(rows[1]!)).toBe('0000:05:00.0')
  })

  it('reads a legacy driver without compute_cap as an unknown compute capability', () => {
    const rows = parseNvidiaSmiCsv(
      readHardwareFixture('nvidia-smi-gtx1080-legacy.csv'),
      NVIDIA_SMI_FIELDS_LEGACY
    )
    expect(rows).toHaveLength(1)
    expect(nvidiaGpuFromRow(rows[0]!)).toMatchObject({
      name: 'GeForce GTX 1080',
      driver_version: '460.91.03',
      total_memory: 8192,
      nvidia_info: { index: 0, compute_capability: '' },
    })
  })

  it('treats [N/A] and friends as unreported', () => {
    const rows = parseNvidiaSmiCsv(readHardwareFixture('nvidia-smi-rtx4090-na.csv'), NVIDIA_SMI_FIELDS)
    expect(rows[0]).not.toHaveProperty('compute_cap')
    expect(rows[0]).not.toHaveProperty('pci.bus_id')
    expect(nvidiaBusIdOf(rows[0]!)).toBeUndefined()
    expect(nvidiaGpuFromRow(rows[0]!).nvidia_info?.compute_capability).toBe('')
    expect(parseNvidiaSmiCsv('0, x, [Not Supported], N/A, 1, 2, 3\n', NVIDIA_SMI_FIELDS)[0]).toEqual({
      'index': '0',
      'name': 'x',
      'driver_version': '1',
      'compute_cap': '2',
      'pci.bus_id': '3',
    })
  })

  it('reads the GB10 (unified memory, [N/A] memory) as an unknown size of 0, never NaN', () => {
    // The values captured on a DGX Spark-class host (driver 595.71.05), laid out in this query's own
    // column order; the index and bus id columns were not captured and are made up.
    const rows = parseNvidiaSmiCsv(
      '0, NVIDIA GB10, GPU-d991dc71-7825-0bf8-3339-cb2e7ead6a32, [N/A], 595.71.05, 12.1, 0000000F:01:00.0\n',
      NVIDIA_SMI_FIELDS
    )
    expect(rows).toHaveLength(1)
    expect(nvidiaGpuFromRow(rows[0]!)).toMatchObject({
      name: 'NVIDIA GB10',
      total_memory: 0,
      uuid: 'd991dc71-7825-0bf8-3339-cb2e7ead6a32',
      driver_version: '595.71.05',
      nvidia_info: { index: 0, compute_capability: '12.1' },
    })
  })

  it('skips a header line and reads memory with its unit, for output from a query without noheader,nounits', () => {
    const rows = parseNvidiaSmiCsv(
      'index, name, uuid, memory.total [MiB], driver_version, compute_cap, pci.bus_id\n' +
        '0, NVIDIA GeForce RTX 5090, GPU-5a0f7d19-2c4b-4e8a-b6d3-91e2c0f4a7d8, 32607 MiB, 595.71.05, 12.0, 00000000:01:00.0\n',
      NVIDIA_SMI_FIELDS
    )
    expect(rows).toHaveLength(1)
    expect(nvidiaGpuFromRow(rows[0]!)).toMatchObject({
      name: 'NVIDIA GeForce RTX 5090',
      total_memory: 32_607,
    })
  })

  it('drops lines whose column count does not match the query', () => {
    const rows = parseNvidiaSmiCsv(
      'Warning: persistence mode is disabled\n0, GPU, GPU-1, 100, 550.1, 7.5, 00000000:01:00.0\n\n',
      NVIDIA_SMI_FIELDS
    )
    expect(rows).toHaveLength(1)
    expect(parseNvidiaSmiCsv('', NVIDIA_SMI_FIELDS)).toEqual([])
  })

  it('fills the plugin empty values for an empty row', () => {
    expect(nvidiaGpuFromRow({})).toEqual({
      name: 'NVIDIA GPU',
      total_memory: 0,
      vendor: 'NVIDIA',
      uuid: '',
      driver_version: '',
      nvidia_info: { index: 0, compute_capability: '' },
      vulkan_info: null,
    })
    expect(nvidiaGpuFromRow({ 'index': '-1', 'memory.total': 'lots' })).toMatchObject({
      total_memory: 0,
      nvidia_info: { index: 0 },
    })
  })
})

describe('normalizePciBusId', () => {
  it.each([
    ['00000000:01:00.0', '0000:01:00.0'],
    ['0000:65:00.0', '0000:65:00.0'],
    ['00000000:0A:00.0', '0000:0a:00.0'],
    ['1:02:00.0', '0001:02:00.0'],
    ['  garbage ', 'garbage'],
  ])('%s → %s', (input, expected) => expect(normalizePciBusId(input)).toBe(expected))
})

describe('nvidiaSmiCandidates', () => {
  it('tries PATH, then the driver install locations', () => {
    expect(nvidiaSmiCandidates('linux', {})).toEqual([
      'nvidia-smi',
      '/usr/bin/nvidia-smi',
      '/usr/lib/wsl/lib/nvidia-smi',
    ])
    expect(nvidiaSmiCandidates('win32', { SystemRoot: 'D:\\Win', ProgramFiles: 'D:\\PF' })).toEqual([
      'nvidia-smi',
      'D:\\Win\\System32\\nvidia-smi.exe',
      'D:\\PF\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
    ])
    expect(nvidiaSmiCandidates('win32', {})).toEqual([
      'nvidia-smi',
      'C:\\Windows\\System32\\nvidia-smi.exe',
      'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe',
    ])
    expect(nvidiaSmiCandidates('darwin', {})).toEqual([])
  })
})
