import { expect, it, vi } from 'vitest'
import windowsXrt from '../../test/fixtures/fastflowlm/windows-xrt-pci.json' with { type: 'json' }
import { nodeProbeDeps } from './probe.js'
import { probeFastFlowLm } from './fastflowlm-probe.js'

const bdf = '0000:c6:00.1'
const firmware = {
  device: '/dev/accel/accel0',
  fw_major: 1,
  fw_minor: 1,
  fw_patch: 2,
  fw_build: 64,
  fw_ok: true,
  cols: 8,
}
const valid = {
  object: 'npu_stack_validation',
  platform: 'linux',
  npu_platform: 'aie2p',
  ready: true,
  amd_device_found: true,
  kernel_ok: true,
  all_fw_ok: true,
  enough_cols: true,
  memlock_ok: true,
  drm_version: '0.8',
  devices: [firmware],
}
const build = { tag: 'flm-1.0.11-r2', dir: '/managed' }
function linux(
  opts: {
    cgroup?: string
    limit?: string
    uid?: number
    xrt?: unknown
    validation?: unknown
    timeout?: boolean
    denied?: boolean
    node?: string
    caps?: string
  } = {}
) {
  const fs = {
    readdir: async (path: string) => (path.endsWith('/accel') ? [opts.node ?? 'accel0'] : [bdf]),
    readlink: async () => '/bus/pci/drivers/amdxdna',
    readFile: async (path: string) => {
      if (path.endsWith('status')) return 'CapEff:\t' + (opts.caps ?? '0000000000000000')
      if (path.endsWith('limits'))
        return (
          'Max locked memory         ' +
          (opts.limit ?? 'unlimited') +
          '            unlimited            bytes'
        )
      if (path.endsWith('cgroup')) return opts.cgroup ?? '0::/user.slice/user-1000.slice/session-2.scope'
      return (
        ({ vendor: '0x1022', device: '0x17f0', revision: '0x20' } as Record<string, string>)[
          path.split('/').pop()!
        ] ?? ''
      )
    },
    exists: async () => true,
  }
  const run = vi.fn(async (_file: string, args: string[]) => {
    if (opts.timeout) throw Error('timeout')
    const out =
      args[0] === 'atomic-capabilities'
        ? { environment_probe_protocol: 1 }
        : args[0] === 'atomic-xrt'
          ? (opts.xrt ?? { open: true, bdf })
          : (opts.validation ?? valid)
    return { code: 0, stdout: JSON.stringify(out), stderr: '' }
  })
  const deps = nodeProbeDeps({ platform: 'linux', arch: 'x64', fs, run })
  return {
    run,
    probe: () =>
      probeFastFlowLm(deps, {
        supported: true,
        build,
        account: () => ({ name: 'lex', uid: opts.uid ?? 1000 }),
        deviceAccess: async () => {
          if (opts.denied) throw Object.assign(Error(), { code: 'EACCES' })
          return true
        },
      }),
  }
}
it('requires the selected XRT to open the same device after successful DRM validation', async () => {
  expect(await linux().probe()).toMatchObject({
    ready: true,
    runtime_account: 'lex',
    runtime_mode: 'interactive',
    devices: [{ generation: 'xdna2', firmware: '1.1.2.64', ready: true }],
  })
  for (const xrt of [{ open: false }, { open: true, bdf: '0000:01:00.0' }])
    expect(await linux({ xrt }).probe()).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining(['xrt-device-unavailable']),
    })
})
it('uses the service process soft limit even when its hard limit permits unlimited memory', async () => {
  for (const [cgroup, mode] of [
    ['0::/system.slice/atc.service', 'system-service'],
    ['0::/user.slice/user-1000.slice/user@1000.service/app.slice/atc.service', 'user-service'],
  ] as const)
    expect(await linux({ cgroup, limit: '8388608' }).probe()).toMatchObject({
      ready: false,
      runtime_mode: mode,
      runtime_service: 'atc.service',
      memlock_bytes: '8388608',
      blockers: expect.arrayContaining(['memlock-too-low']),
    })
})
it('fails closed for root, a timeout, and incomplete native output', async () => {
  const root = linux({ uid: 0 })
  expect((await root.probe()).blockers).toContain('privileged-account')
  expect(root.run).not.toHaveBeenCalled()
  for (const opts of [{ timeout: true }, { validation: { ready: true } }])
    expect((await linux(opts).probe()).ready).toBe(false)
})
it.each([
  ['17F0', 'xdna2', 'driver-missing'],
  ['1502', 'xdna1', 'xdna2-not-found'],
])('enumerates present Windows PCI %s before the AMD driver exists', async (id, generation, blocker) => {
  const run = vi.fn(async () => ({
    code: 0,
    stderr: '',
    stdout: JSON.stringify({
      account: 'HOST\\user',
      elevated: false,
      service: null,
      session: 1,
      devices: [{ id: 'PCI\\VEN_1022&DEV_' + id + '&SUBSYS_0000&REV_20\\4', problem: 28, version: null }],
    }),
  }))
  const result = await probeFastFlowLm(nodeProbeDeps({ platform: 'win32', arch: 'x64', run }), {
    supported: true,
    build: null,
  })
  expect(result).toMatchObject({
    ready: false,
    devices: [{ generation }],
    blockers: expect.arrayContaining([blocker]),
  })
  expect(run).toHaveBeenCalledTimes(1)
})

