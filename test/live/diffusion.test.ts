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
 * The engine tree is copied into the temporary data folder (finalize refuses trees outside it); the
 * model files are read where they are. Nothing is written outside the temporary folder.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CoreClient } from '../../src/client/index.js'
import type { CoreEvents, ImageJob } from '../../src/contracts/index.js'
import { AtomicCore } from '../../src/core/index.js'
import { decodePng, readPngHeader } from '../../src/diffusion/index.js'
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
