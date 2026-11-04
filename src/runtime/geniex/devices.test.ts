import { describe, expect, it } from 'vitest'
import { acceleratorsFound, deviceFound, deviceMissingReason } from './devices.js'

describe('GenieX devices (design D3)', () => {
  it('reads HTP as the NPU and GPUOpenCL as the GPU; the CPU is always there, hybrid needs both', () => {
    const all = ['HTP0', 'GPUOpenCL', 'CPU']
    expect(['npu', 'gpu', 'cpu', 'hybrid'].map((d) => deviceFound(d as never, all))).toEqual([
      true,
      true,
      true,
      true,
    ])
    expect(['npu', 'gpu', 'cpu', 'hybrid'].map((d) => deviceFound(d as never, ['GPUOpenCL', 'CPU']))).toEqual(
      [false, true, true, false]
    )
    expect(['npu', 'gpu', 'cpu', 'hybrid'].map((d) => deviceFound(d as never, []))).toEqual([
      false,
      false,
      true,
      false,
    ])
    expect(acceleratorsFound(all)).toEqual(['npu', 'gpu'])
    expect(acceleratorsFound(['GPUOpenCL'])).toEqual(['gpu'])
    expect(acceleratorsFound(['CPU'])).toEqual([])
    expect(deviceMissingReason('npu')).toMatch(/NPU driver/)
    expect(deviceMissingReason('gpu')).toMatch(/OpenCL/)
    expect(deviceMissingReason('hybrid')).toMatch(/hybrid/)
  })
})
