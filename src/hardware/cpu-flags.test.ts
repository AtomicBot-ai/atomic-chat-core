import { describe, expect, it } from 'vitest'
import { readHardwareFixture } from '../../test/helpers/hardware-fixtures.js'
import {
  PLUGIN_CPU_EXTENSIONS,
  WINDOWS_PROCESSOR_FEATURES,
  cpuExtensionsFromWindowsPf,
  isX86Arch,
  parseDarwinCpuFeatures,
  parseProcCpuinfo,
} from './cpu-flags.js'

describe('PLUGIN_CPU_EXTENSIONS', () => {
  it('lists the 27 names the plugin emits, each once', () => {
    expect(PLUGIN_CPU_EXTENSIONS).toHaveLength(27)
    expect(new Set(PLUGIN_CPU_EXTENSIONS).size).toBe(27)
    expect(PLUGIN_CPU_EXTENSIONS).toContain('avx512_f')
    expect(PLUGIN_CPU_EXTENSIONS).toContain('sse4_1')
  })
})

describe('parseProcCpuinfo', () => {
  it('maps a Ryzen 7950X to the plugin spelling, first processor only, in plugin order', () => {
    const parsed = parseProcCpuinfo(readHardwareFixture('proc-cpuinfo-ryzen-7950x.txt'))
    expect(parsed.modelName).toBe('AMD Ryzen 9 7950X 16-Core Processor')
    expect(parsed.flags).toEqual([
      'fpu',
      'mmx',
      'sse',
      'sse2',
      'sse3',
      'ssse3',
      'sse4_1',
      'sse4_2',
      'pclmulqdq',
      'avx',
      'avx2',
      'avx512_f',
      'avx512_dq',
      'avx512_ifma',
      'avx512_cd',
      'avx512_bw',
      'avx512_vl',
      'avx512_vbmi',
      'avx512_vbmi2',
      'avx512_vnni',
      'avx512_bitalg',
      'avx512_vpopcntdq',
      'aes',
      'f16c',
    ])
    // Four processors, but core ids 0,1,2,0 on one socket: three distinct cores.
    expect(parsed.physicalCores).toBe(3)
  })

  it('reports no flags on arm64, where the kernel writes Features instead', () => {
    const parsed = parseProcCpuinfo(readHardwareFixture('proc-cpuinfo-graviton-arm64.txt'))
    expect(parsed.flags).toBeUndefined()
    expect(parsed.modelName).toBeUndefined()
    expect(parsed.physicalCores).toBeUndefined()
  })

  it('reports a Core 2 without AVX as flags that lack avx, never as unknown', () => {
    const parsed = parseProcCpuinfo(readHardwareFixture('proc-cpuinfo-core2-q9550.txt'))
    expect(parsed.flags).toEqual(['fpu', 'mmx', 'sse', 'sse2', 'sse3', 'ssse3', 'sse4_1'])
    expect(parsed.flags).not.toContain('avx')
    expect(parsed.physicalCores).toBe(1)
  })

  it.each([
    ['pni', 'sse3'],
    ['avx512f', 'avx512_f'],
    ['avx512_vp2intersect', 'avx512_vp2intersect'],
    ['sse4_1', 'sse4_1'],
    ['avx512pf', 'avx512_pf'],
    ['avx512er', 'avx512_er'],
  ])('maps the Linux flag %s to %s', (linux, plugin) => {
    expect(parseProcCpuinfo(`flags\t\t: ${linux}\n`).flags).toEqual(
      ['fpu', plugin].filter((n, i, a) => a.indexOf(n) === i)
    )
  })

  it('always adds fpu on x86 and ignores flags the plugin does not report', () => {
    expect(parseProcCpuinfo('flags\t: sse2 vmx avx smep\n').flags).toEqual(['fpu', 'sse2', 'avx'])
    expect(parseProcCpuinfo('flags\t:\n').flags).toEqual(['fpu'])
  })

  it('falls back to `cpu cores` when the file has no core ids, and to `Hardware` for the name', () => {
    const parsed = parseProcCpuinfo('Hardware\t: BCM2835\ncpu cores\t: 4\nflags\t: sse\n')
    expect(parsed).toEqual({ modelName: 'BCM2835', flags: ['fpu', 'sse'], physicalCores: 4 })
    expect(parseProcCpuinfo('')).toEqual({ flags: undefined })
    expect(parseProcCpuinfo('cpu cores\t: zero\n')).toEqual({ flags: undefined })
  })
})

