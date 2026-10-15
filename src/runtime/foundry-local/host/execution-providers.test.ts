import { describe, expect, it } from 'vitest'
import { FOUNDRY_LOCAL_EXECUTION_PROVIDERS } from '../../../contracts/index.js'
import { describeDiscoverable, executionProvider } from './execution-providers.js'

describe('execution provider spellings', () => {
  it('has the registration and metadata spelling of every accelerator a variant may name', () => {
    for (const short of FOUNDRY_LOCAL_EXECUTION_PROVIDERS) expect(executionProvider(short).short).toBe(short)
    // The spike: `Load` wants the catalog spelling, registration the ORT one (rulings S1, finding 6).
    expect(executionProvider('webgpu')).toMatchObject({
      register: 'WebGpuExecutionProvider',
      metadata: 'WebGPUExecutionProvider',
    })
    expect(executionProvider('cpu').register).toBeNull()
  })

  it('describes what the library finds, OpenVINO as GPU or NPU and TensorRT-RTX as not run here', () => {
    expect(describeDiscoverable('CUDAExecutionProvider')).toEqual({
      execution_provider: 'cuda',
      device: 'gpu',
    })
    expect(describeDiscoverable('OpenVINOExecutionProvider')).toEqual({
      execution_provider: 'openvino',
      device: 'gpu/npu',
    })
    expect(describeDiscoverable('NvTensorRTRTXExecutionProvider')).toEqual({
      execution_provider: null,
      device: 'gpu',
    })
    expect(describeDiscoverable('SomethingNew')).toEqual({ execution_provider: null, device: 'unknown' })
  })
})
