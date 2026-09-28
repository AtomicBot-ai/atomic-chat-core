/**
 * The hardware probe against the compiled binary: what `GET /hardware/info` says about the machine
 * the tests run on, a refresh, and the override taking the probe's place. On Linux a fake `nvidia-smi`
 * on PATH proves the NVIDIA path end to end, including the legacy-driver retry.
 *
 * No imports from `src/`, so a packaging change that breaks the probe (a `node:*` call that does not
 * survive `--compile`, a tool spawned wrongly) cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { BIN } = core
const FAKE_NVIDIA_SMI = fileURLToPath(new URL('../helpers/fake-nvidia-smi.mjs', import.meta.url))

interface HardwareInfo {
  info: {
    cpu: { name: string; core_count: number; arch: string; extensions: string[]; extensions_known: boolean }
    os_type: string
    os_name: string
    total_memory: number
    gpus: Array<{
      name: string
      vendor: string
      uuid: string
      driver_version: string
      total_memory: number
      nvidia_info: { index: number; compute_capability: string } | null
      vulkan_info: { device_type: string; device_id: number } | null
    }>
  }
  source: 'probe' | 'override'
  probed_at: number
  warnings: string[]
}

const HOST_OS = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux'

let dataFolder: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-hw-e2e-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, init)
const info = async (ready: ReadyLine, path = '/hardware/info', init: RequestInit = {}) => {
  const res = await control(ready, path, init)
  expect(res.status).toBe(200)
  return (await res.json()) as HardwareInfo
}

describe.skipIf(!existsSync(BIN))('the compiled core probes the machine it runs on', () => {
  it('describes this host, refreshes, and lets an override stand in for the probe', async () => {
    const { ready } = await core.startDaemon(dataFolder, daemons)

    const first = await info(ready)
    expect(first.source).toBe('probe')
    expect(first.info.os_type).toBe(HOST_OS)
    expect(first.info.os_name).not.toBe('')
    expect(['x86_64', 'arm64']).toContain(first.info.cpu.arch)
    expect(first.info.cpu.name).not.toBe('')
    expect(first.info.cpu.core_count).toBeGreaterThan(0)
    expect(first.info.total_memory).toBeGreaterThan(0)
    expect(first.probed_at).toBeGreaterThan(0)
    expect(Array.isArray(first.warnings)).toBe(true)
    if (process.platform === 'darwin') expect(first.info.gpus).toEqual([])
    if (first.info.cpu.arch === 'arm64') expect(first.info.cpu.extensions).toEqual([])

    const refreshed = await info(ready, '/hardware/refresh', { method: 'POST' })
    expect(refreshed.source).toBe('probe')
    expect(refreshed.probed_at).toBeGreaterThanOrEqual(first.probed_at)
    expect(refreshed.info.os_type).toBe(first.info.os_type)

    const gpus = [
      {
        vendor: 'AMD',
        total_memory: 24_576,
        driver_version: '32.0.12033.1030',
        vulkan_info: { device_id: 0x744c, device_type: 'DiscreteGpu' },
      },
    ]
    const put = await control(ready, '/hardware/override', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gpus, source: 'hardware-e2e' }),
    })
    expect(put.status).toBe(200)
    const overridden = await info(ready)
    expect(overridden.source).toBe('override')
    expect(overridden.info.gpus).toHaveLength(1)
    expect(overridden.info.gpus[0]).toMatchObject({
      vendor: 'AMD',
      total_memory: 24_576,
      driver_version: '32.0.12033.1030',
      nvidia_info: null,
      vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x744c },
    })
    // The probe's own CPU and memory are kept under the override.
    expect(overridden.info.cpu.name).toBe(first.info.cpu.name)
    expect(overridden.info.total_memory).toBe(first.info.total_memory)
    expect(overridden.probed_at).toBe(refreshed.probed_at)

    const cleared = await control(ready, '/hardware/override', { method: 'DELETE' })
    expect(await cleared.json()).toEqual({ cleared: true })
    const back = await info(ready)
    expect(back.source).toBe('probe')
    expect(back.info.gpus).toEqual(first.info.gpus)
  })

  describe.skipIf(process.platform !== 'linux')('with a fake nvidia-smi on PATH (Linux)', () => {
    const startWithFakeSmi = async (mode: 'modern' | 'legacy') => {
      const bin = join(dataFolder, 'fake-bin')
      await core.writeFakeBackend(dataFolder) // creates the data folder tree; the fake binary dir sits next to it
      await rm(bin, { recursive: true, force: true })
      await (await import('node:fs/promises')).mkdir(bin, { recursive: true })
      await writeFile(
        join(bin, 'nvidia-smi'),
        `#!/bin/sh\nexport FAKE_NVIDIA_SMI_MODE=${mode}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_NVIDIA_SMI)} "$@"\n`,
        { mode: 0o755 }
      )
      return core.startDaemon(dataFolder, daemons, [], { PATH: `${bin}:${process.env['PATH'] ?? ''}` })
    }

    it('reads the driver version and compute capability from a modern driver', async () => {
      const { ready } = await startWithFakeSmi('modern')
      const probed = await info(ready)
      const nvidia = probed.info.gpus.find((g) => g.vendor === 'NVIDIA')
      expect(nvidia, JSON.stringify(probed)).toBeDefined()
      expect(nvidia).toMatchObject({
        name: 'NVIDIA GeForce RTX 4090',
        uuid: '0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
        driver_version: '581.42',
        total_memory: 24_564,
        nvidia_info: { index: 0, compute_capability: '8.9' },
      })
      expect(probed.info.gpus[0]?.vendor).toBe('NVIDIA')
    })

    it('falls back to the legacy field set when the driver refuses compute_cap', async () => {
      const { ready } = await startWithFakeSmi('legacy')
      const probed = await info(ready)
      expect(probed.info.gpus[0]).toMatchObject({
        vendor: 'NVIDIA',
        uuid: '0b6f4f4e-6c1c-3a54-8f2d-1b0d2f4d6a11',
        driver_version: '581.42',
        nvidia_info: { compute_capability: '' },
      })
      expect(probed.warnings.filter((w) => w.startsWith('nvidia-smi'))).toEqual([])
    })
  })
})
