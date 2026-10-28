import { describe, expect, it } from 'vitest'
import { GeniexAcceleratorService } from './accelerators.js'

const BUILD = {
  dir: '/d/geniex/backends/0.9.3/win-arm64',
  version: '0.9.3',
  devices: ['HTP0', 'GPUOpenCL', 'CPU'],
}
const service = (devices: string[] | null) =>
  new GeniexAcceleratorService({
    resolveBuild: async () => (devices ? { ...BUILD, devices } : undefined),
    chip: 'x-elite',
  })

describe('GeniexAcceleratorService (task 6.4)', () => {
  it("lists the NPU and the GPU the active build found, prepared, in LiteRT-LM's shape", async () => {
    expect(await service(['HTP0', 'GPUOpenCL', 'CPU']).list()).toEqual({
      installed: true,
      build: '0.9.3/win-arm64',
      chip: 'x-elite',
      accelerators: [
        { name: 'npu', device: 'npu', version: '0.9.3', size_bytes: 0, prepared: true },
        { name: 'gpu', device: 'gpu', version: '0.9.3', size_bytes: 0, prepared: true },
      ],
      error: null,
    })
    expect((await service(['GPUOpenCL', 'CPU']).list()).accelerators.map((a) => a.name)).toEqual(['gpu'])
    expect(await service(null).list()).toEqual({
      installed: false,
      build: null,
      chip: 'x-elite',
      accelerators: [],
      error: null,
    })
  })

  it('has nothing to prepare: every listed name is prepared, a missing one says why, without downloads or events', async () => {
    expect(await service(['HTP0', 'GPUOpenCL']).prepare({})).toEqual({
      accelerators: [
        { name: 'npu', prepared: true, reason: expect.stringMatching(/Nothing to prepare/) },
        { name: 'gpu', prepared: true, reason: expect.stringMatching(/Nothing to prepare/) },
      ],
    })
    expect(await service(['GPUOpenCL']).prepare({ accelerators: ['npu', 'openvino'] })).toEqual({
      accelerators: [
        { name: 'npu', prepared: false, reason: 'GenieX found no NPU on this computer.' },
        { name: 'openvino', prepared: false, reason: 'GenieX has no openvino accelerator.' },
      ],
    })
    expect(await service(null).prepare({ accelerators: ['npu'] })).toEqual({
      accelerators: [{ name: 'npu', prepared: false, reason: 'GenieX is not installed on this computer.' }],
    })
  })
})
