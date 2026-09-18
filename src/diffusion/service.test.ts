/**
 * The service end to end against `test/helpers/fake-sd-server.mjs`: the command surface of
 * `commands.rs` in `tauri-plugin-atomic-diffusion` (app commit `767ff6350`). POSIX-only, because the
 * fake engine is a shell launcher.
 */
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { DataLayout } from '../config/index.js'
import type { CoreEvents, LoadDiffusionModelRequest } from '../contracts/index.js'
import { sampleRequest } from '../../test/helpers/diffusion-fixtures.js'
import {
  installFakeSdEngine,
  writeFakeSdLaunchers,
  writeFakeSdModel,
} from '../../test/helpers/fake-sd-server.js'
import type { FakeSdOptions } from '../../test/helpers/fake-sd-server.js'
import { isProcessAlive } from '../runtime/shared/index.js'
import { DiffusionService } from './service.js'

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

function harness(options: { idleTickMs?: number } = {}): Harness {
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
      outputDir: join(dataFolder, 'images'),
      idleUnloadSecs: 0,
    })
    for (const dir of [
      layout.diffusion.root,
      layout.diffusion.backendsDir,
      layout.diffusion.modelsDir,
      join(dataFolder, 'images'),
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
    const record = await h.service.finalizeBackendInstall({
      dir,
      tag: 'master-849-d04e895',
      backendId: 'fake-cpu',
      backend: 'cpu',
      engine: 'sd-cpp',
    })
    expect(record.dir).toBe(dir)
    expect(h.reasons()).toEqual(['install'])
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
    expect(h.reasons()).toEqual(['install', 'load', 'loaded'])
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

describe('without an engine', () => {
  it('the idle task can be started twice and generation needs a model', async () => {
    const { service } = harness()
    service.start()
    service.start()
    await service.configure({ dataFolder })
    await expect(service.generate(sampleRequest())).rejects.toMatchObject({ code: 'MODEL_NOT_LOADED' })
    await expect(service.cancelJob('x')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
    expect(DiffusionService.eventNames()).toEqual([
      'diffusion:state',
      'diffusion:progress',
      'diffusion:job',
      'diffusion:error',
    ])
  })
})
