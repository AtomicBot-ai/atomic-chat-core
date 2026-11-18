import { expect, it } from 'vitest'
import fixture from '../../../test/fixtures/strata/manifest.json' with { type: 'json' }
import { parseStrataManifest } from '../../engine-builds/index.js'
import { selectStrataDevice, strataHipOrdinal } from './strata-platforms.js'
import type { StrataHostFacts } from './strata-platforms.js'
const release = () => parseStrataManifest(fixture, '0.23.6').releases[0]!
const host = (): StrataHostFacts => ({
  os: 'macos',
  arch: 'arm64',
  osVersion: '26.6.2',
  cpuFeatures: [],
  ramBytes: 128e9,
  devices: [{ id: 'apple:0', vendor: 'apple', architecture: 'apple-gpu', memoryBytes: 128e9, unified: true }],
})
it('selects one compatible GPU without summing unified memory twice', () => {
  expect(selectStrataDevice(release(), host(), 'qwen38')).toMatchObject({
    device: { id: 'apple:0', unified: true },
    variant: { id: 'macos-arm64-metal' },
  })
})
it.each(['old-os', 'unknown-os', 'wrong-cpu', 'no-device', 'qwen36'])(
  'refuses %s before acquisition',
  (scenario) => {
    const h = host()
    if (scenario === 'old-os') h.osVersion = '14.9'
    if (scenario === 'unknown-os') delete h.osVersion
    if (scenario === 'wrong-cpu') h.arch = 'x64'
    if (scenario === 'no-device') h.devices = []
    expect(selectStrataDevice(release(), h, scenario === 'qwen36' ? 'qwen36' : 'qwen38').device).toBeNull()
  }
)
it('does not silently choose another GPU when the user selects an incompatible device', () => {
  expect(selectStrataDevice(release(), host(), 'qwen38', 'missing').device).toBeNull()
})

it('prefers the complete compatible bundle when CUDA 12 and 13 both run on the selected card', () => {
  const r = release()
  const base = r.variants[0]!
  const hostRequirement = {
    os: 'windows' as const,
    arch: 'x64' as const,
    minimum_os_version: '10',
    cpu_features: ['avx2'],
    gpu_vendor: 'nvidia' as const,
    gpu_architectures: ['sm_89'],
    minimum_driver: '580.65',
  }
  r.variants = [
    {
      ...base,
      id: 'windows-x64-cuda12',
      platform: 'windows-x64',
      backend: 'cuda12',
      host: hostRequirement,
      families: ['qwen38', 'qwen36'],
    },
    {
      ...base,
      id: 'windows-x64-cuda13',
      platform: 'windows-x64',
      backend: 'cuda13',
      host: hostRequirement,
      families: ['qwen38', 'qwen36', 'deepseek41'],
    },
  ]
  const facts: StrataHostFacts = {
    os: 'windows',
    arch: 'x64',
    osVersion: '10',
    cpuFeatures: ['avx2'],
    ramBytes: 64e9,
    devices: [
      {
        id: 'gpu',
        vendor: 'nvidia',
        architecture: 'sm_89',
        driverVersion: '581.0',
        memoryBytes: 24e9,
        unified: false,
      },
    ],
  }
  expect(selectStrataDevice(r, facts).variant?.id).toBe('windows-x64-cuda13')
})

it('uses a unique HIP runtime identity and rejects ambiguous and unsupported matches', () => {
  const target = {
    id: 'pci:1',
    vendor: 'amd' as const,
    name: 'AMD Radeon RX 7900 XTX',
    architecture: 'gfx1100',
    memoryBytes: 24e9,
    unified: false,
  }
  const row = 'device 2: AMD Radeon RX 7900 XTX\narch gfx1100, 24.0 GiB\n'
  expect(strataHipOrdinal(target, [target], row)).toBe(2)
  expect(strataHipOrdinal(target, [target, { ...target, id: 'pci:2' }], row)).toBeUndefined()
  expect(strataHipOrdinal(target, [target], row + 'cannot run: wrong architecture\n')).toBeUndefined()
  expect(strataHipOrdinal(target, [target], row + row.replace('device 2', 'device 4'))).toBeUndefined()
})

it.each([
  {
    backend: 'hip',
    vendor: 'amd',
    gpu: 'gfx1201',
    family: 'radeon-ai-pro-r9700',
    arch: 'x64',
    allowed: 'deepseek41',
    refused: 'qwen36',
  },
  {
    backend: 'sycl',
    vendor: 'intel',
    gpu: 'intel-arc',
    family: undefined,
    arch: 'x64',
    allowed: 'qwen38',
    refused: 'deepseek41',
  },
  {
    backend: 'cuda13',
    vendor: 'nvidia',
    gpu: 'sm_121',
    family: 'dgx-spark',
    arch: 'arm64',
    allowed: 'qwen38',
    refused: 'qwen36',
  },
] as const)('selects only the allowed Linux $backend family and checks the published host bounds', (row) => {
  const r = release()
  const v = r.variants[0]!
  const facts: StrataHostFacts = {
    os: 'linux',
    arch: row.arch,
    osVersion: '24.04',
    distribution: 'ubuntu',
    glibcVersion: '2.39',
    cpuFeatures: [row.arch === 'arm64' ? 'dotprod' : 'avx2'],
    ramBytes: 128e9,
    devices: [
      {
        id: 'card',
        vendor: row.vendor,
        architecture: row.gpu,
        ...(row.family ? { family: row.family } : {}),
        driverVersion: '580.65',
        memoryBytes: 32e9,
        unified: row.arch === 'arm64',
      },
    ],
  }
  r.variants = [
    {
      ...v,
      backend: row.backend,
      families: [row.allowed],
      host: {
        os: 'linux',
        arch: row.arch,
        minimum_os_version: '24.04',
        minimum_glibc: '2.39',
        distribution: 'ubuntu',
        cpu_features: facts.cpuFeatures!,
        gpu_vendor: row.vendor,
        gpu_architectures: [row.gpu],
        ...(row.family ? { device_family: row.family } : {}),
        ...(row.backend === 'cuda13' ? { minimum_driver: '580.65' } : {}),
      },
    },
  ]
  expect(selectStrataDevice(r, facts, row.allowed).device?.id).toBe('card')
  expect(selectStrataDevice(r, facts, row.refused).device).toBeNull()
  expect(selectStrataDevice(r, { ...facts, glibcVersion: '2.38' }, row.allowed).device).toBeNull()
  expect(selectStrataDevice(r, { ...facts, cpuFeatures: [] }, row.allowed).device).toBeNull()
  if (row.family) {
    const devices = [{ ...facts.devices[0]! }]
    delete devices[0]!.family
    expect(selectStrataDevice(r, { ...facts, devices }, row.allowed).device).toBeNull()
  }
  if (row.backend === 'cuda13') {
    const devices = [{ ...facts.devices[0]!, driverVersion: '579.0' }]
    expect(selectStrataDevice(r, { ...facts, devices }, row.allowed).device).toBeNull()
  }
})
