import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { storedZip } from '../../test/helpers/backend-install-e2e.js'
import { fakeLlamaSpawn, fakeLlamaSpawnRaw } from '../../test/helpers/fake-llama-server.js'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { BackendService } from '../backend/index.js'
import type { BackendCatalogResponse, BackendUpdateCheckResponse, CoreEvents } from '../contracts/index.js'
import { DOWNLOAD_CANCELLED } from '../downloads/index.js'
import { ModelRegistry } from '../models/index.js'
import { LlamacppRuntime } from '../runtime/llamacpp/index.js'
import type { RuntimeSettings } from '../runtime/llamacpp/index.js'
import { canonicalProviderDefaults } from '../settings/index.js'
import { LlamacppEngine } from './llamacpp.js'

vi.setConfig({ testTimeout: 20_000 })

const PROVIDER = 'llamacpp-upstream'
let data: TmpDataFolder
let events: Array<{ name: string; payload: unknown }>
let runtime: LlamacppRuntime | undefined

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-engines-llamacpp-')
  events = []
})
afterEach(async () => {
  await runtime?.dispose()
  runtime = undefined
  await data.cleanup()
})

const packDir = (version: string, backend: string) =>
  join(data.layout.provider(PROVIDER).backendsDir, version, backend)
const exeOf = (version: string, backend: string) =>
  join(packDir(version, backend), 'build', 'bin', 'llama-server')

/** A downloader that writes a pack archive, or fails the way a cancel does. */
function downloader(behaviour: { cancel?: boolean } = {}) {
  return {
    calls: [] as string[],
    async download(taskId: string, items: Array<{ save_path: string }>) {
      this.calls.push(taskId)
      if (behaviour.cancel) throw new Error(DOWNLOAD_CANCELLED)
      const fixture = join(data.root, `fixture-${this.calls.length}`)
      await mkdir(join(fixture, 'build', 'bin'), { recursive: true })
      await writeFile(join(fixture, 'build', 'bin', 'llama-server'), '#!/bin/sh\nexit 0\n')
      // Every item: the Windows CUDA packs bring their runtime archive under the same task, as zips.
      for (const item of items)
        if (item.save_path.endsWith('.zip'))
          await writeFile(
            item.save_path,
            storedZip('build/bin/llama-server', Buffer.from('#!/bin/sh\nexit 0\n'))
          )
        else await tarCreate({ gzip: true, cwd: fixture, file: item.save_path }, ['build'])
    },
  }
}

interface Setup {
  current?: string
  offer?: string | null
  available?: Array<{ version: string; backend: string }>
  busy?: string[]
  cancel?: boolean
  bundled?: { version: string; backend: string }
}

async function setup(options: Setup = {}) {
  let current = options.current ?? 'b11443/macos-arm64'
  const busy = options.busy ?? []
  const settingsWrites: string[] = []
  runtime = new LlamacppRuntime({
    layout: data.layout,
    registry: new ModelRegistry(data.layout),
    instanceId: 'owner-under-test',
    provider: PROVIDER,
    readSettings: async (): Promise<RuntimeSettings> => ({
      config: {
        ...canonicalProviderDefaults(PROVIDER),
        version_backend: current,
        auto_unload: false,
      } as RuntimeSettings['config'],
      engine: { timeout: 600, llamacpp_env: '' },
    }),
    ensureBackendReady: async (backend, version) => ({ backend, version, exePath: exeOf(version, backend) }),
    spawn: fakeLlamaSpawn(),
    probeDevicesWith: fakeLlamaSpawnRaw(),
  })
  const live = runtime
  let resourcesDir: string | undefined
  if (options.bundled) {
    resourcesDir = join(data.root, 'resources', 'bin')
    const dir = join(data.root, 'resources', 'llamacpp-backend-upstream')
    await mkdir(resourcesDir, { recursive: true })
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'version.txt'), options.bundled.version)
    await writeFile(join(dir, 'backend.txt'), options.bundled.backend)
  }
  const fetcher = downloader({ cancel: options.cancel ?? false })
  const backends = new BackendService({
    layout: data.layout,
    provider: PROVIDER,
    downloader: fetcher as never,
    readManifest: async () => null,
    platform: 'linux',
    now: () => 1,
    resourcesDir,
    host: {
      exclusive: (fn) => live.exclusive(fn),
      inUse: async () => [...live.buildDirsInUse(), ...busy],
    },
  })
  const offer = options.offer === undefined ? 'b11500/macos-arm64' : options.offer
  const available = options.available ?? [
    { version: 'b11500', backend: 'macos-arm64' },
    { version: 'b11443', backend: 'macos-arm64' },
  ]
  const advisor = {
    checkUpdates: async (): Promise<BackendUpdateCheckResponse> => ({
      provider: PROVIDER,
      current,
      current_kind: 'concrete',
      update_needed: offer !== null,
      new_version: offer?.split('/')[0] ?? '0',
      target_backend: offer,
      same_family: true,
      offer,
    }),
    catalog: async () =>
      ({ provider: PROVIDER, available, source: 'live' }) as unknown as BackendCatalogResponse,
  }
  const engine = new LlamacppEngine({
    engine: PROVIDER,
    backends,
    advisor,
    currentVersionBackend: () => current,
    selectVersionBackend: async (versionBackend) => {
      settingsWrites.push(versionBackend)
      current = versionBackend
    },
    unloadSessions: async () => {
      for (const modelId of live.getLoadedModels()) await live.unload(modelId)
    },
    emit: (name, payload) => events.push({ name, payload }),
  })
  return { engine, backends, fetcher, settingsWrites, current: () => current }
}

