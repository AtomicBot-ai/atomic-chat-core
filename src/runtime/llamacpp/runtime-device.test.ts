import { describe, expect, it } from 'vitest'
import {
  isInconclusive,
  parseLoadedBackend,
  parseModelBuffer,
  parseOffloadedLayers,
  parseRepeatingLayers,
  parseSize,
  RuntimeDeviceAccumulator,
} from './runtime-device.js'

const ingestAll = (log: string) => {
  const acc = new RuntimeDeviceAccumulator()
  for (const line of log.split('\n')) acc.ingest(line.trimEnd())
  return acc.snapshot()
}

describe('line parsers', () => {
  it.each([
    ['load_backend: loaded RPC backend from x.so', 'RPC'],
    ['load_backend: loaded', undefined],
    ['load_backend: loaded  backend', undefined],
    ['some other line', undefined],
  ])('parseLoadedBackend(%j) = %j', (l, e) => expect(parseLoadedBackend(l)).toBe(e))

  it.each([
    ['load_tensors: offloaded 33/33 layers to GPU', [33, 33]],
    ['llm_load_tensors: offloaded 0/33 layers to GPU', [0, 33]],
    ['load_tensors: offloaded many/33 layers to GPU', undefined],
    ['load_tensors: offloaded 33 layers to GPU', undefined],
    ['offloaded 1/2 layers to CPU', undefined],
  ])('parseOffloadedLayers(%j) = %j', (l, e) => expect(parseOffloadedLayers(l)).toEqual(e))

  it.each([
    ['load_tensors: offloading 32 repeating layers to GPU', 32],
    ['load_tensors: offloading x repeating layers to GPU', undefined],
  ])('parseRepeatingLayers(%j) = %j', (l, e) => expect(parseRepeatingLayers(l)).toBe(e))

  it.each([
    [' 1.00 GiB', 1024 ** 3],
    ['  512.00 MiB', 512 * 1024 ** 2],
    ['  2.00 KiB', 2048],
    ['  4096', 4096],
    ['  4096.00 TiB', 4096],
    ['  not-a-number MiB', undefined],
    ['  -1 MiB', undefined],
    ['  1e3 KiB', 1024000],
  ])('parseSize(%j) = %j', (t, e) => expect(parseSize(t)).toBe(e))

  it.each([
    [
      'load_tensors:        CUDA0 model buffer size =  4155.99 MiB',
      ['CUDA0', Math.trunc(4155.99 * 1024 * 1024)],
    ],
    [
      'llm_load_tensors:   CPU_Mapped model buffer size =   308.23 MiB',
      ['CPU_Mapped', Math.trunc(308.23 * 1024 * 1024)],
    ],
    ['kv_cache:        CUDA0 model buffer size =  4096.00 MiB', undefined],
    ['load_tensors: model buffer size = 1 MiB', undefined],
  ])('parseModelBuffer(%j) = %j', (l, e) => expect(parseModelBuffer(l)).toEqual(e))
})

describe('RuntimeDeviceAccumulator', () => {
  it('reports a healthy CUDA load', () => {
    const info = ingestAll(`load_backend: loaded CUDA backend from a.dll
load_backend: loaded CPU backend from b.dll
load_tensors: offloading 32 repeating layers to GPU
load_tensors: offloaded 33/33 layers to GPU
load_tensors:        CUDA0 model buffer size =  4155.99 MiB
load_tensors:   CPU_Mapped model buffer size =   308.23 MiB`)
    expect(info.loaded_backends).toEqual(['CUDA', 'CPU'])
    expect(info.primary_device).toBe('CUDA0')
    expect(info.gpu_layers_offloaded).toBe(33)
    expect(info.total_layers).toBe(33)
    expect(info.gpu_buffer_bytes).toBe(Math.trunc(4155.99 * 1024 * 1024))
    expect(isInconclusive(info)).toBe(false)
  })

  it('breaks buffer ties toward the smaller label and reports CPU when nothing was offloaded', () => {
    const tie = ingestAll(`load_tensors: offloaded 33/33 layers to GPU
load_tensors:        CUDA1 model buffer size =  2048.00 MiB
load_tensors:        CUDA0 model buffer size =  2048.00 MiB`)
    expect(tie.primary_device).toBe('CUDA0')
    const cpu = ingestAll(`load_tensors: offloaded 0/33 layers to GPU
load_tensors:        CUDA0 model buffer size =   256.00 MiB`)
    expect(cpu.primary_device).toBe('CPU')
    expect(cpu.gpu_buffer_bytes).toBe(256 * 1024 * 1024)
  })

  it('is inconclusive on an empty log and conclusive once cuda-runtime-missing is marked', () => {
    expect(isInconclusive(ingestAll(''))).toBe(true)
    const acc = new RuntimeDeviceAccumulator()
    acc.markCudaRuntimeMissing()
    expect(acc.snapshot().cuda_runtime_missing).toBe(true)
    expect(isInconclusive(acc.snapshot())).toBe(false)
  })

  it('keeps the first device-init error and keeps parsing afterwards', () => {
    const info = ingestAll(`ggml_cuda_init: failed to initialize CUDA: unknown error
ggml_vulkan: No devices found
load_backend: loaded CPU backend from a.so`)
    expect(info.device_init_error).toBe('ggml_cuda_init: failed to initialize CUDA: unknown error')
    expect(info.loaded_backends).toEqual(['CPU'])
  })
})
