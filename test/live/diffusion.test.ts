/**
 * Live checks against a real stable-diffusion.cpp `sd-server` and a real image model (the port of
 * the app's `scripts/test-local-diffusion.py`). The fake engine proves the core's own logic; only
 * the real one proves that the argv we emit is accepted, that the step bar we parse is the one it
 * prints, and that a PNG it writes lands in the gallery with its thumbnail.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_SD_ENGINE=/path/to/dir            (holds sd-server, sd-cli and their libraries)
 *   ATOMIC_LIVE_SD_MODEL=/path/to/transformer.gguf
 *   ATOMIC_LIVE_SD_VAE=/path/to/vae.safetensors   (optional; FLUX.2 also needs ATOMIC_LIVE_SD_VAE_FORMAT=flux2)
 *   ATOMIC_LIVE_SD_LLM=/path/to/text-encoder      (optional; the family's LLM text encoder)
 *   ATOMIC_LIVE_SD_LLM_VISION=/path/to/mmproj     (optional; Qwen Image 2.1's Qwen3-VL projector — with
 *                                                  it and ATOMIC_LIVE_SD_FAMILY=qwen-image-2.1 a reference
 *                                                  generation from the first output is run as well)
 *   ATOMIC_LIVE_SD_FAMILY=flux.2-klein            (optional; default flux.2-klein, 4 steps, cfg 1)
 *   ATOMIC_LIVE_SD_TAG=master-883-137f740         (optional; the engine's release tag, as the app records it)
 *
 * The video block runs when a video model is named as well (LTX-2.3 distilled by default):
 *   ATOMIC_LIVE_SD_VIDEO_MODEL=/path/to/ltx-2.3-22b-distilled-Q4_K_M.gguf
 *   ATOMIC_LIVE_SD_VIDEO_VAE=/path/to/video_vae.safetensors
 *   ATOMIC_LIVE_SD_AUDIO_VAE=/path/to/audio_vae.safetensors               (LTX)
 *   ATOMIC_LIVE_SD_VIDEO_LLM=/path/to/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf  (LTX; Wan takes ATOMIC_LIVE_SD_VIDEO_T5XXL)
 *   ATOMIC_LIVE_SD_EMBEDDINGS_CONNECTORS=/path/to/connectors.safetensors  (LTX-2.3)
 *   ATOMIC_LIVE_SD_VIDEO_FAMILY=ltx-2                                     (optional; or wan2.2-ti2v-5b)
 *   ATOMIC_LIVE_SD_VIDEO_MODE_FLAG=1                                      (optional; also pass -M vid_gen to sd-server)
 *
 * The engine tree is copied into the temporary data folder (finalize refuses trees outside it); the
 * model files are read where they are. Nothing is written outside the temporary folder.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CoreClient } from '../../src/client/index.js'
import type { CoreEvents, ImageJob, VideoJob } from '../../src/contracts/index.js'
import { AtomicCore } from '../../src/core/index.js'
import { decodePng, isWebm, parseVideoRecipe, readPngHeader } from '../../src/diffusion/index.js'
import { isProcessAlive } from '../../src/runtime/shared/index.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'

const ENGINE = process.env['ATOMIC_LIVE_SD_ENGINE'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_SD_MODEL'] ?? ''
const VAE = process.env['ATOMIC_LIVE_SD_VAE'] ?? ''
const VAE_FORMAT = process.env['ATOMIC_LIVE_SD_VAE_FORMAT'] ?? ''
const LLM = process.env['ATOMIC_LIVE_SD_LLM'] ?? ''
const LLM_VISION = process.env['ATOMIC_LIVE_SD_LLM_VISION'] ?? ''
const FAMILY = process.env['ATOMIC_LIVE_SD_FAMILY'] ?? 'flux.2-klein'
const ENABLED =
  process.env['ATOMIC_LIVE'] === '1' && ENGINE !== '' && MODEL !== '' && process.platform !== 'win32'
/** The build app v2.0.42 ships, and the oldest that runs Qwen Image 2.1 and Krea 2 Turbo. */
const TAG = process.env['ATOMIC_LIVE_SD_TAG'] ?? 'master-883-137f740'

