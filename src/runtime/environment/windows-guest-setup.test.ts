import { describe, expect, it } from 'vitest'
import { fakeWindows, type FakeWindowsMachine } from '../../../test/helpers/fake-windows-host.js'
import type { FakeWslGuest } from '../../../test/helpers/fake-wsl.mjs'
import {
  GUEST_OWNER_MARKER,
  guestWslConf,
  importDistribution,
  restoreDefaultDistribution,
  setupGuest,
} from './windows-guest-setup.js'

const signal = new AbortController().signal
const noSleep = async (): Promise<void> => undefined

const machine = (
  guest: FakeWslGuest = { files: {}, dirs: ['/run/systemd/system'], users: [] }
): FakeWindowsMachine => ({
  wsl: {
    installed: true,
    ready: true,
    distributions: [
      { name: 'Ubuntu', state: 'Stopped', version: 2, is_default: true },
      { name: 'AtomicChat', state: 'Stopped', version: 2, is_default: false },
    ],
    guests: { AtomicChat: guest },
  },
  machine: 'x86_64',
  release: '10.0.22631',
  elevated: false,
  virtualization: { firmware: true, hypervisor: true },
  nvidia: null,
  wslconfig: null,
  volume_free_bytes: null,
  vhdx_bytes: null,
})

describe('importDistribution', () => {
  it('fails with both answers when neither --import nor --install --from-file takes the file', async () => {
    const windows = fakeWindows({
      ...machine(),
      wsl: { installed: true, ready: true, distributions: [], import_fails: ['import', 'install'] },
    })
    await expect(
      importDistribution(windows.wsl, { name: 'AtomicChat', path: 'C:\\x', rootfs: 'C:\\r.wsl' }, signal)
    ).rejects.toMatchObject({
      code: 'MANAGED_PREREQUISITE_BLOCKED',
      details: expect.stringContaining('--install --from-file'),
    })
  })
})

describe('restoreDefaultDistribution', () => {
  it('leaves a default that is still the user’s, and puts back one the import took', async () => {
    const windows = fakeWindows(machine())
    await restoreDefaultDistribution(windows.wsl, 'Ubuntu', signal)
    expect(windows.wslCalls.some((argv) => argv[0] === '--set-default')).toBe(false)
    windows.machine.wsl.distributions = (windows.machine.wsl.distributions ?? []).map((d) => ({
      ...d,
      is_default: d.name === 'AtomicChat',
    }))
    await restoreDefaultDistribution(windows.wsl, 'Ubuntu', signal)
    expect(windows.wslCalls.at(-1)).toEqual(['--set-default', 'Ubuntu'])
  })
})

describe('setupGuest', () => {
  it('reuses a uid-1000 account the rootfs already has, and does not restart a guest already set up', async () => {
    const guest: FakeWslGuest = {
      files: { '/etc/wsl.conf': guestWslConf('ubuntu'), [GUEST_OWNER_MARKER]: 'marker-1\n' },
      dirs: ['/run/systemd/system'],
      users: [{ name: 'ubuntu', uid: 1000 }],
    }
    const windows = fakeWindows(machine(guest))
    const answer = await setupGuest(
      { wsl: windows.wsl, sleep: noSleep },
      windows.wsl.distribution('AtomicChat'),
      'marker-1',
      signal
    )
    expect(answer).toEqual({ user: 'ubuntu', restarted: false })
    expect(windows.wslCalls.flat()).not.toContain('useradd')
    expect(windows.wslCalls.flat()).not.toContain('--terminate')
  })

  it('refuses a distribution carrying another installation’s marker', async () => {
    const windows = fakeWindows(
      machine({ files: { [GUEST_OWNER_MARKER]: 'someone-else\n' }, dirs: [], users: [] })
    )
    await expect(
      setupGuest(
        { wsl: windows.wsl, sleep: noSleep },
        windows.wsl.distribution('AtomicChat'),
        'marker-1',
        signal
      )
    ).rejects.toMatchObject({ details: 'foreign-distribution' })
  })

  it('gives up when systemd never comes up after the restart', async () => {
    const windows = fakeWindows(machine({ files: {}, dirs: [], users: [] }))
    await expect(
      setupGuest(
        { wsl: windows.wsl, sleep: noSleep },
        windows.wsl.distribution('AtomicChat'),
        'marker-1',
        signal
      )
    ).rejects.toThrow(/systemd did not start/)
  })

  it('writes wsl.conf with systemd, the default user and no Windows PATH', () => {
    expect(guestWslConf('atomic')).toBe(
      '[boot]\nsystemd=true\n\n[user]\ndefault=atomic\n\n[interop]\nappendWindowsPath=false\n'
    )
  })
})
