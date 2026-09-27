/**
 * The backend advisor seen from the compiled binary (ADR 2026-09-27): the hardware-gated catalog over
 * the fixture manifest, a recommendation persisted in the core's own optimal record, the existing
 * install of what was recommended, an update check, and the fork's catalog from its `index.json`.
 * The machine is described through the override seam so the verdicts are the same on every CI OS.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startBackendInstallFixture } from '../helpers/backend-install-e2e.js'
import type { InstallFixture } from '../helpers/backend-install-e2e.js'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { BIN } = core

let dataFolder: string
const daemons: ChildProcess[] = []
const fixtures: InstallFixture[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-advisor-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()))
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, init)
const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const put = (body: unknown): RequestInit => ({ ...json(body), method: 'PUT' })

const isWindows = process.platform === 'win32'
const isLinux = process.platform === 'linux'
const isMac = process.platform === 'darwin'
/** The GPU build a discrete NVIDIA card leads to on this OS, for upstream and for the fork. */
const gpuBackend = isWindows ? 'win-cuda-13.3-x64' : isLinux ? 'linux-vulkan-x64' : null
const forkGpuBackend = isWindows ? 'windows-x64-cuda-13.3' : isLinux ? 'linux-x64-cuda-13.3' : null
const forkCpuBackend = isWindows
  ? 'windows-x64-cpu'
  : isLinux
    ? 'linux-x64-cpu'
    : `macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const FORK_TAG = 'b99999-1.0.0'
const forkIndex = {
  schema_version: 1,
  releases: [
    {
      tag: FORK_TAG,
      published_at: '2026-09-27T00:00:00Z',
      title: 'Fixture release',
      highlights: ['served by the e2e fixture'],
      variants: [
        'macos-arm64',
        'macos-x64',
        'windows-x64-cpu',
        'windows-x64-cuda-13.3',
        'windows-x64-vulkan',
        'linux-x64-cpu',
        'linux-x64-cuda-13.3',
        'linux-x64-vulkan',
      ].map((id) => ({
        id,
        asset: `llama-${FORK_TAG}-bin-${id}.${id.startsWith('windows') ? 'zip' : 'tar.gz'}`,
      })),
    },
    { tag: 'dev-latest', prerelease: true, variants: [{ id: 'macos-arm64' }] },
  ],
}
const nvidiaGpu = {
  name: 'NVIDIA GeForce RTX 4090',
  vendor: 'NVIDIA',
  total_memory: 24_564,
  driver_version: '581.42',
  nvidia_info: { index: 0, compute_capability: '8.9' },
  vulkan_info: { index: 0, device_type: 'DiscreteGpu', api_version: '1.3.290', device_id: 0x2684 },
}

describe.skipIf(!existsSync(BIN))('the backend advisor on the compiled core', () => {
  it('lists, recommends, installs what it recommended, and checks for updates', async () => {
    const fixture = await startBackendInstallFixture(dataFolder, {
      extraAssets: isWindows
        ? ['llama-b99999-bin-win-cuda-13.3-x64.zip', 'llama-b99999-bin-win-vulkan-x64.zip']
        : isLinux
          ? ['llama-b99999-bin-ubuntu-vulkan-x64.tar.gz']
          : [],
      turboquantIndex: forkIndex,
    })
    fixtures.push(fixture)
    const { ready } = await core.startDaemon(dataFolder, daemons, [])

    // A CPU-only machine with AVX2, described through the seam so every CI OS sees the same host.
    expect(
      (await control(ready, '/hardware/override', put({ gpus: [], cpu_extensions: ['avx', 'avx2'] }))).status
    ).toBe(200)

    const catalog = await control(
      ready,
      '/backends/llamacpp-upstream/catalog',
      json({ proxy: fixture.proxy })
    )
    expect(catalog.status, await catalog.clone().text()).toBe(200)
    const listed = (await catalog.json()) as {
      source: string
      hardware_source: string
      available: Array<{ version: string; backend: string }>
      recommended: string | null
      supported_backends: string[]
      latest_by_type: Record<string, string>
    }
    expect(listed.source).toBe('live')
    expect(listed.hardware_source).toBe('override')
    expect(listed.available).toContainEqual({ version: 'b99999', backend: fixture.backend, order: 0 })
    expect(listed.recommended).toBe(`b99999/${fixture.backend}`)
    expect(listed.latest_by_type[fixture.backend]).toBe(`b99999/${fixture.backend}`)
    expect(fixture.seen).toContain('CONNECT raw.githubusercontent.com:443')

    const cpuVerdict = await control(
      ready,
      '/backends/llamacpp-upstream/recommendation',
      json({ mode: 'recheck', current_backend: `b99999/${fixture.backend}`, proxy: fixture.proxy })
    )
    expect(cpuVerdict.status, await cpuVerdict.clone().text()).toBe(200)
    const cpu = (await cpuVerdict.json()) as { outcome: string; revision: number; optimal: unknown }
    if (isMac) {
      expect(cpu.outcome).toBe('mac')
      expect(cpu.revision).toBe(0)
    } else {
      expect(cpu.outcome).toBe('cpu_optimal')
      expect(cpu.revision).toBe(1)
      expect(cpu.optimal).toMatchObject({
        detectionKind: 'cpu-optimal',
        currentBackend: `b99999/${fixture.backend}`,
      })
      const snapshot = (await (await control(ready, '/snapshot')).json()) as {
        optimal_backends: Record<string, { revision: number }>
      }
      expect(snapshot.optimal_backends['llamacpp-upstream']?.revision).toBe(1)
    }

    if (gpuBackend) {
      // The same machine with a discrete NVIDIA card: the GPU tier is recommended and recorded.
      expect(
        (
          await control(
            ready,
            '/hardware/override',
            put({ gpus: [nvidiaGpu], cpu_extensions: ['avx', 'avx2'] })
          )
        ).status
      ).toBe(200)
      const gpuVerdict = await control(
        ready,
        '/backends/llamacpp-upstream/recommendation',
        json({ mode: 'recheck', current_backend: `b99999/${fixture.backend}`, proxy: fixture.proxy })
      )
      expect(gpuVerdict.status, await gpuVerdict.clone().text()).toBe(200)
      const gpu = (await gpuVerdict.json()) as {
        outcome: string
        detection: { kind: string; backend?: string }
        recommendation: { recommendedBackend: string; backendId: string } | null
        revision: number
      }
      expect(gpu.outcome).toBe('recommend')
      expect(gpu.detection).toEqual({ kind: 'gpu', backend: gpuBackend })
      expect(gpu.recommendation).toMatchObject({
        recommendedBackend: `b99999/${gpuBackend}`,
        backendId: gpuBackend,
      })
      expect(gpu.revision).toBe(2)
    }

    // Installing what was recommended is the existing route; the advisor only named it.
    const installed = await control(
      ready,
      '/backends/llamacpp-upstream/install',
      json({ version: 'b99999', backend: fixture.backend, task_id: 'advisor-install', proxy: fixture.proxy })
    )
    expect(installed.status, await installed.clone().text()).toBe(200)
    expect(await installed.json()).toMatchObject({ installed: true, backend: fixture.backend })

    const updates = await control(
      ready,
      '/backends/llamacpp-upstream/updates',
      json({ current: `b99998/${fixture.backend}`, proxy: fixture.proxy })
    )
    expect(updates.status, await updates.clone().text()).toBe(200)
    expect(await updates.json()).toMatchObject({
      current_kind: 'concrete',
      update_needed: true,
      target_backend: `b99999/${fixture.backend}`,
      same_family: true,
      offer: `b99999/${fixture.backend}`,
    })
    const installedNow = await control(
      ready,
      '/backends/llamacpp-upstream/catalog',
      json({ proxy: fixture.proxy, current_backend: `b99999/${fixture.backend}` })
    )
    expect((await installedNow.json()) as object).toMatchObject({
      recommended_installed: `b99999/${fixture.backend}`,
    })
  })

  it('serves the fork’s catalog from its release index and keeps the disk copy the install path reads', async () => {
    const fixture = await startBackendInstallFixture(dataFolder, { turboquantIndex: forkIndex })
    fixtures.push(fixture)
    const { ready } = await core.startDaemon(dataFolder, daemons, [])
    expect(
      (
        await control(
          ready,
          '/hardware/override',
          put({ gpus: gpuBackend ? [nvidiaGpu] : [], cpu_extensions: ['avx2'] })
        )
      ).status
    ).toBe(200)

    const catalog = await control(
      ready,
      '/backends/llamacpp/catalog',
      json({ proxy: fixture.proxy, app_version: '2.0.47' })
    )
    expect(catalog.status, await catalog.clone().text()).toBe(200)
    const listed = (await catalog.json()) as {
      source: string
      available: Array<{ version: string; backend: string }>
      recommended: string | null
      releases: Array<{ tag: string; title?: string }>
    }
    expect(listed.source).toBe('index')
    expect(listed.releases.map((release) => release.tag)).toEqual([FORK_TAG])
    expect(listed.available.map((entry) => `${entry.version}/${entry.backend}`)).toContain(
      `${FORK_TAG}/${forkCpuBackend}`
    )
    expect(listed.recommended).toBe(`${FORK_TAG}/${forkGpuBackend ?? forkCpuBackend}`)
    expect(fixture.seen).toContain('CONNECT github.com:443')

    const cache = JSON.parse(
      await readFile(join(dataFolder, 'llamacpp', 'release-index.cache.json'), 'utf8')
    ) as {
      catalog: { latest: string; source: string }
    }
    expect(cache.catalog.latest).toBe(FORK_TAG)
    expect(cache.catalog.source).toBe('index')
  })
})
