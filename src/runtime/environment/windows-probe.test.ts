import { describe, expect, it } from 'vitest'
import type { CommandOutput } from './linux-probe.js'
import {
  assessWindows,
  decodeWslOutput,
  parseOptionalFeatures,
  parseVirtualization,
  parseWslDistributions,
  parseWslStatus,
  probeWindows,
  type WindowsFacts,
} from './windows-probe.js'

const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' })
const missing = (): CommandOutput => ({ code: null, stdout: '', stderr: '' })

/** What `wsl.exe` really hands back when its UTF-16 output was read as UTF-8. */
const asUtf16 = (text: string): string => String.fromCharCode(0xfeff) + [...text].join(String.fromCharCode(0))

const LIST = [
  '  NAME                   STATE           VERSION',
  '* Ubuntu                 Running         2',
  '  atomic-app-7f3c        Stopped         2',
  '  Legacy                 Stopped         1',
].join('\r\n')

const FEATURES = JSON.stringify([
  { FeatureName: 'Microsoft-Windows-Subsystem-Linux', State: 2 },
  { FeatureName: 'VirtualMachinePlatform', State: 2 },
])

const SMI = 'GPU-1c6a, NVIDIA GeForce RTX 4070, 8.9, 12282, 11000, 551.23\n'

const USER = { name: 'aleks', sid: 'S-1-5-21-1' }
const ADMIN = { name: 'Administrator', sid: 'S-1-5-21-500' }

const facts = (over: Partial<WindowsFacts> = {}): WindowsFacts => ({
  features: { wsl: true, virtual_machine_platform: true, virtualization_firmware: true },
  wsl_default_version: 2,
  wsl_kernel: '5.15.167.4',
  distributions: [
    { name: 'Ubuntu', state: 'Running', version: 2, is_default: true, owned: false },
    { name: 'atomic-app-7f3c', state: 'Stopped', version: 2, is_default: false, owned: true },
  ],
  owned_distribution: {
    name: 'atomic-app-7f3c',
    state: 'Stopped',
    version: 2,
    is_default: false,
    owned: true,
  },
  driver_version: '551.23',
  gpus: [
    {
      gpu_id: 'GPU-1c6a',
      name: 'NVIDIA GeForce RTX 4070',
      compute_capability: '8.9',
      total_vram_bytes: 12_282 * 1024 * 1024,
      free_vram_bytes: 11_000 * 1024 * 1024,
      driver_version: '551.23',
    },
  ],
  original_user: USER,
  elevated_user: null,
  free_disk_bytes: 200_000_000_000,
  unknown: [],
  ...over,
})

const OPTIONS = { requiredDiskBytes: 60_000_000_000 }

describe('reading what wsl.exe says', () => {
  it('reads the UTF-16 output a caller decoded as UTF-8, instead of finding nothing', () => {
    const raw = asUtf16(LIST)
    // Without the fix this string has a NUL between every character and parses as zero rows.
    expect(raw).not.toBe(LIST)
    expect(decodeWslOutput(raw)).toBe(LIST)
    expect(parseWslDistributions(ok(raw), 'atomic-app-7f3c')).toHaveLength(3)
  })

  it('lists every distribution with its state, version and which one is default', () => {
    const rows = parseWslDistributions(ok(LIST), 'atomic-app-7f3c')
    expect(rows.map((row) => row.name)).toEqual(['Ubuntu', 'atomic-app-7f3c', 'Legacy'])
    expect(rows[0]?.is_default).toBe(true)
    expect(rows[1]?.is_default).toBe(false)
    expect(rows[2]?.version).toBe(1)
    // The header is not a distribution, whatever language it is printed in.
    expect(rows.some((row) => row.name === 'NAME')).toBe(false)
  })

  it('calls ours only the exact name this installation recorded', () => {
    const rows = parseWslDistributions(ok(LIST), 'atomic-app-7f3c')
    expect(rows.filter((row) => row.owned).map((row) => row.name)).toEqual(['atomic-app-7f3c'])
    // A distribution that merely looks like one of ours is somebody else's.
    expect(parseWslDistributions(ok(LIST), 'atomic-app-0000').some((row) => row.owned)).toBe(false)
    expect(parseWslDistributions(ok(LIST), null).some((row) => row.owned)).toBe(false)
  })

  it('reports nothing at all when wsl is not installed', () => {
    expect(parseWslDistributions(missing(), 'atomic-app')).toEqual([])
    expect(parseWslStatus(missing())).toEqual({ default_version: null, kernel: null })
  })

  it('takes the default version and kernel out of the status text', () => {
    const status = ok(asUtf16('Default Version: 2\r\nKernel version: 5.15.167.4-1\r\n'))
    expect(parseWslStatus(status).default_version).toBe(2)
    expect(parseWslStatus(status).kernel).toBe('5.15.167.4-1')
  })

  it('reads a feature state whether PowerShell gave one object or several', () => {
    expect(parseOptionalFeatures(ok(FEATURES)).get('VirtualMachinePlatform')).toBe(true)
    const single = ok(JSON.stringify({ FeatureName: 'VirtualMachinePlatform', State: 'Disabled' }))
    expect(parseOptionalFeatures(single).get('VirtualMachinePlatform')).toBe(false)
    // Nothing readable means no answer, which the probe turns into a blocker rather than a "no".
    expect(parseOptionalFeatures(ok('not json')).size).toBe(0)
  })

  it('reads the firmware virtualization flag, and says nothing when it cannot', () => {
    expect(
      parseVirtualization(ok(JSON.stringify({ HyperVRequirementVirtualizationFirmwareEnabled: true })))
    ).toBe(true)
    expect(parseVirtualization(ok(JSON.stringify({ VirtualizationFirmwareEnabled: false })))).toBe(false)
    expect(parseVirtualization(ok('{}'))).toBeNull()
    expect(parseVirtualization(missing())).toBeNull()
  })

  it('runs only read-only commands and keeps the account that launched the app', async () => {
    const calls: string[] = []
    const probed = await probeWindows({
      exec: async (command, args) => {
        calls.push([command, ...args].join(' '))
        if (command === 'wsl.exe' && args[0] === '--status') return ok(asUtf16('Default Version: 2\r\n'))
        if (command === 'wsl.exe') return ok(asUtf16(LIST))
        if (command === 'nvidia-smi') return ok(SMI)
        if (args.some((arg) => arg.includes('WindowsOptionalFeature'))) return ok(FEATURES)
        return ok(JSON.stringify({ HyperVRequirementVirtualizationFirmwareEnabled: true }))
      },
      originalUser: USER,
      elevatedUser: ADMIN,
      ownedDistribution: 'atomic-app-7f3c',
      freeDiskBytes: async () => 200_000_000_000,
    })

    expect(probed.owned_distribution?.name).toBe('atomic-app-7f3c')
    expect(probed.distributions).toHaveLength(3)
    expect(probed.gpus[0]?.compute_capability).toBe('8.9')
    expect(probed.unknown).toEqual([])
    // The elevation is visible, but it is not who the machine belongs to.
    expect(probed.original_user).toEqual(USER)
    expect(probed.elevated_user).toEqual(ADMIN)
    // Nothing that enables a feature, imports a distribution or starts one.
    expect(
      calls.some((call) => /--import|--set-default|Enable-WindowsOptionalFeature|--terminate/.test(call))
    ).toBe(false)
  })

  it('records each answer it could not read rather than assuming one', async () => {
    const probed = await probeWindows({
      exec: async () => missing(),
      originalUser: USER,
      ownedDistribution: null,
      freeDiskBytes: async () => null,
    })
    expect(probed.unknown).toEqual(['windows-features', 'virtualization', 'nvidia-driver', 'free-disk'])
    expect(probed.features.wsl).toBeNull()
  })
})

