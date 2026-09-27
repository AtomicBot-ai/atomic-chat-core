import { describe, expect, it } from 'vitest'
import type { SystemInfo } from '../contracts/index.js'
import type { HardwareProbeResult } from './probe-common.js'
import { HardwareService } from './service.js'

const probed: SystemInfo = {
  cpu: {
    name: 'AMD Ryzen 9 7950X 16-Core Processor',
    core_count: 16,
    arch: 'x86_64',
    extensions: ['fpu', 'avx', 'avx2'],
    extensions_known: true,
  },
  os_type: 'linux',
  os_name: 'Ubuntu 24.04.1 LTS',
  total_memory: 65_536,
  gpus: [
    {
      name: 'NVIDIA GeForce RTX 4090',
      total_memory: 24_564,
      vendor: 'NVIDIA',
      uuid: 'abc',
      driver_version: '581.42',
      nvidia_info: { index: 0, compute_capability: '8.9' },
      vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '1.3.277', device_id: 0x2684 },
    },
  ],
}

interface Harness {
  service: HardwareService
  probes: number
  release: () => void
  logs: string[]
  clock: { now: number }
}

function harness(over: { probe?: () => Promise<HardwareProbeResult>; gated?: boolean } = {}): Harness {
  const logs: string[] = []
  const clock = { now: 1_000 }
  let release = () => {}
  const h: Harness = {
    probes: 0,
    release: () => release(),
    logs,
    clock,
    service: undefined as unknown as HardwareService,
  }
  const probe =
    over.probe ??
    (async () => {
      h.probes += 1
      if (over.gated) await new Promise<void>((resolve) => (release = resolve))
      return { info: structuredClone(probed), warnings: h.probes > 1 ? [`probe ${h.probes}`] : [] }
    })
  h.service = new HardwareService({
    probe,
    arch: 'x64',
    platform: 'linux',
    now: () => clock.now,
    log: (level, message) => logs.push(`${level}: ${message}`),
  })
  return h
}

