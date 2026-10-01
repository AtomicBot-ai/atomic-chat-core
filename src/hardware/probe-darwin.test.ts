import { describe, expect, it } from 'vitest'
import { failed, fakeProbeDeps, ok } from '../../test/helpers/fake-probe-deps.js'
import { parseSwVers, probeDarwin, probeUnifiedMemory } from './probe-darwin.js'

const SW_VERS = 'ProductName:\t\tmacOS\nProductVersion:\t\t26.5.2\nBuildVersion:\t\t25F84\n'

describe('probeDarwin', () => {
  it('reads an Apple silicon Mac: physical cores, brand, OS name, no x86 flags, no GPUs', async () => {
    const deps = fakeProbeDeps({
      platform: 'darwin',
      arch: 'arm64',
      totalmem: 48 * 2 ** 30,
      tools: { '/usr/sbin/sysctl': ok('14\nApple M4 Pro\n'), '/usr/bin/sw_vers': ok(SW_VERS) },
    })
    const { info, warnings } = await probeDarwin(deps)
    expect(warnings).toEqual([])
    expect(info).toEqual({
      cpu: { name: 'Apple M4 Pro', core_count: 14, arch: 'arm64', extensions: [], extensions_known: true },
      os_type: 'macos',
      os_name: 'macOS 26.5.2',
      total_memory: 49_152,
      gpus: [],
    })
    expect(deps.calls).toEqual([
      {
        file: '/usr/sbin/sysctl',
        args: ['-n', 'hw.physicalcpu', 'machdep.cpu.brand_string'],
        timeoutMs: 5_000,
      },
      { file: '/usr/bin/sw_vers', args: [], timeoutMs: 5_000 },
    ])
  })

  it('asks an Intel Mac for its feature lists and maps them', async () => {
    const deps = fakeProbeDeps({
      platform: 'darwin',
      arch: 'x64',
      tools: {
        '/usr/sbin/sysctl': ok(
          '8\nIntel(R) Core(TM) i9-9980HK CPU @ 2.40GHz\nFPU MMX SSE SSE2 SSE3 SSSE3 SSE4.1 SSE4.2 AES AVX1.0 F16C PCLMULQDQ\nBMI1 AVX2 BMI2\n'
        ),
        '/usr/bin/sw_vers': ok('ProductName:\tmacOS\nProductVersion:\t14.7.1\n'),
      },
    })
    const { info } = await probeDarwin(deps)
    expect(info.cpu).toEqual({
      name: 'Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz',
      core_count: 8,
      arch: 'x86_64',
      extensions: [
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
      ],
      extensions_known: true,
    })
    expect(info.os_name).toBe('macOS 14.7.1')
    expect(deps.calls[0]?.args).toEqual([
      '-n',
      'hw.physicalcpu',
      'machdep.cpu.brand_string',
      'machdep.cpu.features',
      'machdep.cpu.leaf7_features',
    ])
  })

  it('falls back to node:os with a warning when the tools fail, leaving x86 flags unknown', async () => {
    const deps = fakeProbeDeps({
      platform: 'darwin',
      arch: 'x64',
      cpus: Array.from({ length: 16 }, () => ({ model: 'Intel(R) Xeon(R) W' })),
      tools: {
        '/usr/sbin/sysctl': failed(1, 'sysctl: unknown oid'),
        '/usr/bin/sw_vers': new Error('sw_vers did not finish in 5000 ms'),
      },
    })
    const { info, warnings } = await probeDarwin(deps)
    expect(info.cpu).toEqual({
      name: 'Intel(R) Xeon(R) W',
      core_count: 16,
      arch: 'x86_64',
      extensions: [],
      extensions_known: false,
    })
    expect(info.os_name).toBe('macOS')
    expect(warnings).toEqual([
      'sysctl: /usr/sbin/sysctl exited with 1: sysctl: unknown oid',
      'sw_vers: sw_vers did not finish in 5000 ms',
    ])
    // Apple silicon has no x86 flags whatever sysctl says.
    const arm = await probeDarwin(fakeProbeDeps({ platform: 'darwin', arch: 'arm64', cpus: [] }))
    expect(arm.info.cpu).toMatchObject({
      name: 'Unknown CPU',
      core_count: 0,
      extensions: [],
      extensions_known: true,
    })
  })

  it('treats a short sysctl answer on x86 as unknown flags', async () => {
    const { info } = await probeDarwin(
      fakeProbeDeps({
        platform: 'darwin',
        arch: 'x64',
        tools: { '/usr/sbin/sysctl': ok('4\nSome CPU\n'), '/usr/bin/sw_vers': ok('') },
      })
    )
    expect(info.cpu).toMatchObject({ name: 'Some CPU', core_count: 4, extensions_known: false })
    expect(info.os_name).toBe('macOS')
  })
})

describe('parseSwVers', () => {
  it.each([
    [SW_VERS, 'macOS 26.5.2'],
    ['ProductName:\tMac OS X\nProductVersion:\t10.15.7\nBuildVersion:\t19H15\n', 'Mac OS X 10.15.7'],
    ['ProductVersion:\t13.0\n', 'macOS 13.0'],
    ['', 'macOS'],
  ])('%j → %s', (text, expected) => expect(parseSwVers(text)).toBe(expected))
})

describe('probeUnifiedMemory', () => {
  const GiB = 2 ** 30

  it('answers RAM on Apple silicon, without running a tool', () => {
    const deps = fakeProbeDeps({ platform: 'darwin', arch: 'arm64', totalmem: 18 * GiB })
    expect(probeUnifiedMemory(deps)).toEqual({ totalMemoryBytes: 18 * GiB })
    expect(deps.calls).toEqual([])
  })

  it.each([
    ['an Intel Mac', 'darwin', 'x64'],
    ['Linux on arm64', 'linux', 'arm64'],
    ['Windows', 'win32', 'x64'],
  ])('says nothing on %s, whose GPU memory is its own', (_name, platform, arch) => {
    expect(probeUnifiedMemory(fakeProbeDeps({ platform, arch, totalmem: 32 * GiB }))).toBeUndefined()
  })

  it('says nothing when RAM cannot be read', () => {
    expect(
      probeUnifiedMemory(fakeProbeDeps({ platform: 'darwin', arch: 'arm64', totalmem: 0 }))
    ).toBeUndefined()
  })
})
