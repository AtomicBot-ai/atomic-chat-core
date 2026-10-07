/**
 * The service end to end against `test/helpers/fake-sd-server.mjs`: the command surface of
 * `commands.rs` in `tauri-plugin-atomic-diffusion` (app commit `767ff6350`). POSIX-only, because the
 * fake engine is a shell launcher.
 */
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import type { CoreEvents, LoadDiffusionModelRequest, SystemInfo } from '../contracts/index.js'
import { paintedPng, sampleRequest, sampleVideoRequest } from '../../test/helpers/diffusion-fixtures.js'
import {
  installFakeSdEngine,
  writeFakeSdLaunchers,
  writeFakeSdModel,
} from '../../test/helpers/fake-sd-server.js'
import type { FakeSdOptions } from '../../test/helpers/fake-sd-server.js'
import { isProcessAlive, loadCancelledError } from '../runtime/shared/index.js'
import type { GpuClaim, GpuClaimHook } from '../runtime/shared/index.js'
import { DiffusionService } from './service.js'
import { EngineBuildsService } from '../engine-builds/service.js'
import { parseSdcppManifest } from '../engine-builds/manifest.js'
import type { DownloadItem } from '../downloads/index.js'
import { c as tarCreate } from 'tar'

/**
 * The tests here build the diffusion service, several of them with real (fake-engine) child processes. Under the
 * full suite's parallel load some crossed vitest's 5 s default and failed at random (final review
 * T-282), so the whole file gets an explicit, longer per-test timeout.
 */
vi.setConfig({ testTimeout: 20_000 })

const posix = process.platform !== 'win32'

let dataFolder: string
let layout: DataLayout
const services: DiffusionService[] = []
beforeEach(async () => {
  dataFolder = await realpath(await mkdtemp(join(tmpdir(), 'atomic-core-diffusion-')))
  layout = dataLayout(dataFolder)
})
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()))
  await rm(dataFolder, { recursive: true, force: true })
})

interface Harness {
  service: DiffusionService
  events: Array<{ name: string; payload: unknown }>
  reasons: () => string[]
  journal: Array<{ op: 'add' | 'remove'; pid: number; modelId?: string }>
  log: string[]
}

const MAC_16: SystemInfo = {
  cpu: { name: 'Apple M3 Pro', core_count: 12, arch: 'aarch64', extensions: [], extensions_known: true },
  os_type: 'macos',
  os_name: 'macOS 15',
  total_memory: 16 * 1024,
  gpus: [],
}

function harness(
  options: { idleTickMs?: number; claimGpu?: GpuClaimHook; systemInfo?: SystemInfo } = {}
): Harness {
  const events: Harness['events'] = []
  const journal: Harness['journal'] = []
  const log: string[] = []
  const service = new DiffusionService({
    paths: layout.diffusion,
    dataFolder,
    emit: (name, payload) => events.push({ name, payload }),
    log: (level, msg) => log.push(`${level}: ${msg}`),
    journal: {
      add: async (pid, _port, _exe, modelId) => {
        journal.push({ op: 'add', pid, modelId })
      },
      remove: async (pid) => {
        journal.push({ op: 'remove', pid })
      },
    },
    timings: { pollIntervalMs: 30, cancelGraceMs: 300, cancelPollMs: 30 },
    idleTickMs: options.idleTickMs ?? 50,
    ...(options.claimGpu ? { claimGpu: options.claimGpu } : {}),
    ...(options.systemInfo ? { systemInfo: async () => options.systemInfo as SystemInfo } : {}),
  })
  service.start()
  services.push(service)
  return {
    service,
    events,
    reasons: () =>
      events
        .filter((e) => e.name === 'diffusion:state')
        .map((e) => (e.payload as CoreEvents['diffusion:state']).reason ?? ''),
    journal,
    log,
  }
}

async function loadRequest(
  modelName = 'z-image/z-image-turbo-Q4_K_M.gguf'
): Promise<LoadDiffusionModelRequest> {
  const diffusionModel = await writeFakeSdModel(layout, modelName)
  return {
    modelId: 'z-image:q4_k_m',
    family: 'z-image',
    modality: 'image',
    displayName: 'Z-Image Turbo',
    files: { diffusionModel },
    defaults: { steps: 4, cfgScale: 1.0, samplingMethod: 'euler', width: 512, height: 512 },
    // Small outputs keep the fake fast; the multiple still refuses a width of 100.
    ranges: { steps: [1, 50], dims: [16, 2048], dimMultiple: 16 },
    offload: 'none',
    startupTimeoutSecs: 10,
  }
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false
  )
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await sleep(20)
  }
}

describe('configure', () => {
  it('accepts the core data folder only, creates the folders, and answers the status', async () => {
    const { service } = harness()
    await expect(service.configure({ dataFolder: ' ' })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: 'The data folder is not set.',
    })
    await expect(service.configure({ dataFolder: join(dataFolder, 'other') })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
      message: "Image generation runs inside the core's data folder only.",
    })
    expect((await service.getStatus()).configured).toBe(false)
    await expect(service.listGallery({ offset: 0, limit: 1 })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    })

    const status = await service.configure({ dataFolder, idleUnloadSecs: 0 })
    expect(status).toEqual({
      configured: true,
      install: { state: 'not-installed' },
      model: { state: 'unloaded', loaded: null },
      activeJob: null,
      activeVideoJob: null,
      outputDir: join(dataFolder, 'images'),
      videoOutputDir: join(dataFolder, 'videos'),
      idleUnloadSecs: 0,
    })
    for (const dir of [
      layout.diffusion.root,
      layout.diffusion.backendsDir,
      layout.diffusion.modelsDir,
      join(dataFolder, 'images'),
      join(dataFolder, 'videos'),
    ])
      expect(await exists(dir), dir).toBe(true)
    // Another spelling of the same folder is fine.
    await expect(
      service.configure({ dataFolder: join(dataFolder, 'diffusion', '..') })
    ).resolves.toBeDefined()
  })

  it('changes the output folder and reports it', async () => {
    const { service, reasons } = harness()
    await expect(service.setOutputDir('/x')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    await service.configure({ dataFolder })
    const custom = join(dataFolder, 'pictures')
    expect((await service.setOutputDir(custom)).outputDir).toBe(custom)
    expect(await exists(custom)).toBe(true)
    expect(reasons()).toEqual(['output-dir'])
    expect((await service.setOutputDir('  ')).outputDir).toBe(join(dataFolder, 'images'))
    await writeFile(join(dataFolder, 'blocker'), 'a file')
    await expect(service.setOutputDir(join(dataFolder, 'blocker', 'x'))).rejects.toMatchObject({
      message: 'Could not create the output folder.',
    })
  })
})