it('compares Windows XRT against the unique PnP hardware ID and uses the current service token', async () => {
  const item = {
    id: 'PCI\\VEN_1022&DEV_17F0&SUBSYS_513717AA&REV_20\\3',
    problem: 0,
    version: '32.0.203.329',
    bdf,
  }
  const wmi = {
    account: 'HOST\\inference',
    elevated: false,
    session: 0,
    service: 'AtomicChat',
    devices: [item],
  }
  const run = vi.fn(async (_exe: string, args: string[]) => {
    const data =
      args[0] === '-NoProfile'
        ? wmi
        : args[0] === 'atomic-capabilities'
          ? { environment_probe_protocol: 1 }
          : args[0] === 'atomic-validate'
            ? {
                object: valid.object,
                platform: 'windows',
                amd_device_found: true,
                npu_driver_ok: true,
                npu_platform: 'aie2p',
                ready: true,
              }
            : windowsXrt
    return { code: 0, stdout: JSON.stringify(data), stderr: '' }
  })
  const probe = () =>
    probeFastFlowLm(nodeProbeDeps({ platform: 'win32', arch: 'x64', run }), { supported: true, build })
  expect(await probe()).toMatchObject({
    ready: true,
    runtime_mode: 'system-service',
    runtime_service: 'AtomicChat',
    devices: [{ accessible: true, xrt_visible: true }],
  })
  item.id = item.id.replace('5137', '5138')
  expect((await probe()).blockers).toContain('xrt-device-unavailable')
  item.version = '32.0.203.303'
  expect((await probe()).blockers).toContain('driver-version-unconfirmed')
  wmi.elevated = true
  run.mockClear()
  expect((await probe()).blockers).toContain('privileged-account')
  expect(run).toHaveBeenCalledTimes(1)
})

it('does not call native commands on unsupported platforms or when the build lacks the read-only protocol', async () => {
  const run = vi.fn()
  expect(
    (await probeFastFlowLm(nodeProbeDeps({ platform: 'darwin', run }), { supported: false, build })).blockers
  ).toEqual(['platform-unsupported'])
  expect(run).not.toHaveBeenCalled()
  const machine = linux()
  machine.run.mockResolvedValueOnce({ code: 0, stdout: '{"local_only_protocol":1}', stderr: '' })
  expect((await machine.probe()).blockers).toContain('engine-probe-unavailable')
  expect(machine.run).toHaveBeenCalledTimes(1)
})

it('does not use a native measurement for a different device node or one with missing geometry', async () => {
  for (const device of [
    { ...firmware, device: '/dev/accel/accel1' },
    { ...firmware, cols: undefined },
  ])
    expect((await linux({ validation: { ...valid, devices: [device] } }).probe()).blockers).toContain(
      'npu-geometry-unconfirmed'
    )
})

it('checks effective device access and refuses capability overrides in a non-root service', async () => {
  const restricted = linux({ denied: true })
  const denied = await restricted.probe()
  expect(restricted.run).not.toHaveBeenCalled()
  expect(denied.blockers).toEqual(['device-access-denied'])
  expect(denied).toMatchObject({
    ready: false,
    devices: [{ accessible: false }],
    blockers: expect.arrayContaining(['device-access-denied']),
  })
  const capable = linux({ uid: 1000, caps: '00004000' })
  expect((await capable.probe()).blockers).toContain('privileged-account')
  expect(capable.run).not.toHaveBeenCalled()
})
it('keeps unknown process limits and launch contexts unconfirmed', async () => {
  expect((await linux({ cgroup: '?', limit: '?' }).probe()).blockers).toEqual(
    expect.arrayContaining(['runtime-identity-unknown', 'memlock-unknown'])
  )
})

it('checks the discovered Linux accel index when lower indices are absent', async () => {
  const machine = linux({
    node: 'accel19',
    validation: { ...valid, devices: [{ ...firmware, device: '/dev/accel/accel19' }] },
  })
  expect((await machine.probe()).ready).toBe(true)
  expect(machine.run.mock.calls.map((call) => call[1])).toContainEqual(['atomic-validate', '--json', '19'])
})
it('does not infer interactive limits from an opaque cgroup namespace', async () => {
  expect(await linux({ cgroup: '0::/' }).probe()).toMatchObject({
    ready: false,
    runtime_mode: null,
    blockers: ['runtime-identity-unknown'],
  })
})
it('keeps a busy target distinct from a missing driver or firmware', async () => {
  const machine = linux({
    validation: { ...valid, ready: false, devices: [{ device: '/dev/accel/accel0', busy: true }] },
  })
  expect(await machine.probe()).toMatchObject({
    ready: false,
    reason: 'device-busy',
    blockers: ['device-busy'],
  })
  expect(machine.run.mock.calls.some(([, args]) => args[0] === 'atomic-xrt')).toBe(false)
})