describe('HardwareService', () => {
  it('probes once on start, and every reader gets that answer as probe facts', async () => {
    const h = harness()
    h.service.start()
    h.service.start()
    const info = await h.service.info()
    expect(info).toEqual({ info: probed, source: 'probe', probed_at: 1_000, warnings: [] })
    expect(info.info).not.toBe(probed)
    await expect(h.service.facts()).resolves.toEqual({
      osType: 'linux',
      arch: 'x86_64',
      cpuExtensions: ['fpu', 'avx', 'avx2'],
      gpus: probed.gpus,
      source: 'probe',
    })
    expect(h.probes).toBe(1)
    expect(h.logs).toEqual([])
  })

  it('starts the probe lazily for a caller that never called start()', async () => {
    const h = harness()
    await expect(h.service.facts()).resolves.toMatchObject({ source: 'probe' })
    expect(h.probes).toBe(1)
  })

  it('makes facts() wait for the probe in flight instead of answering on ignorance', async () => {
    const h = harness({ gated: true })
    h.service.start()
    let settled = false
    const facts = h.service.facts().then((f) => {
      settled = true
      return f
    })
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    h.release()
    await expect(facts).resolves.toMatchObject({ cpuExtensions: ['fpu', 'avx', 'avx2'] })
  })

  it('refresh() runs a new probe and answers with it, coalescing with one already running', async () => {
    const h = harness()
    await h.service.info()
    h.clock.now = 2_000
    const refreshed = await h.service.refresh()
    expect(refreshed).toMatchObject({ probed_at: 2_000, warnings: ['probe 2'] })
    expect(h.probes).toBe(2)
    expect(h.logs).toEqual(['info: hardware probe: probe 2'])
    expect((await h.service.info()).probed_at).toBe(2_000)

    const gated = harness({ gated: true })
    gated.service.start()
    const a = gated.service.refresh()
    const b = gated.service.refresh()
    gated.release()
    await Promise.all([a, b])
    expect(gated.probes).toBe(1)
  })

  it('serves an override wholesale while it stands, and goes back to the probe when cleared', async () => {
    const h = harness()
    await h.service.info()
    h.clock.now = 5_000
    const applied = h.service.setOverride({
      gpus: [
        {
          vendor: 'AMD',
          total_memory: 24_576,
          vulkan_info: { device_id: 0x744c, device_type: 'DiscreteGpu' },
        },
      ],
      cpu_extensions: ['AVX'],
      os_type: 'windows',
      source: 'test',
    })
    expect(applied).toMatchObject({ received_at: 5_000, cpu_extensions: ['avx'], source: 'test' })
    expect(h.service.getOverride()).toEqual(applied)
    expect(h.logs).toContain('info: hardware override accepted from test: 1 GPU(s)')

    const info = await h.service.info()
    expect(info.source).toBe('override')
    expect(info.probed_at).toBe(1_000)
    expect(info.info.os_type).toBe('windows')
    expect(info.info.cpu).toEqual({ ...probed.cpu, extensions: ['avx'] })
    expect(info.info.total_memory).toBe(65_536)
    expect(info.info.gpus).toEqual([
      {
        name: 'GPU 0',
        total_memory: 24_576,
        vendor: 'AMD',
        uuid: 'override-0',
        driver_version: '',
        nvidia_info: null,
        vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '', device_id: 0x744c },
      },
    ])
    await expect(h.service.facts()).resolves.toMatchObject({
      osType: 'windows',
      cpuExtensions: ['avx'],
      gpus: [{ vendor: 'AMD' }],
      source: 'override',
    })

    expect(h.service.clearOverride()).toBe(true)
    expect(h.service.clearOverride()).toBe(false)
    expect(h.service.getOverride()).toBeUndefined()
    expect((await h.service.info()).source).toBe('probe')
    expect(h.probes).toBe(1)
  })

  it('refuses a malformed override without touching the facts', async () => {
    const h = harness()
    expect(() => h.service.setOverride({ cpu_extensions: ['avx'] })).toThrow(/gpus/)
    expect(() => h.service.setOverride({ gpus: [1] })).toThrow(/gpus\[0\]/)
    expect((await h.service.info()).source).toBe('probe')
  })

  it('turns a probe that throws into a minimal answer plus a warning, and logs it', async () => {
    const h = harness({
      probe: async () => {
        throw new Error('sysfs on fire')
      },
    })
    const info = await h.service.info()
    expect(info).toEqual({
      info: {
        cpu: { name: 'Unknown CPU', core_count: 0, arch: 'x86_64', extensions: [], extensions_known: false },
        os_type: 'linux',
        os_name: '',
        total_memory: 0,
        gpus: [],
      },
      source: 'probe',
      probed_at: 1_000,
      warnings: ['hardware probe failed: sysfs on fire'],
    })
    await expect(h.service.facts()).resolves.toMatchObject({
      cpuExtensions: undefined,
      gpus: [],
      osType: 'linux',
    })
    expect(h.logs).toEqual([
      'warn: hardware probe failed: sysfs on fire',
      'info: hardware probe: hardware probe failed: sysfs on fire',
    ])
    const silent = new HardwareService({ probe: async () => Promise.reject('nope'), arch: 'arm64' })
    expect((await silent.info()).info).toMatchObject({ os_type: 'unknown', cpu: { arch: 'arm64' } })
  })

  it('takes the architecture from the probe, and from the constructor only when the probe left it blank', async () => {
    // A canned probe describes a whole host, including one of another architecture than this process.
    const foreign = harness({
      probe: async () => ({
        info: { ...structuredClone(probed), cpu: { ...probed.cpu, arch: 'x86_64' } },
        warnings: [],
      }),
    })
    expect((await foreign.service.facts()).arch).toBe('x86_64')
    const blank = harness({
      probe: async () => ({
        info: { ...structuredClone(probed), cpu: { ...probed.cpu, arch: '' } },
        warnings: [],
      }),
    })
    expect((await blank.service.facts()).arch).toBe('x86_64')
  })
})