describe.skipIf(!posix)('the engine and the model', () => {
  it('finalizes an unpacked tree, lists it, loads a model on it and unloads', async () => {
    const h = harness()
    await h.service.configure({ dataFolder })
    const dir = join(layout.diffusion.backendsDir, 'master-849-d04e895', 'fake-cpu')
    await writeFakeSdLaunchers(dir)
    await expect(h.service.loadModel(await loadRequest())).rejects.toMatchObject({
      code: 'ENGINE_MISSING',
      message: 'Install the image engine first.',
    })
    // A load refused for its engine leaves the model failed with that error (`load-blocked`).
    expect((await h.service.getStatus()).model).toMatchObject({
      state: 'failed',
      error: { code: 'ENGINE_MISSING' },
    })
    const record = await h.service.finalizeBackendInstall({
      dir,
      tag: 'master-849-d04e895',
      backendId: 'fake-cpu',
      backend: 'cpu',
      engine: 'sd-cpp',
    })
    expect(record.dir).toBe(dir)
    expect(h.reasons()).toEqual(['load-blocked', 'install'])
    expect(await h.service.listInstalledBackends()).toEqual([record])
    expect((await h.service.getStatus()).install).toMatchObject({
      state: 'installed',
      backendId: 'fake-cpu',
      dir,
    })

    const request = await loadRequest()
    await expect(h.service.loadModel({ ...request, engine: 'diffusers' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_BACKEND',
      details: 'diffusers',
    })
    await expect(
      h.service.loadModel({ ...request, files: { diffusionModel: join(dataFolder, 'no.gguf') } })
    ).rejects.toMatchObject({
      code: 'MODEL_MISSING',
      message: 'no.gguf is missing. Download the model again.',
      details: `diffusionModel: ${join(dataFolder, 'no.gguf')}`,
    })
    await expect(
      h.service.loadModel({ ...request, files: { ...request.files, vae: '/nope/ae.safetensors' } })
    ).rejects.toMatchObject({
      code: 'SIDE_FILE_MISSING',
      message: 'ae.safetensors is missing. Download the model again.',
    })
    expect(() => h.service.getCapabilities()).toThrow('Load an image model first.')
    expect(h.service.getJob('nope')).toBeNull()

    const loaded = await h.service.loadModel({ ...request, threads: 2 })
    expect(loaded).toMatchObject({
      modelId: 'z-image:q4_k_m',
      engine: 'sd-cpp',
      backend: 'cpu',
      cpuFallback: false,
    })
    expect(isProcessAlive(loaded.pid)).toBe(true)
    expect(h.journal).toEqual([{ op: 'add', pid: loaded.pid, modelId: 'z-image:q4_k_m' }])
    expect(h.reasons()).toEqual(['load-blocked', 'install', 'load', 'loaded'])
    const status = await h.service.getStatus()
    expect(status.model).toEqual({ state: 'loaded', loaded })
    expect(status.install).toMatchObject({ dir })
    expect(h.service.getCapabilities()).toMatchObject({
      cancelGenerating: false,
      maxBatch: 4,
      workflows: ['create', 'transform', 'inpaint', 'extend', 'upscale'],
    })
    h.service.touchIdle()

    // The engine and the model files are in use now.
    await expect(h.service.removeBackend(dir)).rejects.toMatchObject({ code: 'BACKEND_IN_USE' })
    await expect(h.service.deleteModelFile(request.files.diffusionModel)).rejects.toMatchObject({
      code: 'BACKEND_IN_USE',
      message: 'That file belongs to the loaded image model. Unload it first.',
    })
    expect((await h.service.listModelFiles()).map((f) => f.relativePath)).toEqual([
      'z-image/z-image-turbo-Q4_K_M.gguf',
    ])

    await h.service.unloadModel()
    expect(isProcessAlive(loaded.pid)).toBe(false)
    expect(h.journal.at(-1)).toEqual({ op: 'remove', pid: loaded.pid })
    expect(h.reasons().slice(-2)).toEqual(['unload', 'unload'])
    expect((await h.service.getStatus()).model).toEqual({ state: 'unloaded', loaded: null })
    await h.service.deleteModelFile(request.files.diffusionModel)
    await h.service.removeBackend(dir)
    expect(await exists(dir)).toBe(false)
    expect(h.reasons().at(-1)).toBe('uninstall')
    // Unloading nothing is fine.
    await h.service.unloadModel()
  })

  // `load_model` with `select_model_install` (`commands.rs`, app commit ec1fd3ea7).
  it('blocks a modern family on an old engine, then loads it on a compatible tree of that backend', async () => {
    const h = harness()
    await h.service.configure({ dataFolder })
    const install = async (tag: string) => {
      const dir = join(layout.diffusion.backendsDir, tag, 'fake-cpu')
      await writeFakeSdLaunchers(dir)
      return h.service.finalizeBackendInstall({
        dir,
        tag,
        backendId: 'fake-cpu',
        backend: 'cpu',
        engine: 'sd-cpp',
      })
    }
    await install('master-849-d04e895')
    const request = { ...(await loadRequest()), modelId: 'qwen-image-2.1:q4_k', family: 'qwen-image-2.1' }
    await expect(h.service.loadModel(request)).rejects.toMatchObject({
      code: 'ENGINE_UPDATE_REQUIRED',
      details: 'installed=master-849-d04e895; required=master-883-137f740 or newer',
    })
    expect((await h.service.getStatus()).model).toMatchObject({
      state: 'failed',
      error: { code: 'ENGINE_UPDATE_REQUIRED' },
    })
    expect(h.reasons().at(-1)).toBe('load-blocked')
    // A blocked load is told through the state, not as a separate error event.
    expect(h.events.filter((e) => e.name === 'diffusion:error')).toEqual([])

    const current = await install('master-883-137f740')
    const loaded = await h.service.loadModel(request)
    expect(loaded.family).toBe('qwen-image-2.1')
    expect((await h.service.getStatus()).install).toMatchObject({
      tag: 'master-883-137f740',
      dir: current.dir,
    })
    await h.service.unloadModel()
  })

  it('checks and protects the vision projector like any other side file', async () => {
    const h = harness()
    await h.service.configure({ dataFolder })
    const dir = join(layout.diffusion.backendsDir, 'master-883-137f740', 'fake-cpu')
    await writeFakeSdLaunchers(dir)
    await h.service.finalizeBackendInstall({
      dir,
      tag: 'master-883-137f740',
      backendId: 'fake-cpu',
      backend: 'cpu',
      engine: 'sd-cpp',
    })
    const request = await loadRequest()
    const missing = join(dataFolder, 'nope', 'mmproj.gguf')
    await expect(
      h.service.loadModel({ ...request, files: { ...request.files, llmVision: missing } })
    ).rejects.toMatchObject({
      code: 'SIDE_FILE_MISSING',
      message: 'mmproj.gguf is missing. Download the model again.',
      details: `llmVision: ${missing}`,
    })
    const projector = await writeFakeSdModel(layout, 'qwen-image-2.1/mmproj.gguf')
    await h.service.loadModel({ ...request, files: { ...request.files, llmVision: projector } })
    await expect(h.service.deleteModelFile(projector)).rejects.toMatchObject({ code: 'BACKEND_IN_USE' })
    await h.service.unloadModel()
  })

  it('reports a load that fails, and stops one that is abandoned', async () => {
    const h = harness()
    await h.service.configure({ dataFolder })
    await installFakeSdEngine(layout, { mode: 'exit-early' })
    const request = await loadRequest()
    await expect(h.service.loadModel(request)).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' })
    expect(h.reasons()).toEqual(['load', 'load-failed'])
    const status = await h.service.getStatus()
    expect(status.model.state).toBe('failed')
    expect(status.model.error?.code).toBe('MODEL_LOAD_FAILED')
    expect(h.journal.map((j) => j.op)).toEqual(['add', 'remove'])

    // A slow load, abandoned by an unload: the child is gone, the load reports the cancel.
    await rm(layout.diffusion.backendsDir, { recursive: true, force: true })
    await installFakeSdEngine(layout, { loadMs: 5_000, pidFile: join(dataFolder, 'pids') })
    // The rejection lands while the unload still holds the lock: keep a handler on it from the start.
    const loading = h.service.loadModel(request).then(
      () => undefined,
      (e: unknown) => e
    )
    await waitFor(() => exists(join(dataFolder, 'pids')))
    await h.service.unloadModel()
    expect(await loading).toMatchObject({ code: 'CANCELLED', message: 'The image model load was stopped.' })
    const [pid] = (await readFile(join(dataFolder, 'pids'), 'utf8')).split('\n').filter(Boolean).map(Number)
    expect(isProcessAlive(pid as number)).toBe(false)
  })
})

/**
 * Task 3.2: an engine build installed through the core's engine-builds module, with this service as
 * the sd.cpp host. The "download" copies a tarball of the fake engine's launchers; the manifest pins
 * it like conf does.
 */
describe.skipIf(!posix)('engine builds through the core', () => {
  async function engineBuilds(h: Harness, tag: string) {
    const src = join(dataFolder, 'archive-src', tag)
    await writeFakeSdLaunchers(src)
    const archive = join(dataFolder, 'archive-src', `${tag}.tar.gz`)
    await tarCreate({ gzip: true, cwd: src, file: archive }, ['sd-server', 'sd-cli'])
    const manifest = parseSdcppManifest({
      tag_name: tag,
      download_base: 'https://mirror.test/releases',
      assets: [{ backend: 'macos-arm64', name: 'sd.tar.gz', sha256: 'a'.repeat(64), size: 1 }],
    })
    return new EngineBuildsService({
      dataFolder,
      roots: { 'sd-cpp': layout.diffusion.backendsDir, 'mlx': layout.provider('mlx').backendsDir },
      failedBackendsFile: join(layout.diffusion.root, 'failed-backends.json'),
      platform: process.platform,
      downloader: {
        download: async (_task: string, items: DownloadItem[]) => {
          for (const item of items) await writeFile(item.save_path, await readFile(archive))
        },
      },
      manifests: {
        'sd-cpp': { read: async () => ({ manifest, source: 'remote', fetched_at: 1, error: null }) },
        'mlx': { read: async () => ({ manifest: null, source: null, fetched_at: null, error: 'none' }) },
      },
      hardware: async () => ({ osType: 'macos', arch: 'arm64', cpuExtensions: [], gpus: [] }),
      hosts: { 'sd-cpp': h.service.engineHost(), 'mlx': h.service.engineHost() },
      availableSpace: async () => undefined,
      emit: () => {},
    })
  }

  it('an update while a model is loaded unloads it with engine-updated, retires the old build, and the next load uses the new one', async () => {
    const h = harness()
    await h.service.configure({ dataFolder })
    const old = await installFakeSdEngine(layout, { tag: 'master-883-137f740', backendId: 'macos-arm64' })
    const request = await loadRequest()
    const loaded = await h.service.loadModel(request)
    expect(await h.service.engineHost().inUse()).toEqual([old.dir])

    const result = await (
      await engineBuilds(h, 'master-900-abcdef0')
    ).install('sd-cpp', { task_id: 'update' })

    expect(result).toEqual({
      installed: true,
      build: { tag: 'master-900-abcdef0', backend_id: 'macos-arm64', origin: 'downloaded' },
      retired: [{ tag: 'master-883-137f740', backend_id: 'macos-arm64', origin: 'downloaded' }],
      kept_in_use: [],
    })
    expect(isProcessAlive(loaded.pid)).toBe(false)
    expect(h.reasons().slice(-2)).toEqual(['engine-updated', 'install'])
    expect(await exists(old.dir)).toBe(false)
    const next = await h.service.loadModel(request)
    expect((await h.service.getStatus()).install).toMatchObject({ tag: 'master-900-abcdef0' })
    expect(await h.service.engineHost().inUse()).toEqual([
      join(layout.diffusion.backendsDir, 'master-900-abcdef0', 'macos-arm64'),
    ])
    expect(next.pid).not.toBe(loaded.pid)
    await h.service.unloadModel()
  })

  it('reports the build of a spec kept after a crash as in use, and an idle unload frees it', async () => {
    const h = harness()
    await h.service.configure({ dataFolder })
    const engine = await installFakeSdEngine(layout, {
      tag: 'master-883-137f740',
      backendId: 'macos-arm64',
      mode: 'die-mid-job',
      stepMs: 50,
    })
    await h.service.loadModel(await loadRequest())
    const { jobId } = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32 }))
    await waitFor(() => h.service.getJob(jobId)?.state === 'failed')
    // The server is gone, the spec stays for the next job to respawn from.
    expect(await h.service.engineHost().inUse()).toEqual([engine.dir])
    await h.service.unloadModel()
    expect(await h.service.engineHost().inUse()).toEqual([])
  })
})