describe('parseDarwinCpuFeatures', () => {
  const features =
    'FPU VME DE PSE TSC MSR PAE MCE CX8 APIC SEP MTRR PGE MCA CMOV PAT PSE36 CLFSH DS ACPI MMX FXSR SSE SSE2 SS HTT TM PBE SSE3 PCLMULQDQ DTES64 MON DSCPL VMX SMX EST TM2 SSSE3 FMA CX16 TPR PDCM SSE4.1 SSE4.2 x2APIC MOVBE POPCNT AES PCID XSAVE OSXSAVE SEGLIM64 TSCTMR AVX1.0 RDRAND F16C'
  const leaf7 =
    'RDWRFSGS TSC_THREAD_OFFSET SGX BMI1 AVX2 SMEP BMI2 ERMS INVPCID FPU_CSDS MPX RDSEED ADX SMAP CLFSOPT IPT SGXLC MDCLEAR IBRS STIBP L1DF ACAPMSR SSBD'

  it('maps an Intel Mac (i9-9980HK) to the plugin spelling', () => {
    expect(parseDarwinCpuFeatures(features, leaf7)).toEqual([
      'fpu',
      'mmx',
      'sse',
      'sse2',
      'sse3',
      'ssse3',
      'sse4_1',
      'sse4_2',
      'pclmulqdq',
      'avx',
      'avx2',
      'aes',
      'f16c',
    ])
  })

  it('reads AVX-512 from leaf 7 and tolerates missing lists', () => {
    expect(parseDarwinCpuFeatures('AVX1.0', 'AVX2 AVX512F AVX512DQ AVX512VL AVX512BW')).toEqual([
      'avx',
      'avx2',
      'avx512_f',
      'avx512_dq',
      'avx512_bw',
      'avx512_vl',
    ])
    expect(parseDarwinCpuFeatures('', '')).toEqual([])
  })
})

describe('cpuExtensionsFromWindowsPf', () => {
  const all = Object.fromEntries(Object.keys(WINDOWS_PROCESSOR_FEATURES).map((k) => [k, true]))

  it.each<[string, Record<string, boolean> | null, number, string, string[] | undefined]>([
    ['arm64 has no x86 flags', all, 26100, 'arm64', []],
    ['aarch64 spelled the Rust way', all, 26100, 'aarch64', []],
    ['Add-Type failed', null, 26100, 'x86_64', undefined],
    [
      'old kernel answers false for PF 39 it does not know',
      { ...all, '39': false, '40': false, '41': false },
      19045,
      'x86_64',
      undefined,
    ],
    [
      'old kernel that does answer true is believed',
      { ...all, '41': false },
      19045,
      'x86_64',
      ['fpu', 'mmx', 'sse', 'sse2', 'sse3', 'ssse3', 'sse4_1', 'sse4_2', 'avx', 'avx2'],
    ],
    [
      'new kernel, a CPU without AVX',
      {
        '3': true,
        '6': true,
        '10': true,
        '13': true,
        '36': true,
        '37': true,
        '38': false,
        '39': false,
        '40': false,
        '41': false,
      },
      22631,
      'x64',
      ['fpu', 'mmx', 'sse', 'sse2', 'sse3', 'ssse3', 'sse4_1'],
    ],
    [
      'everything present',
      all,
      26100,
      'x86_64',
      ['fpu', 'mmx', 'sse', 'sse2', 'sse3', 'ssse3', 'sse4_1', 'sse4_2', 'avx', 'avx2', 'avx512_f'],
    ],
    ['an empty answer still means fpu on x86', {}, 26100, 'x86_64', ['fpu']],
  ])('%s', (_name, pf, build, arch, expected) => {
    expect(cpuExtensionsFromWindowsPf(pf, build, arch)).toEqual(expected)
  })
})

describe('isX86Arch', () => {
  it.each([
    ['x86_64', true],
    ['x64', true],
    ['amd64', true],
    ['ia32', true],
    ['x86', true],
    ['arm64', false],
    ['aarch64', false],
    ['', false],
  ])('%s → %s', (arch, expected) => expect(isX86Arch(arch)).toBe(expected))
})