const VIDEO_MODEL = process.env['ATOMIC_LIVE_SD_VIDEO_MODEL'] ?? ''
const VIDEO_VAE = process.env['ATOMIC_LIVE_SD_VIDEO_VAE'] ?? ''
const AUDIO_VAE = process.env['ATOMIC_LIVE_SD_AUDIO_VAE'] ?? ''
const VIDEO_LLM = process.env['ATOMIC_LIVE_SD_VIDEO_LLM'] ?? ''
const VIDEO_T5XXL = process.env['ATOMIC_LIVE_SD_VIDEO_T5XXL'] ?? ''
const CONNECTORS = process.env['ATOMIC_LIVE_SD_EMBEDDINGS_CONNECTORS'] ?? ''
const VIDEO_FAMILY = process.env['ATOMIC_LIVE_SD_VIDEO_FAMILY'] ?? 'ltx-2'
const VIDEO_ENABLED =
  process.env['ATOMIC_LIVE'] === '1' && ENGINE !== '' && VIDEO_MODEL !== '' && process.platform !== 'win32'

let data: TmpDataFolder
let core: AtomicCore
let client: CoreClient
let engineDir: string
const events: Array<{ name: string; payload: unknown }> = []

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function untilJob(id: string, states: string[], timeoutMs: number): Promise<ImageJob> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await client.diffusionJob(id)
    if (job && states.includes(job.state)) return job
    if (Date.now() > deadline) throw new Error(`job ${id} is still ${job?.state ?? 'missing'}`)
    await sleep(200)
  }
}