describe.skipIf(!posix)('GPU residency', () => {
  it('claims the GPU for a load, reports the server it holds, and nothing once it is unloaded', async () => {
    const claims: GpuClaim[] = []
    const built: { service?: DiffusionService } = {}
    const h = harness({
      claimGpu: async (claim, _signal, granted) => {
        claims.push(claim)
        expect(built.service?.gpuOccupancy()).toEqual([])
        granted?.()
      },
    })
    built.service = h.service
    await installFakeSdEngine(layout)
    await h.service.configure({ dataFolder })
    expect(h.service.gpuOccupancy()).toEqual([])
    await h.service.loadModel(await loadRequest())
    // The fake engine is a CPU build: it holds no card, and says so.
    expect(claims).toEqual([{ model_id: 'z-image:q4_k_m', cards: [], auxiliary: false }])
    expect(h.service.gpuOccupancy()).toEqual([
      { model_id: 'z-image:q4_k_m', cards: [], auxiliary: false, state: 'ready' },
    ])
    await h.service.unloadModel()
    expect(h.service.gpuOccupancy()).toEqual([])
  })

  it('holds the GPU as loading while the server starts, once its claim went through', async () => {
    const h = harness({ claimGpu: async (_claim, _signal, granted) => granted?.() })
    await installFakeSdEngine(layout, { loadMs: 5_000, pidFile: join(dataFolder, 'pids') })
    await h.service.configure({ dataFolder })
    const loading = h.service.loadModel(await loadRequest()).then(
      () => undefined,
      (e: unknown) => e
    )
    await waitFor(() => exists(join(dataFolder, 'pids')))
    expect(h.service.gpuOccupancy()).toEqual([
      { model_id: 'z-image:q4_k_m', cards: [], auxiliary: false, state: 'loading' },
    ])
    await h.service.unloadModel()
    await loading
    expect(h.service.gpuOccupancy()).toEqual([])
  })

  it(
    'an unload that arrives while a load is still taking the old server down never deadlocks with that load’s claim',
    { timeout: 10_000 },
    async () => {
      // The claim behaves like core's residency while it evicts this very service: it is granted only
      // once the eviction — `unloadModel` — has finished, unless the load is aborted first.
      let unloaded: Promise<void> = new Promise(() => {})
      let blocking = false
      const h = harness({
        claimGpu: (_claim, signal, granted) => {
          if (!blocking) {
            granted?.()
            return Promise.resolve()
          }
          if (signal?.aborted) return Promise.reject(loadCancelledError())
          return new Promise((resolve, reject) => {
            signal?.addEventListener('abort', () => reject(loadCancelledError()), { once: true })
            void unloaded.then(() => {
              granted?.()
              resolve()
            })
          })
        },
      })
      await installFakeSdEngine(layout)
      await h.service.configure({ dataFolder })
      const request = await loadRequest()
      await h.service.loadModel(request)

      blocking = true
      const reloading = h.service.loadModel(request).then(
        () => 'loaded',
        (e: unknown) => (e as { details?: string }).details ?? String(e)
      )
      unloaded = h.service.unloadModel()
      await unloaded
      expect(await reloading).toContain('MODEL_LOAD_CANCELLED')
      expect(h.service.gpuOccupancy()).toEqual([])
      // The lock is free: the next load goes through.
      blocking = false
      await h.service.loadModel(request)
    }
  )

  it('reports a server being taken down as stopping, and an unload waits for that exit even when it began outside the lock', async () => {
    const h = harness()
    const stopping = { spec: { modelId: 'flux', backend: 'cuda', cpuFallback: false } }
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    h.service.state.stopping = { ...stopping, done } as unknown as typeof h.service.state.stopping
    expect(h.service.gpuOccupancy()).toEqual([
      { model_id: 'flux', cards: 'all', auxiliary: false, state: 'stopping' },
    ])
    let finished = false
    const unloading = h.service.unloadModel().then(() => (finished = true))
    await sleep(30)
    expect(finished).toBe(false)
    release()
    await unloading
    expect(finished).toBe(true)
  })

  it('a load waits for a server still being taken down outside the lock before it spawns another (final review M-9)', async () => {
    const h = harness()
    await installFakeSdEngine(layout)
    await h.service.configure({ dataFolder })
    // A crash or cancel teardown that began outside the load lock and has not seen its exit yet.
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    h.service.state.stopping = {
      spec: { modelId: 'z-image:q4_k_m', backend: 'cpu', cpuFallback: false },
      done,
    } as unknown as typeof h.service.state.stopping
    const loading = h.service.loadModel(await loadRequest())
    await sleep(100)
    expect(h.journal.filter((j) => j.op === 'add')).toEqual([])
    h.service.state.stopping = undefined
    release()
    await loading
    expect(h.journal.filter((j) => j.op === 'add')).toHaveLength(1)
  })

  it('an unload aborts a load still waiting for its GPU claim, so the load lock is never held hostage', async () => {
    let waiting = false
    const h = harness({
      claimGpu: (_claim, signal) =>
        new Promise((_resolve, reject) => {
          waiting = true
          signal?.addEventListener('abort', () => reject(loadCancelledError()), { once: true })
        }),
    })
    await installFakeSdEngine(layout)
    await h.service.configure({ dataFolder })
    const loading = h.service.loadModel(await loadRequest()).then(
      () => undefined,
      (e: unknown) => e
    )
    await waitFor(() => waiting)
    await h.service.unloadModel()
    expect(await loading).toMatchObject({
      code: 'INTERNAL',
      details: expect.stringContaining('MODEL_LOAD_CANCELLED'),
    })
    expect(h.journal).toEqual([])
    expect(h.service.gpuOccupancy()).toEqual([])
  })
})

