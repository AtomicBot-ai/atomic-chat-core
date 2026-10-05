import { describe, expect, it } from 'vitest'
import { fakeWindows } from '../../../test/helpers/fake-windows-host.js'
import {
  GUEST_DOCKER,
  guestLinuxHost,
  guestProbeDeps,
  parseDfAvail,
  parseMemTotal,
  parseNvmlVersion,
  probeGuestExtras,
} from './guest-host.js'

const guestOf = () =>
  fakeWindows({
    wsl: {
      installed: true,
      ready: true,
      distributions: [{ name: 'AtomicChat', state: 'Running', version: 2, is_default: false }],
      guests: {
        AtomicChat: {
          files: {
            '/etc/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\n',
            '/proc/meminfo': 'MemTotal:  8000 kB\n',
          },
          dirs: ['/run/systemd/system'],
          free_disk_bytes: 123,
          nvml_version: '590.48.01',
          host: {
            driver: '591.44',
            docker: { installed: true, reachable: true, service_active: true, gpu_runtime: true },
          },
        },
      },
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

describe('the guest as a Linux host', () => {
  it('reads files with cat and tells "not there" apart from "could not read", as root', async () => {
    const windows = guestOf()
    const deps = guestProbeDeps(windows.wsl.distribution('AtomicChat'))

    expect(await deps.readFile('/etc/os-release')).toContain('ID=ubuntu')
    expect(await deps.readFile('/etc/docker/daemon.json')).toBeNull()
    expect(await deps.pathExists('/run/systemd/system')).toBe(true)
    expect(await deps.pathExists('/run/ostree-booted')).toBe(false)
    expect(await deps.freeDiskBytes('/var/lib/docker')).toBe(123)
    expect(windows.wslCalls).toContainEqual([
      '-d',
      'AtomicChat',
      '-u',
      'root',
      '--exec',
      'cat',
      '--',
      '/etc/os-release',
    ])
  })

  it('runs docker by its absolute path, never whatever PATH finds (a Windows docker.exe)', async () => {
    const windows = guestOf()
    await guestProbeDeps(windows.wsl.distribution('AtomicChat')).exec('docker', ['--version'])
    expect(windows.wslCalls.at(-1)).toEqual([
      '-d',
      'AtomicChat',
      '-u',
      'root',
      '--exec',
      GUEST_DOCKER,
      '--version',
    ])
  })

  it('probes as root with no session directory', () => {
    expect(guestLinuxHost(guestOf().wsl.distribution('AtomicChat')).options()).toEqual({
      user: 'root',
      xdgRuntimeDir: null,
    })
  })

  it('reads the NVIDIA library version and the VM memory that only the guest knows', async () => {
    expect(await probeGuestExtras(guestOf().wsl.distribution('AtomicChat'))).toEqual({
      nvidia_library_version: '590.48.01',
      memory_bytes: 8000 * 1024,
    })
  })
})

describe('parsers', () => {
  it('takes NVML’s version, not the driver line (which names the Windows driver)', () => {
    const stdout =
      'NVIDIA-SMI version  : 580.95.02\nNVML version        : 580.95.02\nDRIVER version      : 591.44\n'
    expect(parseNvmlVersion({ code: 0, stdout, stderr: '' })).toBe('580.95.02')
    expect(parseNvmlVersion({ code: 127, stdout: '', stderr: '' })).toBeNull()
  })

  it.each([
    ['   Avail\n913614675968\n', 913614675968],
    ['   Avail\n', null],
  ])('reads df’s answer %j', (stdout, bytes) => {
    expect(parseDfAvail({ code: 0, stdout, stderr: '' })).toBe(bytes)
  })

  it('reads MemTotal in bytes, and nothing from an unread file', () => {
    expect(parseMemTotal('MemTotal:       16303452 kB\n')).toBe(16303452 * 1024)
    expect(parseMemTotal(null)).toBeNull()
  })
})
