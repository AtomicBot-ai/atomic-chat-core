import { expect, it } from 'vitest'
import { fakeProbeDeps } from '../../test/helpers/fake-probe-deps.js'
import { probeLinux } from './probe-linux.js'

it.each([
  ['11', '5', '2', '16364404736', 15606],
  ['11', '5', '1', '68719476736', 32768],
  ['11', '0', '0', '16364404736', undefined],
  ['11', '5', '2', 'invalid', undefined],
])(
  'reports shared AMD APU memory for GC %s.%s.%s without inflating dedicated VRAM',
  async (major, minor, revision, gtt, shared) => {
    const base = '/sys/class/drm/card1/device'
    const deps = fakeProbeDeps({
      platform: 'linux',
      totalmem: 32 * 2 ** 30,
      dirs: { '/sys/class/drm': ['card1'], '/usr/share/vulkan/icd.d': ['radeon_icd.x86_64.json'] },
      files: {
        [base + '/vendor']: '0x1002',
        [base + '/device']: '0x1114',
        [base + '/mem_info_vram_total']: '536870912',
        [base + '/mem_info_gtt_total']: gtt,
        [base + '/ip_discovery/die/0/GC/0/major']: major,
        [base + '/ip_discovery/die/0/GC/0/minor']: minor,
        [base + '/ip_discovery/die/0/GC/0/revision']: revision,
      },
      links: { [base + '/driver']: '/drivers/amdgpu' },
    })
    const { info } = await probeLinux(deps)
    expect(info.gpus[0]?.total_memory).toBe(512)
    expect(info.gpus[0]).toHaveProperty('vendor', 'AMD')
    expect((info.gpus[0] as unknown as Record<string, unknown>)['shared_memory']).toBe(shared)
  }
)