describe.skipIf(!posix)('generating', () => {
  async function loadedService(options: FakeSdOptions = {}) {
    const h = harness()
    await h.service.configure({ dataFolder })
    await installFakeSdEngine(layout, { stepMs: 10, ...options })
    const request = await loadRequest()
    const loaded = await h.service.loadModel(request)
    return { ...h, loaded, request }
  }

  it('runs a job to the gallery with step progress, and answers the OpenAI path with the bytes', async () => {
    const h = await loadedService()
    const { jobId } = await h.service.generate(
      sampleRequest({ width: 64, height: 32, batchSize: 2, seed: 7 })
    )
    expect(h.service.getJob(jobId)?.state).toBe('queued')
    expect((await h.service.getStatus()).activeJob?.id).toBe(jobId)
    await waitFor(() => h.service.getJob(jobId)?.state === 'completed')
    const job = h.service.getJob(jobId)
    expect(job?.outputs).toHaveLength(2)
    expect(job?.outputs.map((o) => [o.width, o.height, o.recipe.seed])).toEqual([
      [64, 32, 7],
      [64, 32, 8],
    ])
    expect(job?.outputs.every((o) => o.thumbnailPath !== null)).toBe(true)
    expect(job?.progress?.phase).toBe('saving')
    const progress = h.events
      .filter((e) => e.name === 'diffusion:progress')
      .map((e) => (e.payload as CoreEvents['diffusion:progress']).progress)
    // One snapshot per poll: steps may be skipped, images and phases may not.
    expect(progress.some((p) => p.phase === 'sampling' && p.totalSteps === 4 && p.batchIndex === 0)).toBe(
      true
    )
    expect(progress.some((p) => p.batchIndex === 1)).toBe(true)
    expect(progress.some((p) => p.phase === 'decoding')).toBe(true)
    const page = await h.service.listGallery({ offset: 0, limit: 10 })
    expect(page.total).toBe(2)
    expect(page.items[0]?.recipe.jobId).toBe(jobId)
    const item = await h.service.getGalleryItem(page.items[0]?.id as string)
    expect(item?.recipe.prompt).toBe('a cat')
    const flagged = await h.service.setGalleryFlags(item?.id as string, { pinned: true })
    expect(flagged.pinned).toBe(true)
    const target = join(dataFolder, 'export', 'a.png')
    await h.service.exportGalleryItem(item?.id as string, target)
    expect(await exists(target)).toBe(true)
    await h.service.deleteGalleryItems([item?.id as string])
    expect((await h.service.listGallery({ offset: 0, limit: 10 })).total).toBe(1)

    const outcome = await h.service.runImageJob(sampleRequest({ width: 32, height: 32, batchSize: 1 }))
    expect(outcome.images).toHaveLength(1)
    expect(outcome.job.state).toBe('completed')
    expect((await h.service.getStatus()).activeJob).toBeNull()
    expect(h.events.filter((e) => e.name === 'diffusion:error')).toEqual([])
  })

  it('cancels a running job by stopping the engine, and the next job brings it back', async () => {
    const h = await loadedService({ stepMs: 400 })
    const { jobId } = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32 }))
    await waitFor(() => h.service.getJob(jobId)?.state === 'generating')
    const result = await h.service.cancelJob(jobId)
    expect(result).toEqual({ cancelled: true, serverStopped: true })
    expect(h.service.getJob(jobId)?.state).toBe('cancelled')
    expect(isProcessAlive(h.loaded.pid)).toBe(false)
    expect((await h.service.getStatus()).model.state).toBe('unloaded')
    expect(h.journal.at(-1)).toEqual({ op: 'remove', pid: h.loaded.pid })

    const next = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32, steps: 1 }))
    await waitFor(() => h.service.getJob(next.jobId)?.state === 'completed', 10_000)
    expect(h.reasons()).toContain('respawn')
    const status = await h.service.getStatus()
    expect(status.model.state).toBe('loaded')
    expect(status.model.loaded?.pid).not.toBe(h.loaded.pid)
    expect(h.journal.filter((j) => j.op === 'add')).toHaveLength(2)
  })

  it('an unload asked for while a respawn waits for a teardown aborts the GPU claim that respawn then starts (final review M-9)', async () => {
    const aborted: boolean[] = []
    const h = harness({
      claimGpu: (_claim, signal, granted) => {
        aborted.push(signal?.aborted === true)
        if (signal?.aborted) return Promise.reject(loadCancelledError())
        granted?.()
        return Promise.resolve()
      },
    })
    await h.service.configure({ dataFolder })
    await installFakeSdEngine(layout, { stepMs: 400 })
    const loaded = await h.service.loadModel(await loadRequest())
    // A cancel stops the engine and keeps the spec: the next job respawns it.
    const first = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32 }))
    await waitFor(() => h.service.getJob(first.jobId)?.state === 'generating')
    await h.service.cancelJob(first.jobId)
    expect(isProcessAlive(loaded.pid)).toBe(false)

    // A teardown still in flight outside the lock holds the respawn before its claim.
    let release!: () => void
    const done = new Promise<void>((resolve) => (release = resolve))
    h.service.state.stopping = {
      spec: { modelId: 'z-image:q4_k_m', backend: 'cpu', cpuFallback: false },
      done,
    } as unknown as typeof h.service.state.stopping
    const next = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32, steps: 1 }))
    await sleep(100)
    // No load is in flight for `unloadModel` to abort: only its pending-unload count reaches the respawn.
    const unloading = h.service.unloadModel()
    h.service.state.stopping = undefined
    release()
    await unloading
    await waitFor(() => ['failed', 'cancelled'].includes(h.service.getJob(next.jobId)?.state ?? ''))
    expect(aborted).toEqual([false, true])
    expect(h.journal.filter((j) => j.op === 'add')).toHaveLength(1)
    expect(h.service.gpuOccupancy()).toEqual([])
    expect((await h.service.getStatus()).model.state).toBe('unloaded')
  })

  // `finalize_backend_install` + `activate_install` (`commands.rs`/`session.rs`, app commit ec1fd3ea7).
  it('finalizes a new engine under the load lock: the running job is cancelled, the old server unloaded', async () => {
    const h = await loadedService({ stepMs: 400 })
    const { jobId } = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32 }))
    await waitFor(() => h.service.getJob(jobId)?.state === 'generating')
    const dir = join(layout.diffusion.backendsDir, 'master-900-abcdef0', 'fake-cpu')
    await writeFakeSdLaunchers(dir)
    const record = await h.service.finalizeBackendInstall({
      dir,
      tag: 'master-900-abcdef0',
      backendId: 'fake-cpu',
      backend: 'cpu',
      engine: 'sd-cpp',
    })
    expect(h.service.getJob(jobId)?.state).toBe('cancelled')
    expect(isProcessAlive(h.loaded.pid)).toBe(false)
    const status = await h.service.getStatus()
    expect(status.model.state).toBe('unloaded')
    expect(status.install).toMatchObject({ tag: 'master-900-abcdef0', dir: record.dir })
    expect(h.reasons().slice(-2)).toEqual(['engine-updated', 'install'])
    // Nothing is left to respawn the old binary from.
    await expect(h.service.generate(sampleRequest())).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' })
  })

  it('cancels the active job before loading another model, and unloads on idle', async () => {
    const h = await loadedService({ stepMs: 400 })
    const { jobId } = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32 }))
    await waitFor(() => h.service.getJob(jobId)?.state === 'generating')
    const reloaded = await h.service.loadModel(h.request)
    expect(h.service.getJob(jobId)?.state).toBe('cancelled')
    expect(reloaded.pid).not.toBe(h.loaded.pid)

    await h.service.configure({ dataFolder, idleUnloadSecs: 1 })
    await waitFor(async () => (await h.service.getStatus()).model.state === 'unloaded', 5_000)
    expect(h.reasons().at(-1)).toBe('idle')
    expect(isProcessAlive(reloaded.pid)).toBe(false)
    expect(h.log).toContain('info: unloading the image model after idling')
  })

  it('refuses a second job, a bad request, and reports a crash with the spec kept', async () => {
    const h = await loadedService({ mode: 'die-mid-job', stepMs: 50 })
    await expect(h.service.generate(sampleRequest({ width: 100 }))).rejects.toMatchObject({
      code: 'INVALID_DIMENSIONS',
    })
    const { jobId } = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32 }))
    await expect(h.service.generate(sampleRequest())).rejects.toMatchObject({
      code: 'JOB_BUSY',
      details: jobId,
    })
    await waitFor(() => h.service.getJob(jobId)?.state === 'failed')
    const job = h.service.getJob(jobId)
    expect(job?.error?.code).toBe('OUT_OF_MEMORY')
    expect(job?.error?.message).toBe('sd-server ran out of memory while generating.')
    const status = await h.service.getStatus()
    expect(status.model.state).toBe('failed')
    expect(status.model.error?.code).toBe('OUT_OF_MEMORY')
    expect(h.events.filter((e) => e.name === 'diffusion:error')).toHaveLength(1)
    expect(h.reasons()).toContain('crashed')
    await expect(h.service.cancelJob(jobId)).resolves.toEqual({ cancelled: false, serverStopped: false })
  })

  it('finishes a job that ran out of GPU memory under the offload fallback', async () => {
    const h = harness()
    await h.service.configure({ dataFolder })
    const argvFile = join(dataFolder, 'argv.json')
    await installFakeSdEngine(layout, {
      mode: 'die-mid-job',
      onceMarker: join(dataFolder, 'once'),
      argvFile,
      stepMs: 10,
    })
    const loaded = await h.service.loadModel({ ...(await loadRequest()), offloadFallback: 'group' })
    expect(loaded.offload).toBe('none')
    expect(JSON.parse(await readFile(argvFile, 'utf8'))).not.toContain('--offload-to-cpu')

    const { jobId } = await h.service.generate(sampleRequest({ batchSize: 1, width: 32, height: 32 }))
    await waitFor(() => h.service.getJob(jobId)?.state === 'completed')
    expect(h.service.getJob(jobId)?.outputs[0]?.recipe.engine.offload).toBe('group')
    expect(JSON.parse(await readFile(argvFile, 'utf8'))).toContain('--offload-to-cpu')
    expect((await h.service.getStatus()).model.loaded?.offload).toBe('group')
    expect(h.reasons()).toContain('offload-fallback')
    expect(h.events.filter((e) => e.name === 'diffusion:error')).toEqual([])
  })

  it('shuts down: the server is gone and nothing loads any more', async () => {
    const h = await loadedService()
    await h.service.shutdown()
    expect(isProcessAlive(h.loaded.pid)).toBe(false)
    expect(h.reasons().at(-1)).toBe('loaded')
    await expect(h.service.loadModel(h.request)).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
      message: 'sd-server was stopped.',
    })
    await h.service.shutdown()
  })
})

