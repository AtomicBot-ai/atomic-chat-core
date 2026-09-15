import { describe, expect, it } from 'vitest'
import {
  classifyBackendMismatch,
  cpuHasAvx,
  formatLoadError,
  gpuKindOf,
  isConcreteVersionBackend,
  isCpuBackend,
  isGpuBackendCategory,
  isRecoverableLoadError,
  isUnsupportedNoAvxCpu,
  modelLoadReadyTimeoutSecs,
  parseBuildNumberStrict,
  parseEnvString,
  runtimeRanOnCpu,
  stripBom,
  codedLoadError,
} from './policy.js'

describe('id helpers', () => {
  it.each([
    ['b6325/macos-arm64', true],
    ['\uFEFF b6325/macos-arm64 ', true],
    ['', false],
    ['none', false],
    ['b6325', false],
    ['latest/macos-arm64', false],
    [null, false],
  ])('isConcreteVersionBackend(%j) = %s', (v, e) => expect(isConcreteVersionBackend(v)).toBe(e))
  it('isCpuBackend / parseBuildNumberStrict / stripBom', () => {
    expect(isCpuBackend('win-cpu-x64')).toBe(true)
    expect(isCpuBackend('macos-arm64')).toBe(false)
    expect(isCpuBackend('\uFEFFLINUX-CPU-ARM64')).toBe(true)
    expect(parseBuildNumberStrict('b6325')).toBe(6325)
    expect(parseBuildNumberStrict('b10018-1.3.0')).toBeNull()
    expect(stripBom('\uFEFF x ')).toBe('x')
  })
})

describe('AVX preflight', () => {
  it('cpuHasAvx accepts avx, avx2 and avx512*', () => {
    expect(cpuHasAvx(['sse2', 'AVX'])).toBe(true)
    expect(cpuHasAvx(['avx512_f'])).toBe(true)
    expect(cpuHasAvx(['sse2'])).toBe(false)
    expect(cpuHasAvx([])).toBe(false)
    expect(cpuHasAvx(null)).toBe(false)
  })
  it('blocks only on a positive no-AVX signal', () => {
    expect(isUnsupportedNoAvxCpu('x86_64', 'win-cpu-x64', ['sse2'])).toBe(true)
    expect(isUnsupportedNoAvxCpu('amd64', 'linux-cpu-x64', ['sse2'])).toBe(true)
    expect(isUnsupportedNoAvxCpu('x86_64', 'win-cpu-x64', ['avx'])).toBe(false)
    expect(isUnsupportedNoAvxCpu('x86_64', 'win-cuda-12.4-x64', ['sse2'])).toBe(false)
    expect(isUnsupportedNoAvxCpu('x86_64', 'win-cpu-x64', [])).toBe(false)
    expect(isUnsupportedNoAvxCpu('aarch64', 'linux-cpu-arm64', ['neon'])).toBe(false)
  })
})

describe('backend mismatch', () => {
  const categoryOf = (b: string) =>
    b.includes('cuda-13') ? 'cuda-cu13' : b.includes('vulkan') ? 'vulkan' : 'cpu'
  it('category helpers', () => {
    expect(isGpuBackendCategory('vulkan')).toBe(true)
    expect(isGpuBackendCategory('cpu')).toBe(false)
    expect(gpuKindOf('cuda-cu12.4')).toBe('cuda')
    expect(gpuKindOf('vulkan')).toBe('vulkan')
    expect(gpuKindOf('cpu')).toBe('other')
    expect(runtimeRanOnCpu({ gpu_layers_offloaded: 0 })).toBe(true)
    expect(runtimeRanOnCpu({ primary_device: 'CPU_Mapped' })).toBe(true)
    expect(runtimeRanOnCpu({ primary_device: 'CUDA0' })).toBe(false)
    expect(runtimeRanOnCpu(null)).toBe(false)
  })
  it('reports silent-fallback, runtime-cpu, suboptimal-config and ok in that precedence', () => {
    expect(classifyBackendMismatch({ configuredBackend: '', effectiveBackend: '', categoryOf })).toEqual({
      kind: 'ok',
    })
    expect(classifyBackendMismatch({ configuredBackend: 'a', effectiveBackend: 'b', categoryOf })).toEqual({
      kind: 'silent-fallback',
      configured: 'a',
      effective: 'b',
    })
    expect(
      classifyBackendMismatch({
        configuredBackend: 'win-cuda-13-x64',
        effectiveBackend: 'win-cuda-13-x64',
        runtimeDevice: {
          gpu_layers_offloaded: 0,
          total_layers: 33,
          cuda_runtime_missing: true,
          device_init_error: 'x',
        },
        categoryOf,
      })
    ).toEqual({
      kind: 'runtime-cpu',
      configured: 'win-cuda-13-x64',
      primaryDevice: 'CPU',
      offloaded: 0,
      total: 33,
      gpuKind: 'cuda',
      cudaRuntimeMissing: true,
      deviceInitError: 'x',
    })
    expect(
      classifyBackendMismatch({
        configuredBackend: 'win-cuda-13-x64',
        effectiveBackend: 'win-cuda-13-x64',
        runtimeDevice: { gpu_layers_offloaded: 0 },
        requestedGpuLayers: 0,
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
    expect(
      classifyBackendMismatch({
        configuredBackend: 'win-cpu-x64',
        effectiveBackend: '',
        idealBackend: 'win-vulkan-x64',
        categoryOf,
      })
    ).toEqual({ kind: 'suboptimal-config', configured: 'win-cpu-x64', ideal: 'win-vulkan-x64' })
    expect(
      classifyBackendMismatch({
        configuredBackend: 'win-vulkan-x64',
        effectiveBackend: 'win-vulkan-x64',
        idealBackend: 'win-vulkan-x64',
        categoryOf,
      })
    ).toEqual({ kind: 'ok' })
  })
})

describe('env, timeout, errors', () => {
  it('parseEnvString keeps `=` inside values and drops LLAMA* keys', () => {
    expect(parseEnvString('A=1; B = x=y ;LLAMA_ARG=z;;C')).toEqual({ A: '1', B: 'x=y' })
  })
  it('modelLoadReadyTimeoutSecs floors at 1800 and honours larger values', () => {
    expect(modelLoadReadyTimeoutSecs(600)).toBe(1800)
    expect(modelLoadReadyTimeoutSecs(3600)).toBe(3600)
    expect(modelLoadReadyTimeoutSecs('abc')).toBe(1800)
    expect(modelLoadReadyTimeoutSecs(0)).toBe(1800)
  })
  it('formatLoadError renders codes and details, never [object Object]', () => {
    expect(formatLoadError(new Error('boom'))).toBe('boom')
    expect(formatLoadError(codedLoadError('MODEL_FILE_CORRUPT', 'bad', 'why'))).toBe(
      'bad\nwhy [MODEL_FILE_CORRUPT]'
    )
    expect(formatLoadError({ code: 'X', message: 'm', details: 'd' })).toBe('m\nd [X]')
    expect(formatLoadError({ weird: 1 })).toBe('{"weird":1}')
    expect(formatLoadError({})).toBe('[object Object]'.replace('[object Object]', String({})))
    expect(formatLoadError('s')).toBe('s')
  })
  it('isRecoverableLoadError recognises the shared code set', () => {
    expect(isRecoverableLoadError(codedLoadError('CPU_NO_AVX', 'x'))).toBe(true)
    expect(isRecoverableLoadError({ code: 'OUT_OF_MEMORY' })).toBe(false)
    expect(isRecoverableLoadError(null)).toBe(false)
  })
})