describe.skipIf(!ENABLED)('a real stable-diffusion.cpp engine', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-sd-')
    engineDir = join(data.layout.diffusion.backendsDir, TAG, 'live')
    await mkdir(engineDir, { recursive: true })
    await cp(ENGINE, engineDir, { recursive: true })
    core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    for (const name of ['diffusion:state', 'diffusion:job', 'diffusion:progress', 'diffusion:error'] as const)
      core.events.on(name, (payload) => events.push({ name, payload }))
    await client.configureDiffusion({ dataFolder: data.root, idleUnloadSecs: 0 })
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('answers --help with every flag the core passes', async () => {
    const help = spawnSync(join(engineDir, 'sd-server'), ['--help'], { encoding: 'utf8', timeout: 120_000 })
    const text = `${help.stdout}${help.stderr}`
    const required = (
      await readFile(new URL('../fixtures/sdcpp/required-flags.txt', import.meta.url), 'utf8')
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
    const missing = required.filter((flag) => !text.includes(flag))
    expect(missing, 'flags the pinned engine no longer knows').toEqual([])
  }, 130_000)

  it(
    'finalizes the tree, loads the model, generates, cancels and unloads',
    async () => {
      const record = await client.finalizeDiffusionBackend({
        dir: engineDir,
        tag: TAG,
        backendId: 'live',
        backend: process.platform === 'darwin' ? 'metal' : 'cpu',
        engine: 'sd-cpp',
      })
      expect(record.dir).toBe(engineDir)
      expect((await client.listDiffusionBackends()).map((b) => b.backendId)).toEqual(['live'])

      const files = {
        diffusionModel: MODEL,
        ...(VAE ? { vae: VAE } : {}),
        ...(VAE_FORMAT ? { vaeFormat: VAE_FORMAT } : {}),
        ...(LLM ? { llm: LLM } : {}),
        ...(LLM_VISION ? { llmVision: LLM_VISION } : {}),
      }
      const loaded = await client.loadDiffusionModel({
        modelId: `${FAMILY}:live`,
        family: FAMILY,
        modality: 'image',
        displayName: 'Live model',
        files,
        defaults: { steps: 4, cfgScale: 1.0, width: 1024, height: 1024 },
        ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
        offload: 'none',
        startupTimeoutSecs: 600,
      })
      expect(loaded.modelId).toBe(`${FAMILY}:live`)
      expect(isProcessAlive(loaded.pid)).toBe(true)
      const capabilities = await client.diffusionCapabilities()
      expect(capabilities.workflows).toContain('create')

      // A small, quick generation: the step bar must be the one we parse.
      const { jobId } = await client.generateImage({
        prompt: 'a small red cube on a white table, studio photo',
        width: 256,
        height: 256,
        steps: 4,
        cfgScale: 1.0,
        batchSize: 1,
        seed: 7,
      })
      const done = await untilJob(jobId, ['completed', 'failed', 'cancelled'], 15 * 60_000)
      expect(done.state, JSON.stringify(done.error)).toBe('completed')
      expect(done.outputs).toHaveLength(1)
      const output = done.outputs[0] as ImageJob['outputs'][number]
      expect([output.width, output.height]).toEqual([256, 256])
      expect(output.recipe.seed).toBe(7)
      expect(output.thumbnailPath).not.toBeNull()
      expect((await stat(output.thumbnailPath as string)).size).toBeGreaterThan(0)
      const header = await readPngHeader(output.path)
      expect(header?.texts.has('atomic')).toBe(true)
      expect(header?.texts.get('parameters')?.startsWith('a small red cube')).toBe(true)
      const image = await decodePng(await readFile(output.path))
      expect([image.width, image.height]).toEqual([256, 256])
      const progress = events
        .filter((e) => e.name === 'diffusion:progress')
        .map((e) => (e.payload as CoreEvents['diffusion:progress']).progress)
      expect(progress.some((p) => p.phase === 'sampling' && p.totalSteps === 4 && p.step >= 1)).toBe(true)
      expect(progress.some((p) => p.phase === 'saving')).toBe(true)
      expect(events.filter((e) => e.name === 'diffusion:error')).toEqual([])

      // With the vision projector, Qwen Image 2.1 also edits: a reference generation from the first output.
      if (LLM_VISION && FAMILY === 'qwen-image-2.1') {
        expect(capabilities.workflows).toEqual(expect.arrayContaining(['reference', 'edit']))
        const referenced = await client.generateImage({
          prompt: 'the same cube, now blue',
          width: 256,
          height: 256,
          steps: 4,
          cfgScale: 1.0,
          batchSize: 1,
          seed: 9,
          workflow: 'reference',
          initImage: { path: output.path },
        })
        const edited = await untilJob(referenced.jobId, ['completed', 'failed', 'cancelled'], 15 * 60_000)
        expect(edited.state, JSON.stringify(edited.error)).toBe('completed')
        expect(edited.outputs[0]?.recipe.workflow).toBe('reference')
      } else {
        expect(capabilities.workflows).not.toContain('edit')
      }

      // The OpenAI facade runs the same job.
      const served = await core.startPublicServer({ port: 0 })
      const answer = await fetch(`http://127.0.0.1:${served.port}/v1/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a small blue sphere', size: '256x256', n: 1, seed: 8 }),
      })
      expect(answer.status, await answer.clone().text()).toBe(200)
      const body = (await answer.json()) as { data: Array<{ b64_json: string }>; atomic: { seed: number } }
      expect(body.atomic.seed).toBe(8)
      const served2 = await decodePng(Buffer.from(body.data[0]?.b64_json ?? '', 'base64'))
      expect([served2.width, served2.height]).toEqual([256, 256])
      expect((await client.listGallery({ offset: 0, limit: 10 })).total).toBe(
        LLM_VISION && FAMILY === 'qwen-image-2.1' ? 3 : 2
      )

      // A hard cancel of a long job stops the server (unless the engine cancels natively), and the next job respawns it.
      const long = await client.generateImage({
        prompt: 'a long render',
        width: 512,
        height: 512,
        steps: 50,
        cfgScale: 1.0,
        batchSize: 1,
      })
      await untilJob(long.jobId, ['generating'], 10 * 60_000)
      await sleep(2_000)
      const cancelled = await client.cancelImageJob(long.jobId)
      expect(cancelled.cancelled).toBe(true)
      expect((await client.diffusionJob(long.jobId))?.state).toBe('cancelled')
      if (cancelled.serverStopped) {
        expect(isProcessAlive(loaded.pid)).toBe(false)
        expect((await client.diffusionStatus()).model.state).toBe('unloaded')
      }
      const again = await client.generateImage({
        prompt: 'a small green cone',
        width: 256,
        height: 256,
        steps: 2,
        cfgScale: 1.0,
        batchSize: 1,
      })
      const respawned = await untilJob(again.jobId, ['completed', 'failed', 'cancelled'], 15 * 60_000)
      expect(respawned.state, JSON.stringify(respawned.error)).toBe('completed')
      const status = await client.diffusionStatus()
      expect(status.model.state).toBe('loaded')

      await client.unloadDiffusionModel()
      expect(isProcessAlive(status.model.loaded?.pid as number)).toBe(false)
      expect((await client.diffusionStatus()).model.state).toBe('unloaded')
    },
    45 * 60_000
  )
})

/** LTX-2.3 distilled by default: 24 fps, 8k+1 frames, the fixed eight-step schedule, cfg 1. */
const VIDEO_FAMILIES: Record<
  string,
  {
    fps: number
    step: number
    steps: number
    cfgScale: number
    sigmas?: number[]
    width: number
    height: number
  }
> = {
  'ltx-2': {
    fps: 24,
    step: 8,
    steps: 8,
    cfgScale: 1.0,
    sigmas: [1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875],
    width: 512,
    height: 320,
  },
  'wan2.2-ti2v-5b': { fps: 24, step: 4, steps: 20, cfgScale: 5.0, width: 512, height: 320 },
}

describe.skipIf(!VIDEO_ENABLED)('a real stable-diffusion.cpp engine serving video', () => {
  let videoData: TmpDataFolder
  let videoCore: AtomicCore
  let videoClient: CoreClient
  const videoEvents: Array<{ name: string; payload: unknown }> = []

  beforeAll(async () => {
    videoData = await makeTmpDataFolder('atomic-core-live-sd-video-')
    const dir = join(videoData.layout.diffusion.backendsDir, TAG, 'live')
    await mkdir(dir, { recursive: true })
    await cp(ENGINE, dir, { recursive: true })
    if (process.env['ATOMIC_LIVE_SD_VIDEO_MODE_FLAG'] === '1')
      process.env['ATOMIC_DIFFUSION_VID_GEN_MODE_FLAG'] = '1'
    videoCore = await AtomicCore.create({ dataFolder: videoData.root, controlPort: 0 })
    videoClient = new CoreClient({ baseUrl: videoCore.control.url, token: videoCore.controlToken })
    for (const name of [
      'diffusion:state',
      'diffusion:video-job',
      'diffusion:video-progress',
      'diffusion:error',
    ] as const)
      videoCore.events.on(name, (payload) => videoEvents.push({ name, payload }))
    await videoClient.configureDiffusion({ dataFolder: videoData.root, idleUnloadSecs: 0 })
    await videoClient.finalizeDiffusionBackend({
      dir,
      tag: TAG,
      backendId: 'live',
      backend: process.platform === 'darwin' ? 'metal' : 'cpu',
      engine: 'sd-cpp',
    })
  }, 120_000)

  afterAll(async () => {
    await videoCore?.shutdown()
    await videoData?.cleanup()
  })

  it(
    'loads the video model, generates a short clip with parsed progress, serves it through /v1/videos, cancels and unloads',
    async () => {
      const family =
        VIDEO_FAMILIES[VIDEO_FAMILY] ?? (VIDEO_FAMILIES['ltx-2'] as (typeof VIDEO_FAMILIES)[string])
      const files = {
        diffusionModel: VIDEO_MODEL,
        ...(VIDEO_VAE ? { vae: VIDEO_VAE } : {}),
        ...(AUDIO_VAE ? { audioVae: AUDIO_VAE } : {}),
        ...(VIDEO_LLM ? { llm: VIDEO_LLM } : {}),
        ...(VIDEO_T5XXL ? { t5xxl: VIDEO_T5XXL } : {}),
        ...(CONNECTORS ? { embeddingsConnectors: CONNECTORS } : {}),
      }
      const frames = family.step + 1
      const loaded = await videoClient.loadDiffusionModel({
        modelId: `${VIDEO_FAMILY}:live`,
        family: VIDEO_FAMILY,
        modality: 'video',
        displayName: 'Live video model',
        files,
        defaults: {
          steps: family.steps,
          cfgScale: family.cfgScale,
          samplingMethod: 'euler',
          width: family.width,
          height: family.height,
          ...(family.sigmas ? { sigmas: family.sigmas } : {}),
          video: {
            fps: family.fps,
            frames,
            frameStep: family.step,
            frameOffset: 1,
            resolutionPresets: [[family.width, family.height]],
          },
        },
        ranges: { steps: [1, 50], dims: [256, 1280], dimMultiple: 32, frames: [frames, 257] },
        offload: 'group',
        startupTimeoutSecs: 1800,
      })
      expect(loaded.modality).toBe('video')
      expect(isProcessAlive(loaded.pid)).toBe(true)
      const capabilities = await videoClient.diffusionVideoCapabilities()
      // What the pinned build says about itself: the live run's evidence for the open points of the ADR.
      console.log('live video capabilities', JSON.stringify(capabilities))
      expect(capabilities.fps).toBe(family.fps)
      expect(capabilities.webmSupported).not.toBe(false)

      const { jobId } = await videoClient.generateVideo({
        prompt: 'a small red cube rotating slowly on a white table, studio lighting',
        width: family.width,
        height: family.height,
        frames,
        steps: family.steps,
        cfgScale: family.cfgScale,
        seed: 7,
      })
      const deadline = Date.now() + 30 * 60_000
      let done: VideoJob | null = null
      for (;;) {
        done = await videoClient.videoJob(jobId)
        if (done && ['completed', 'failed', 'cancelled'].includes(done.state)) break
        if (Date.now() > deadline) throw new Error(`video job ${jobId} is still ${done?.state ?? 'missing'}`)
        await sleep(500)
      }
      expect(done?.state, JSON.stringify(done?.error)).toBe('completed')
      const clip = done?.outputs[0] as VideoJob['outputs'][number]
      expect(clip.recipe.seed).toBe(7)
      const bytes = await readFile(clip.path)
      expect(isWebm(bytes)).toBe(true)
      expect(parseVideoRecipe(await readFile(clip.path.replace(/\.webm$/, '.json'), 'utf8'))).toEqual(
        clip.recipe
      )
      console.log(
        'live video result',
        JSON.stringify({
          frames,
          frameCount: clip.frameCount,
          fps: clip.fps,
          bytes: bytes.length,
          durationMs: clip.recipe.durationMs,
        })
      )
      const progress = videoEvents
        .filter((e) => e.name === 'diffusion:video-progress')
        .map((e) => (e.payload as CoreEvents['diffusion:video-progress']).progress)
      // The sampling bar the engine prints for vid_gen must be the one we parse.
      expect(
        progress.some((p) => p.phase === 'sampling' && p.totalSteps === family.steps && p.step >= 1)
      ).toBe(true)
      expect(progress.some((p) => p.phase === 'saving')).toBe(true)
      expect(videoEvents.filter((e) => e.name === 'diffusion:error')).toEqual([])

      // The OpenAI facade queues, polls and streams the same kind of clip.
      const served = await videoCore.startPublicServer({ port: 0 })
      const base = `http://127.0.0.1:${served.port}/v1`
      const queued = await fetch(`${base}/videos`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: 'a small blue sphere bouncing once',
          seconds: frames / family.fps,
          seed: 8,
        }),
      })
      expect(queued.status, await queued.clone().text()).toBe(200)
      const video = (await queued.json()) as { id: string; status: string }
      let polled: { status: string } = video
      while (polled.status === 'queued' || polled.status === 'in_progress') {
        if (Date.now() > deadline) throw new Error('the facade clip did not finish')
        await sleep(1_000)
        polled = (await (await fetch(`${base}/videos/${video.id}`)).json()) as { status: string }
      }
      expect(polled.status).toBe('completed')
      const content = await fetch(`${base}/videos/${video.id}/content`)
      expect(content.headers.get('content-type')).toBe('video/webm')
      expect(isWebm(Buffer.from(await content.arrayBuffer()))).toBe(true)
      expect((await videoClient.listVideoGallery({ offset: 0, limit: 10 })).total).toBe(2)

      // A hard cancel of a long clip stops the server unless the engine cancels natively; the next clip respawns it.
      const long = await videoClient.generateVideo({
        prompt: 'a long render',
        width: family.width,
        height: family.height,
        frames: frames + family.step * 4,
        steps: 50,
        cfgScale: family.cfgScale,
      })
      while ((await videoClient.videoJob(long.jobId))?.state !== 'generating') await sleep(500)
      await sleep(2_000)
      const cancelled = await videoClient.cancelVideoJob(long.jobId)
      expect(cancelled.cancelled).toBe(true)
      expect((await videoClient.videoJob(long.jobId))?.state).toBe('cancelled')
      const again = await videoClient.generateVideo({
        prompt: 'a small green cone',
        width: family.width,
        height: family.height,
        frames,
        steps: 2,
        cfgScale: family.cfgScale,
      })
      let respawned: VideoJob | null = null
      while (!respawned || !['completed', 'failed', 'cancelled'].includes(respawned.state)) {
        if (Date.now() > deadline) throw new Error('the respawned clip did not finish')
        await sleep(500)
        respawned = await videoClient.videoJob(again.jobId)
      }
      expect(respawned.state, JSON.stringify(respawned.error)).toBe('completed')
      const status = await videoClient.diffusionStatus()
      expect(status.model.state).toBe('loaded')
      await videoClient.unloadDiffusionModel()
      expect(isProcessAlive(status.model.loaded?.pid as number)).toBe(false)
    },
    60 * 60_000
  )
})