describe('what the machine needs', () => {
  it('needs nothing when the features are on and our distribution is already registered', () => {
    const assessment = assessWindows(facts(), OPTIONS)
    expect(assessment.availability).toBe('supported')
    expect(assessment.adopts_existing_engine).toBe(true)
    expect(assessment.missing).toEqual([])
    expect(assessment.needs_reboot).toBe(false)
  })

  it('asks to turn the features on, and says that takes a restart', () => {
    const assessment = assessWindows(
      facts({
        features: { wsl: false, virtual_machine_platform: false, virtualization_firmware: true },
        owned_distribution: null,
        distributions: [],
      }),
      OPTIONS
    )
    expect(assessment.availability).toBe('setup-required')
    expect(assessment.missing).toEqual(['wsl-feature', 'virtual-machine-platform', 'owned-distribution'])
    expect(assessment.needs_reboot).toBe(true)
  })

  it('only imports the distribution when the features are already on', () => {
    const assessment = assessWindows(
      facts({ owned_distribution: null, distributions: [facts().distributions[0]!] }),
      OPTIONS
    )
    expect(assessment.missing).toEqual(['owned-distribution'])
    // Nothing is being enabled, so nothing needs a restart.
    expect(assessment.needs_reboot).toBe(false)
  })

  it('imports under the account that launched the app, never the administrator it elevated to', () => {
    const assessment = assessWindows(facts({ elevated_user: ADMIN }), OPTIONS)
    expect(assessment.import_as).toEqual(USER)
    expect(assessment.import_as).not.toEqual(ADMIN)
  })

  it('stops on firmware virtualization, which no installer can turn on', () => {
    const assessment = assessWindows(
      facts({ features: { wsl: false, virtual_machine_platform: false, virtualization_firmware: false } }),
      OPTIONS
    )
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.missing).toContain('virtualization')
    expect(assessment.needs_reboot).toBe(false)
  })

  it('stops when our own distribution was registered as WSL 1', () => {
    const wsl1 = { name: 'atomic-app-7f3c', state: 'Stopped', version: 1, is_default: false, owned: true }
    const assessment = assessWindows(facts({ owned_distribution: wsl1, distributions: [wsl1] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers.some((b) => b.message.includes('WSL 1'))).toBe(true)
  })

  it('blocks on a fact it could not read instead of guessing it', () => {
    const assessment = assessWindows(facts({ unknown: ['windows-features'] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.details).toBe('windows-features')
  })

  it('refuses when the image would not fit', () => {
    const assessment = assessWindows(facts({ free_disk_bytes: 10_000_000_000 }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.blockers[0]?.details).toContain('required=60000000000')
  })

  it('reports a missing driver as the user’s job, like it does on Linux', () => {
    const assessment = assessWindows(facts({ driver_version: null, gpus: [] }), OPTIONS)
    expect(assessment.availability).toBe('prerequisite-blocked')
    expect(assessment.missing).toContain('nvidia-driver')
  })
})