/** The packs on disk, as `<version>/<backend>`. */
const installed = async () =>
  (
    await new BackendService({
      layout: data.layout,
      provider: PROVIDER,
      downloader: downloader() as never,
      readManifest: async () => null,
    }).listInstalled()
  )
    .map((pack) => `${pack.version}/${pack.backend}`)
    .sort()
const changed = () =>
  events.filter((e) => e.name === 'engine:changed').map((e) => e.payload as CoreEvents['engine:changed'])

describe('LlamacppEngine.update', () => {
  it('installs the offer, writes version_backend, unloads the model and retires the old pack', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    await data.writeModel('demo')
    const { engine, settingsWrites, fetcher } = await setup()
    await runtime!.load('demo')

    const result = await engine.update({ task_id: 'engine-update-llamacpp-upstream-b11500' })

    expect(result).toEqual({
      updated: true,
      active: { version: 'b11500', variant: 'macos-arm64' },
      retired: [{ version: 'b11443', variant: 'macos-arm64' }],
      kept_in_use: [],
    })
    expect(fetcher.calls).toEqual(['engine-update-llamacpp-upstream-b11500'])
    expect(settingsWrites).toEqual(['b11500/macos-arm64'])
    expect(runtime!.getLoadedModels()).toEqual([])
    expect(await installed()).toEqual(['b11500/macos-arm64'])
    expect(changed()).toEqual([{ engine: PROVIDER, reason: 'update' }])
  })

  it('keeps an old pack the decision model runs from', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    const { engine } = await setup({ busy: [packDir('b11443', 'macos-arm64')] })

    const result = await engine.update({ task_id: 't' })

    expect(result.kept_in_use).toEqual([{ version: 'b11443', variant: 'macos-arm64' }])
    expect(result.retired).toEqual([])
    expect(await installed()).toEqual(['b11443/macos-arm64', 'b11500/macos-arm64'])
  })

  it("switches the variant to the catalog's newest and leaves the installer's pack alone", async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'win-cpu-x64')
    await data.writeBackend(PROVIDER, 'b11300', 'win-cuda12-x64')
    const { engine, settingsWrites } = await setup({
      current: 'b11443/win-cpu-x64',
      bundled: { version: 'b11443', backend: 'win-cpu-x64' },
      available: [
        { version: 'b11500', backend: 'win-cuda12-x64' },
        { version: 'b11500', backend: 'win-cpu-x64' },
        { version: 'b11300', backend: 'win-cuda12-x64' },
      ],
    })

    const result = await engine.update({ task_id: 't', target: { variant: 'win-cuda12-x64' } })

    expect(result).toMatchObject({
      updated: true,
      active: { version: 'b11500', variant: 'win-cuda12-x64' },
      retired: [{ version: 'b11300', variant: 'win-cuda12-x64' }],
    })
    expect(settingsWrites).toEqual(['b11500/win-cuda12-x64'])
    expect(await installed()).toEqual(['b11443/win-cpu-x64', 'b11500/win-cuda12-x64'])
  })

  it('leaves the setting and the packs as they were when the download is cancelled', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    const { engine, settingsWrites, current } = await setup({ cancel: true })

    await expect(engine.update({ task_id: 't' })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(settingsWrites).toEqual([])
    expect(current()).toBe('b11443/macos-arm64')
    expect(await installed()).toEqual(['b11443/macos-arm64'])
    expect(changed()).toEqual([])
  })

  it('refuses a second update of the provider while one runs', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    const { engine } = await setup()
    const first = engine.update({ task_id: 'a' })
    await expect(engine.update({ task_id: 'b' })).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
    })
    await expect(first).resolves.toMatchObject({ updated: true })
  })

  it('answers no-update without an offer and already-active for the active target, downloading nothing', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    const quiet = await setup({ offer: null })
    expect(await quiet.engine.update({ task_id: 't' })).toEqual({
      updated: false,
      reason: 'no-update',
      active: { version: 'b11443', variant: 'macos-arm64' },
      retired: [],
      kept_in_use: [],
    })
    expect(
      await quiet.engine.update({ task_id: 't', target: { version: 'b11443', variant: 'macos-arm64' } })
    ).toMatchObject({ updated: false, reason: 'already-active' })
    expect(quiet.fetcher.calls).toEqual([])
    expect(changed()).toEqual([])
  })

  it('refuses a variant the catalog does not have', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    const { engine } = await setup()
    await expect(
      engine.update({ task_id: 't', target: { variant: 'win-cuda12-x64' } })
    ).rejects.toMatchObject({
      code: 'BACKEND_TAG_UNRESOLVED',
    })
  })
})

