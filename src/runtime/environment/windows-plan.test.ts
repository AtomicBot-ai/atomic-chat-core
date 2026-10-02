import { describe, expect, it } from 'vitest'
import { readRuntimeFixture } from '../../../test/helpers/runtime-fixtures.js'
import { parseWindowsEnvironmentManifest } from './environment-manifest.js'
import { assessWindowsHost, GUEST_BASE_BYTES, type WindowsAssessmentInput } from './windows-plan.js'
import type { WindowsHostFacts } from './windows-probe.js'

const MANIFEST = parseWindowsEnvironmentManifest(readRuntimeFixture('environments/windows.json'))
const GIB = 1024 ** 3

const facts = (over: Partial<WindowsHostFacts> = {}): WindowsHostFacts => ({
  architecture: 'x86_64',
  windows_build: 22631,
  elevated: false,
  wsl: { installed: true, version: '2.4.4', ready: true, reboot_pending: false },
  virtualization: true,
  driver_installed: true,
  driver_version: '591.44',
  gpus: [
    {
      gpu_id: 'GPU-1',
      name: 'NVIDIA GeForce RTX 4070',
      compute_capability: '8.9',
      total_vram_bytes: 12 * GIB,
      free_vram_bytes: 11 * GIB,
      driver_version: '591.44',
    },
  ],
  distributions: [],
  wslconfig: { networking_mode: null, localhost_forwarding: null, memory: null },
  unknown: [],
  ...over,
})

const input = (over: Partial<WindowsAssessmentInput> = {}): WindowsAssessmentInput => ({
  facts: facts(),
  manifest: MANIFEST,
  owned: null,
  foreign: false,
  distribution: { name: 'AtomicChat', path: 'C:\\AtomicChat' },
  volumeFreeBytes: 500 * GIB,
  guest: null,
  guestRecipeId: 'linux.install-container-runtime',
  minimumDriverVersion: '590.44.01',
  minimumComputeCapability: '8.0',
  requiredDiskBytes: 60 * GIB,
  ...over,
})

describe('assessWindowsHost', () => {
  it('a fresh import needs the image and room for the guest itself', () => {
    const exact = assessWindowsHost(input({ volumeFreeBytes: 60 * GIB + GUEST_BASE_BYTES }))
    const short = assessWindowsHost(input({ volumeFreeBytes: 60 * GIB + GUEST_BASE_BYTES - 1 }))
    expect(exact.disk_sufficient).toBe(true)
    expect(short.disk_sufficient).toBe(false)
    expect(short.blockers.map((b) => b.reason)).toEqual(['insufficient-disk'])
  })

  it('nothing left to pull and the distribution there: no disk check at all', () => {
    const owned = { name: 'AtomicChat', state: 'Running', version: 2, is_default: false }
    const verdict = assessWindowsHost(input({ owned, requiredDiskBytes: null, volumeFreeBytes: 0 }))
    expect(verdict.disk_sufficient).toBe(true)
  })

  it('an unreadable free space is not "insufficient"', () => {
    const verdict = assessWindowsHost(input({ volumeFreeBytes: null }))
    expect(verdict.disk_sufficient).toBeNull()
    expect(verdict.blockers).toEqual([])
  })

  it('WSL installed but Windows waiting for a restart: a restart blocker, no second elevation', () => {
    const verdict = assessWindowsHost(
      input({
        facts: facts({ wsl: { installed: true, version: '3.0.1', ready: false, reboot_pending: true } }),
      })
    )
    expect(verdict.enable_wsl).toBe(false)
    expect(verdict.blockers.map((b) => b.reason)).toContain('windows-restart-pending')
  })

  it('unknown virtualization does not block enabling WSL (ruling core 2.3)', () => {
    const verdict = assessWindowsHost(
      input({
        facts: facts({
          wsl: { installed: false, version: null, ready: null, reboot_pending: null },
          virtualization: null,
        }),
      })
    )
    expect(verdict.enable_wsl).toBe(true)
    expect(verdict.blockers).toEqual([])
  })

  it('an unread WSL blocks as an unknown fact, offering nothing', () => {
    const verdict = assessWindowsHost(
      input({
        facts: facts({
          wsl: { installed: null, version: null, ready: null, reboot_pending: null },
          unknown: ['wsl'],
        }),
      })
    )
    expect(verdict.availability).toBe('prerequisite-blocked')
    expect(verdict.blockers.map((b) => b.reason)).toEqual(['unknown-fact'])
    expect(verdict.system_changes).toEqual([])
  })

  it('a card below the minimum compute capability blocks with both numbers', () => {
    const old = facts().gpus.map((gpu) => ({ ...gpu, compute_capability: '7.5' }))
    const verdict = assessWindowsHost(input({ facts: facts({ gpus: old }) }))
    expect(verdict.blockers).toEqual([
      expect.objectContaining({
        reason: 'compute-capability-too-low',
        params: { required: '8.0', actual: '7.5' },
      }),
    ])
  })
})
