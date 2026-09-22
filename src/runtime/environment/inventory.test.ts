import { describe, expect, it } from 'vitest'
import type { CommandOutput } from './linux-probe.js'
import { collectInventory, redactInventory, type HostInventory } from './inventory.js'
import type { WindowsFacts } from './windows-probe.js'

/** Narrow a report to the Windows shape, failing loudly if it is not one. */
const windows = (report: HostInventory): WindowsFacts => {
  if (report.platform !== 'win32') throw new Error('expected a Windows report')
  return report.facts
}

const ok = (stdout: string): CommandOutput => ({ code: 0, stdout, stderr: '' })
const missing = (): CommandOutput => ({ code: null, stdout: '', stderr: '' })

const SMI = 'GPU-1c6a4b2e-aaaa-bbbb-cccc-0123456789ab, NVIDIA GeForce RTX 4070, 8.9, 12282, 11000, 551.23\n'
const NOW = () => new Date('2026-09-22T12:00:00Z')

const linux = () =>
  collectInventory({
    platform: 'linux',
    user: 'aleks',
    now: NOW,
    options: { supportedDistributions: [{ id: 'ubuntu', versions: ['24.04'] }], requiredDiskBytes: null },
    deps: {
      exec: async (command, args) => {
        if (command === 'nvidia-smi') return ok(SMI)
        if (command === 'docker' && args[0] === '--version') return ok('Docker version 28.3.0')
        if (command === 'docker') {
          return ok(JSON.stringify({ ID: 'X4RT', ServerVersion: '28.3.0', Runtimes: { nvidia: {} } }))
        }
        if (command === 'id') return ok('aleks docker')
        if (command === 'getent') return ok('docker:x:999:aleks')
        if (command === 'nvidia-ctk') return ok('NVIDIA Container Toolkit CLI version 1.17')
        return missing()
      },
      readFile: async () => 'ID=ubuntu\nVERSION_ID="24.04"\n',
      freeDiskBytes: async () => 200_000_000_000,
    },
  })

describe('what a report says', () => {
  it('carries both the facts and what setup would make of them', async () => {
    const report = await linux()
    expect(report.platform).toBe('linux')
    expect(report.collected_at).toBe('2026-09-22T12:00:00.000Z')
    expect(report.facts.gpus[0]?.compute_capability).toBe('8.9')
    // The verdict is setup's own function, so a report cannot disagree with what setup would do.
    expect(report.assessment.adopts_existing_engine).toBe(true)
  })

  it('reads a Windows machine through the same shape', async () => {
    const report = await collectInventory({
      platform: 'win32',
      now: NOW,
      options: { requiredDiskBytes: null },
      deps: {
        exec: async () => missing(),
        originalUser: { name: 'aleks', sid: 'S-1-5-21-1001' },
        ownedDistribution: null,
        freeDiskBytes: async () => null,
      },
    })
    expect(report.platform).toBe('win32')
    // Nothing answered, so every fact is unknown and the verdict says it cannot proceed.
    expect(report.assessment.availability).toBe('prerequisite-blocked')
    expect(windows(report).original_user.name).toBe('aleks')
  })
})

describe('what a report may not say', () => {
  const personal = (): HostInventory => ({
    schema_version: 1,
    platform: 'win32',
    collected_at: '2026-09-22T12:00:00.000Z',
    facts: {
      features: { wsl: true, virtual_machine_platform: true, virtualization_firmware: true },
      wsl_default_version: 2,
      wsl_kernel: '5.15',
      distributions: [
        { name: 'atomic-app-7f3c', state: 'Stopped', version: 2, is_default: false, owned: true },
      ],
      owned_distribution: null,
      driver_version: '551.23',
      gpus: [
        {
          gpu_id: 'GPU-1c6a4b2e-aaaa-bbbb-cccc-0123456789ab',
          name: 'NVIDIA GeForce RTX 4070',
          compute_capability: '8.9',
          total_vram_bytes: 1,
          free_vram_bytes: 1,
          driver_version: '551.23',
        },
      ],
      original_user: { name: 'Aleks', sid: 'S-1-5-21-1001' },
      elevated_user: null,
      free_disk_bytes: 1,
      unknown: ['C:\\Users\\Aleks\\AppData on WORKSTATION-7 for GPU-1c6a4b2e-aaaa-bbbb-cccc-0123456789ab'],
    },
    assessment: {
      availability: 'supported',
      adopts_existing_engine: true,
      needs_reboot: false,
      missing: [],
      blockers: [],
      import_as: { name: 'Aleks', sid: 'S-1-5-21-1001' },
    },
  })

  const secrets = {
    user: 'aleks',
    home: 'C:\\Users\\Aleks',
    hostname: 'workstation-7',
    sid: 'S-1-5-21-1001',
  }

  it('replaces the account, its SID, the home directory and the machine name', () => {
    const text = JSON.stringify(redactInventory(personal(), secrets))
    for (const secret of ['Aleks', 'aleks', 'S-1-5-21-1001', 'WORKSTATION-7', 'workstation-7']) {
      expect(text).not.toContain(secret)
    }
    expect(text).toContain('<user>')
    expect(text).toContain('<sid>')
    expect(text).toContain('<host>')
  })

  it('replaces a home directory whole, rather than leaving half of it behind', () => {
    const redacted = redactInventory(personal(), secrets)
    // Longest first: `C:\Users\Aleks` goes as one piece, not as `C:\Users\<user>`.
    expect(redacted.facts.unknown[0]).toContain('<home>\\AppData')
    expect(redacted.facts.unknown[0]).not.toContain('Users')
  })

  it('gives one card the same label everywhere it appears', () => {
    const redacted = redactInventory(personal(), secrets)
    // A hardware UUID names one physical card; the label still says "the same card" without it.
    expect(redacted.facts.gpus[0]?.gpu_id).toBe('GPU-<redacted-1>')
    expect(redacted.facts.unknown[0]).toContain('GPU-<redacted-1>')
    expect(JSON.stringify(redacted)).not.toContain('1c6a4b2e')
  })

  it('leaves what is not personal exactly as it was', () => {
    const redacted = redactInventory(personal(), secrets)
    expect(redacted.facts.gpus[0]?.name).toBe('NVIDIA GeForce RTX 4070')
    expect(redacted.facts.gpus[0]?.compute_capability).toBe('8.9')
    expect(redacted.facts.gpus[0]?.total_vram_bytes).toBe(1)
    expect(windows(redacted).features.wsl).toBe(true)
    expect(redacted.assessment.availability).toBe('supported')
  })

  it('ignores a secret that was not supplied, rather than replacing every empty string', () => {
    const redacted = redactInventory(personal(), { user: '', home: '   ' })
    expect(redacted.facts.gpus[0]?.name).toBe('NVIDIA GeForce RTX 4070')
    expect(windows(redacted).original_user.name).toBe('Aleks')
  })

  it('does not change the report it was given', () => {
    const original = personal()
    redactInventory(original, secrets)
    expect(windows(original).original_user.name).toBe('Aleks')
  })
})
