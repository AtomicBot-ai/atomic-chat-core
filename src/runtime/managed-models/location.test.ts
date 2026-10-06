import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WslDistributionTransport } from '../wsl/index.js'
import { linuxModelLocation, windowsModelLocation } from './location.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'trt-location-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('linuxModelLocation', () => {
  it('is the data folder’s own models root, as before, with the free space there (before it even exists)', async () => {
    const root = join(dir, 'tensorrt-llm', 'models')
    const location = await linuxModelLocation(root)
    expect(location.root).toBe(root)
    expect(location.free_bytes).toBeGreaterThan(0)
  })
})

const RECORD = {
  schema_version: 1 as const,
  executor: 'wsl-docker' as const,
  distribution: { name: 'AtomicChat', path: 'C:\\Users\\ada\\AppData\\Local\\AtomicChat\\wsl\\AtomicChat' },
  manifest_id: 'windows-r1',
  imported_at: '2026-10-01T00:00:00.000Z',
  marker: 'marker-0001',
}

const guest = (free: string) => {
  const calls: string[][] = []
  const transport: WslDistributionTransport = {
    name: 'AtomicChat',
    exec: async (argv) => {
      calls.push(argv)
      return argv[0] === 'df'
        ? { code: 0, stdout: `   Avail\n${free}\n`, stderr: '' }
        : { code: 0, stdout: '', stderr: '' }
    },
    hold: () => {
      throw new Error('no hold')
    },
  }
  return { transport, calls }
}

describe('windowsModelLocation', () => {
  it('is the scope’s folder in the guest as Windows opens it, with the smaller of the guest’s and the volume’s space', async () => {
    const g = guest('900000000000')
    const location = await windowsModelLocation({
      records: { read: async () => RECORD },
      scopeKey: async () => 'k1',
      transport: () => g.transport,
      volumeFreeBytes: async () => 400_000_000_000,
    })
    expect(location).toEqual({
      root: '\\\\wsl.localhost\\AtomicChat\\var\\lib\\atomic-chat\\scopes\\k1\\models\\tensorrt-llm',
      free_bytes: 400_000_000_000,
    })
    // The folder exists before a client writes into it, and belongs to uid 1000.
    expect(g.calls[0]?.[0]).toBe('mkdir')
    expect(g.calls.some((argv) => argv[0] === 'chown')).toBe(true)
  })

  it('before the distribution exists: MANAGED_ADAPTER_UNAVAILABLE, no download can start', async () => {
    await expect(
      windowsModelLocation({
        records: { read: async () => null },
        scopeKey: async () => 'k1',
        transport: () => guest('1').transport,
        volumeFreeBytes: async () => 1,
      })
    ).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })

  it('an unreadable side does not hide the other', async () => {
    const location = await windowsModelLocation({
      records: { read: async () => RECORD },
      scopeKey: async () => 'k1',
      transport: () => guest('garbage').transport,
      volumeFreeBytes: async () => 5,
    })
    expect(location.free_bytes).toBe(5)
  })
})

describe('windowsModelLocation: a distribution gone behind the app’s back', () => {
  it('is MANAGED_ADAPTER_UNAVAILABLE, not an I/O error', async () => {
    const gone: WslDistributionTransport = {
      name: 'AtomicChat',
      exec: async () => ({
        code: 255,
        stdout: 'There is no distribution with the supplied name.',
        stderr: '',
      }),
      hold: () => {
        throw new Error('no hold')
      },
    }
    await expect(
      windowsModelLocation({
        records: { read: async () => RECORD },
        scopeKey: async () => 'k1',
        transport: () => gone,
        volumeFreeBytes: async () => 1,
      })
    ).rejects.toMatchObject({ code: 'MANAGED_ADAPTER_UNAVAILABLE' })
  })
})