async function videoLoadRequest(): Promise<LoadDiffusionModelRequest> {
  const diffusionModel = await writeFakeSdModel(layout, 'ltx-2/ltx-2.3-22b-distilled-Q4_K_M.gguf')
  const vae = await writeFakeSdModel(layout, 'shared/ltx/video_vae.safetensors')
  const audioVae = await writeFakeSdModel(layout, 'shared/ltx/audio_vae.safetensors')
  const llm = await writeFakeSdModel(layout, 'shared/gemma/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf')
  const embeddingsConnectors = await writeFakeSdModel(layout, 'shared/ltx/connectors.safetensors')
  return {
    modelId: 'ltx-2:q4_k_m',
    family: 'ltx-2',
    modality: 'video',
    displayName: 'LTX-2.3 Distilled',
    files: { diffusionModel, vae, audioVae, llm, embeddingsConnectors },
    defaults: {
      steps: 2,
      cfgScale: 1.0,
      samplingMethod: 'euler',
      width: 64,
      height: 32,
      video: { fps: 24, frames: 9, frameStep: 8, frameOffset: 1, resolutionPresets: [[64, 32]] },
    },
    ranges: { steps: [1, 50], dims: [16, 2048], dimMultiple: 16, frames: [9, 257] },
    offload: 'none',
    startupTimeoutSecs: 10,
  }
}