describe('LlamacppEngine.remove', () => {
  it('deletes an inactive pack and says so on engine:changed', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    await data.writeBackend(PROVIDER, 'b11400', 'macos-arm64')
    const { engine } = await setup()
    expect(await engine.remove('b11400', 'macos-arm64')).toEqual({ removed: true })
    expect(await installed()).toEqual(['b11443/macos-arm64'])
    expect(changed()).toEqual([{ engine: PROVIDER, reason: 'uninstall' }])
  })

  it('refuses the active pack as INVALID_REQUEST with the reason, and a pack in use as BACKEND_IN_USE', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    await data.writeBackend(PROVIDER, 'b11400', 'macos-arm64')
    const { engine } = await setup({ busy: [packDir('b11400', 'macos-arm64')] })
    await expect(engine.remove('b11443', 'macos-arm64')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: 'active',
    })
    await expect(engine.remove('b11400', 'macos-arm64')).rejects.toMatchObject({ code: 'BACKEND_IN_USE' })
    expect(await installed()).toEqual(['b11400/macos-arm64', 'b11443/macos-arm64'])
    expect(changed()).toEqual([])
  })

  it('answers removed: false for a pack that is not there, and publishes nothing', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    const { engine } = await setup()
    expect(await engine.remove('b11000', 'macos-arm64')).toEqual({ removed: false })
    expect(changed()).toEqual([])
  })
})

describe('LlamacppEngine.activate', () => {
  it('switches to an installed pack while a model runs: the model is unloaded, both packs stay', async () => {
    await data.writeBackend(PROVIDER, 'b11500', 'win-cuda12-x64')
    await data.writeBackend(PROVIDER, 'b11400', 'win-vulkan-x64')
    await data.writeModel('demo')
    const { engine, settingsWrites, fetcher } = await setup({ current: 'b11500/win-cuda12-x64' })
    await runtime!.load('demo')

    expect(await engine.activate('b11400', 'win-vulkan-x64')).toEqual({
      activated: true,
      active: { version: 'b11400', variant: 'win-vulkan-x64' },
    })
    expect(settingsWrites).toEqual(['b11400/win-vulkan-x64'])
    expect(runtime!.getLoadedModels()).toEqual([])
    expect(await installed()).toEqual(['b11400/win-vulkan-x64', 'b11500/win-cuda12-x64'])
    expect(fetcher.calls).toEqual([])
    expect(changed()).toEqual([{ engine: PROVIDER, reason: 'activate' }])
  })

  it('answers already-active without unloading anything', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    await data.writeModel('demo')
    const { engine, settingsWrites } = await setup()
    await runtime!.load('demo')
    expect(await engine.activate('b11443', 'macos-arm64')).toEqual({
      activated: false,
      reason: 'already-active',
      active: { version: 'b11443', variant: 'macos-arm64' },
    })
    expect(runtime!.getLoadedModels()).toEqual(['demo'])
    expect(settingsWrites).toEqual([])
    expect(changed()).toEqual([])
  })

  it('refuses a pack that is not installed, leaving version_backend alone', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    const { engine, current } = await setup()
    await expect(engine.activate('b11600', 'macos-arm64')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      details: 'not-installed',
    })
    expect(current()).toBe('b11443/macos-arm64')
  })

  it('refuses an activation while an update of the provider runs', async () => {
    await data.writeBackend(PROVIDER, 'b11443', 'macos-arm64')
    await data.writeBackend(PROVIDER, 'b11400', 'macos-arm64')
    const { engine } = await setup()
    const update = engine.update({ task_id: 't' })
    await expect(engine.activate('b11400', 'macos-arm64')).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_IN_PROGRESS',
    })
    await update
  })
})