const webmFixture = () =>
  readFile(fileURLToPath(new URL('../../test/fixtures/webm/tiny.webm', import.meta.url)))

describe.skipIf(!posix)('generating video', () => {
  async function loadedVideoService(options: FakeSdOptions = {}, systemInfo?: SystemInfo) {
    const h = harness(systemInfo ? { systemInfo } : {})
    await h.service.configure({ dataFolder })
    await installFakeSdEngine(layout, { stepMs: 10, modes: ['img_gen', 'vid_gen'], ...options })
    const request = await videoLoadRequest()
    const loaded = await h.service.loadModel(request)
    return { ...h, loaded, request }
  }

  it('runs a clip into the videos folder with its sidecar, takes a poster, and serves the video gallery', async () => {
    const h = await loadedVideoService()
    expect(h.loaded.modality).toBe('video')
    expect(h.service.getVideoCapabilities()).toMatchObject({
      fps: 24,
      frames: { min: 9, max: 257, step: 8, offset: 1, default: 9 },
      webmSupported: true,
      cancelGenerating: false,
    })
    expect(() => h.service.getCapabilities()).toThrow(expect.objectContaining({ code: 'MODEL_INCOMPATIBLE' }))
    await expect(h.service.generate(sampleRequest())).rejects.toMatchObject({ code: 'MODEL_INCOMPATIBLE' })
    // The model files are the video model's now.
    await expect(h.service.deleteModelFile(h.request.files.audioVae as string)).rejects.toMatchObject({
      code: 'BACKEND_IN_USE',
      message: 'That file belongs to the loaded video model. Unload it first.',
    })

    const { jobId } = await h.service.generateVideo(
      sampleVideoRequest({ width: 64, height: 32, frames: 9, steps: 4, seed: 7 })
    )
    expect(h.service.getVideoJob(jobId)?.state).toBe('queued')
    expect(h.service.getJob(jobId)).toBeNull()
    const status = await h.service.getStatus()
    expect(status.activeVideoJob?.id).toBe(jobId)
    expect(status.activeJob).toBeNull()
    await waitFor(() => h.service.getVideoJob(jobId)?.state === 'completed')
    const job = h.service.getVideoJob(jobId)
    const [item] = job?.outputs ?? []
    expect(item?.path).toBe(join(dataFolder, 'videos', `${jobId}.webm`))
    expect((await readFile(item?.path as string)).equals(await webmFixture())).toBe(true)
    expect(await exists(join(dataFolder, 'videos', `${jobId}.json`))).toBe(true)
    expect([item?.frameCount, item?.fps, item?.recipe.seed, item?.posterPath]).toEqual([9, 24, 7, null])
    const progress = h.events
      .filter((e) => e.name === 'diffusion:video-progress')
      .map((e) => (e.payload as CoreEvents['diffusion:video-progress']).progress)
    expect(
      progress.some((p) => p.totalSteps === 4 && (p.phase === 'sampling' || p.phase === 'decoding'))
    ).toBe(true)
    expect(h.events.some((e) => e.name === 'diffusion:job' || e.name === 'diffusion:progress')).toBe(false)

    const poster = await paintedPng(32, 16)
    const withPoster = await h.service.setVideoPoster(
      jobId,
      `data:image/png;base64,${poster.toString('base64')}`
    )
    expect(withPoster.posterPath).toBe(join(dataFolder, 'videos', `${jobId}.thumb.png`))
    await expect(h.service.setVideoPoster(jobId, 'x'.repeat(30_000_000))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'The poster is too large.',
    })
    const page = await h.service.listVideoGallery({ offset: 0, limit: 10 })
    expect(page.total).toBe(1)
    expect((await h.service.getVideoGalleryItem(jobId))?.posterPath).toBe(withPoster.posterPath)
    expect((await h.service.setVideoGalleryFlags(jobId, { pinned: true })).pinned).toBe(true)
    const target = join(dataFolder, 'export', 'clip.webm')
    await h.service.exportVideoGalleryItem(jobId, target)
    expect(await exists(target)).toBe(true)
    await h.service.deleteVideoGalleryItems([jobId])
    expect((await h.service.listVideoGallery({ offset: 0, limit: 10 })).total).toBe(0)
    expect(await exists(withPoster.posterPath as string)).toBe(false)

    const outcome = await h.service.runVideoJob(
      sampleVideoRequest({ width: 64, height: 32, frames: 9, steps: 2 })
    )
    expect(outcome.images).toHaveLength(1)
    expect(outcome.job.outputs[0]?.id).toBe(outcome.job.id)
    expect((await h.service.getStatus()).activeVideoJob).toBeNull()
    expect(h.events.filter((e) => e.name === 'diffusion:error')).toEqual([])
  })

  it('estimates a clip without starting anything, while another runs, and learns from the clips it made', async () => {
    const h = harness({ systemInfo: MAC_16 })
    await h.service.configure({ dataFolder })
    const clip = sampleVideoRequest({ width: 64, height: 32, frames: 9, steps: 2 })
    await expect(h.service.estimateVideo(clip)).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' })
    await installFakeSdEngine(layout, { stepMs: 150, modes: ['img_gen', 'vid_gen'] })
    await h.service.loadModel(await loadRequest())
    await expect(h.service.estimateVideo(clip)).rejects.toMatchObject({
      code: 'MODEL_INCOMPATIBLE',
      message: 'The loaded model generates images, not video. Load a video model first.',
    })
    await h.service.loadModel(await videoLoadRequest())
    // The same refusal as the job route, for the same body.
    const odd = { ...clip, frames: 10 }
    const refused = await h.service.estimateVideo(odd).catch((error: unknown) => error)
    const refusedJob = await h.service.generateVideo(odd).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: 'INVALID_REQUEST' })
    expect(refused).toEqual(refusedJob)

    const idle = await h.service.estimateVideo(clip)
    expect(idle).toMatchObject({ memory: { verdict: 'fits' }, basis: 'heuristic' })
    expect(idle.seconds?.low).toBeGreaterThan(0)

    const { jobId } = await h.service.generateVideo({ ...clip, steps: 4 })
    expect(h.service.getVideoJob(jobId)?.estimate).toMatchObject({ memory: { verdict: 'fits' } })
    await waitFor(() => h.service.getVideoJob(jobId)?.state === 'generating')
    const before = h.events.length
    const during = await h.service.estimateVideo(clip)
    expect(during).toEqual(idle)
    expect(h.events.length, 'an estimate emits nothing').toBe(before)
    expect((await h.service.getStatus()).activeVideoJob?.id).toBe(jobId)
    await waitFor(() => h.service.getVideoJob(jobId)?.state === 'completed', 10_000)

    // The finished clip calibrates the next estimate; deleting it takes the calibration away.
    const learned = await h.service.estimateVideo(clip)
    expect(learned.basis).toBe('history')
    await h.service.deleteVideoGalleryItems([jobId])
    expect((await h.service.estimateVideo(clip)).basis).toBe('heuristic')
  })

  it('cannot estimate without hardware facts, and still runs the clip without one', async () => {
    const h = await loadedVideoService()
    const clip = sampleVideoRequest({ width: 64, height: 32, frames: 9, steps: 1 })
    await expect(h.service.estimateVideo(clip)).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'The core has no hardware facts to estimate the video with.',
    })
    const outcome = await h.service.runVideoJob(clip)
    expect(outcome.job).not.toHaveProperty('estimate')
    expect(h.log).toContain(
      'warn: video estimate failed: The core has no hardware facts to estimate the video with.'
    )
  })

  it('tiles the decode by the machine’s memory, and reports the decode’s tiles', async () => {
    const bodyFile = join(dataFolder, 'vid-body.json')
    const h = await loadedVideoService({ bodyFile, decodeTiles: 3, tileMs: 60 }, MAC_16)
    const body = async () => JSON.parse(await readFile(bodyFile, 'utf8')) as Record<string, unknown>
    // 1024² × 9 is past the old eight-megapixel-frame threshold, but one graph (2.4 GB) fits in 16 GB.
    const fits = await h.service.runVideoJob(
      sampleVideoRequest({ width: 1024, height: 1024, frames: 9, steps: 1 })
    )
    expect(fits.job.state).toBe('completed')
    expect(await body()).not.toHaveProperty('vae_tiling_params')
    // 2048² × 17 does not (17.8 GB); three full-width strips are the least work that fits.
    await h.service.runVideoJob(sampleVideoRequest({ width: 2048, height: 2048, frames: 17, steps: 1 }))
    expect((await body())['vae_tiling_params']).toEqual({
      enabled: true,
      rel_size_x: 1,
      rel_size_y: 3,
      rel_size_w: 1,
      rel_size_h: 3,
    })
    const decoding = h.events
      .filter((e) => e.name === 'diffusion:video-progress')
      .map((e) => (e.payload as CoreEvents['diffusion:video-progress']).progress)
      .filter((p) => p.phase === 'decoding')
    expect(decoding.map((p) => p.decodeTiles)).toContainEqual({ done: 3, total: 3 })

    // Under model offload the engine tiles by its own flag: no plan, the threshold as before.
    await h.service.loadModel({ ...h.request, offload: 'model' })
    const offloaded = sampleVideoRequest({ width: 1024, height: 1024, frames: 9, steps: 1 })
    expect((await h.service.estimateVideo(offloaded)).seconds).not.toBeNull()
    await h.service.runVideoJob(offloaded)
    expect((await body())['vae_tiling_params']).toEqual({ enabled: true })
  })

  it('cancels a running clip by stopping the engine, and cancelVideoJob knows only video jobs', async () => {
    const h = await loadedVideoService({ stepMs: 400 })
    await expect(h.service.cancelVideoJob('nope')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
    // The facade's view of the same service: the model, the records, the gallery and the cancel.
    const backend = h.service.videosBackend()
    expect(backend.loaded()).toMatchObject({ modelId: 'ltx-2:q4_k_m', modality: 'video' })
    expect(backend.jobs()).toEqual([])
    expect(await backend.item('nope')).toBeNull()
    const running = await backend.start(sampleVideoRequest({ width: 64, height: 32, frames: 9, steps: 4 }))
    await waitFor(() => h.service.getVideoJob(running.id)?.state === 'generating')
    expect(backend.jobs().map((j) => j.id)).toEqual([running.id])
    expect(backend.job(running.id)?.state).toBe('generating')
    expect(await backend.cancel(running.id)).toEqual({ cancelled: true, serverStopped: true })
    expect((await running.done).ok).toBe(false)
    await waitFor(async () => (await h.service.getStatus()).model.state === 'loaded' || true)
    const { jobId } = await h.service.generateVideo(
      sampleVideoRequest({ width: 64, height: 32, frames: 9, steps: 4 })
    )
    await waitFor(() => h.service.getVideoJob(jobId)?.state === 'generating')
    expect(await h.service.cancelVideoJob(jobId)).toEqual({ cancelled: true, serverStopped: true })
    expect(h.service.getVideoJob(jobId)?.state).toBe('cancelled')
    expect(isProcessAlive(h.loaded.pid)).toBe(false)
    const next = await h.service.generateVideo(
      sampleVideoRequest({ width: 64, height: 32, frames: 9, steps: 1 })
    )
    await waitFor(() => h.service.getVideoJob(next.jobId)?.state === 'completed', 10_000)
    expect(h.reasons()).toContain('respawn')
  })

  it('refuses a video model on an engine that serves images only, and a build without WebM before submit', async () => {
    const h = harness()
    await h.service.configure({ dataFolder })
    await installFakeSdEngine(layout, { modes: ['img_gen'], pidFile: join(dataFolder, 'pids') })
    const request = await videoLoadRequest()
    await expect(h.service.loadModel(request)).rejects.toMatchObject({
      code: 'MODEL_INCOMPATIBLE',
      message: 'This model is not a video model.',
      details: 'supported_modes=img_gen; wanted vid_gen',
    })
    expect((await h.service.getStatus()).model).toMatchObject({
      state: 'failed',
      error: { code: 'MODEL_INCOMPATIBLE' },
    })
    expect(h.reasons().at(-1)).toBe('load-failed')
    const [pid] = (await readFile(join(dataFolder, 'pids'), 'utf8')).split('\n').filter(Boolean).map(Number)
    expect(isProcessAlive(pid as number)).toBe(false)
    expect(h.journal.map((j) => j.op)).toEqual(['add', 'remove'])

    await rm(layout.diffusion.backendsDir, { recursive: true, force: true })
    await installFakeSdEngine(layout, { modes: ['vid_gen'], vidFormats: 'no-webm' })
    const loaded = await h.service.loadModel(request)
    expect(h.service.getVideoCapabilities().webmSupported).toBe(false)
    await expect(
      h.service.runVideoJob(sampleVideoRequest({ width: 64, height: 32, frames: 9, steps: 1 }))
    ).rejects.toMatchObject({
      code: 'UNSUPPORTED_BACKEND',
      message: 'This engine build was made without WebM support.',
    })
    expect(isProcessAlive(loaded.pid), 'the engine is left running').toBe(true)
    await h.service.unloadModel()
  })
})

describe('without an engine', () => {
  it('the idle task can be started twice and generation needs a model', async () => {
    const { service } = harness()
    service.start()
    service.start()
    await service.configure({ dataFolder })
    await expect(service.generate(sampleRequest())).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' })
    await expect(service.cancelJob('x')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
    await expect(service.generateVideo(sampleVideoRequest())).rejects.toMatchObject({
      code: 'MODEL_NOT_LOADED',
    })
    expect(service.videosBackend().loaded()).toBeUndefined()
    // Before `configure`, the facade's gallery view is empty rather than a refusal.
    const bare = harness().service
    expect(bare.videosBackend().loaded()).toBeUndefined()
    expect(await bare.videosBackend().item('x')).toBeNull()
    expect(await bare.videosBackend().list({ offset: 0, limit: 10 })).toEqual({
      items: [],
      hasMore: false,
      total: 0,
    })
    expect(DiffusionService.eventNames()).toEqual([
      'diffusion:state',
      'diffusion:progress',
      'diffusion:job',
      'diffusion:error',
      'diffusion:video-progress',
      'diffusion:video-job',
    ])
  })
})

describe('the images backend', () => {
  it('describes the resident model for the OpenAI facade, and nothing when there is none', async () => {
    const { service } = harness()
    const backend = service.imagesBackend()
    expect(backend.loaded()).toBeUndefined()
    service.state.spec = {
      binaryDir: '/e',
      engine: 'sd-cpp',
      backend: 'cpu',
      backendId: 'cpu',
      tag: 't',
      modelId: 'z-image:q4_k_m',
      family: 'z-image',
      modality: 'image',
      displayName: 'Z-Image Turbo',
      files: { diffusionModel: '/m.gguf' },
      defaults: { steps: 4, cfgScale: 1, width: 512, height: 512 },
      ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
      offload: 'none',
      extraArgs: [],
      startupTimeoutMs: 1000,
      cpuFallback: false,
    }
    expect(backend.loaded()).toEqual({
      modelId: 'z-image:q4_k_m',
      displayName: 'Z-Image Turbo',
      defaults: { steps: 4, cfgScale: 1, width: 512, height: 512 },
    })
    // The defaults are a copy.
    expect(backend.loaded()?.defaults).not.toBe(service.state.spec.defaults)
    await expect(backend.cancel('nope')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
    service.state.spec = undefined
    await expect(backend.start(sampleRequest())).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' })
  })
})
