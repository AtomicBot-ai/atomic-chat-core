/**
 * Stage 9: video generation through the compiled binary, against the fake `sd-server` in its
 * `vid_gen` mode. What is asserted is what the app sees and what the machine is left with: the
 * video model loads with its side files on the argv and the mode flag off by default, the job
 * reports on its own events and leaves a WebM with its recipe sidecar in `<data>/videos`, the app's
 * poster lands beside it, the video gallery answers, a cancel the engine ignores stops the process
 * and the next clip brings it back, a model of the wrong modality is refused at load and at
 * generate, and a build without WebM is refused before anything is submitted.
 *
 * No imports from `src/`. POSIX only: the fake engine is a shell launcher.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext, VideoJob } from '../helpers/compiled-diffusion.js'
import * as core from '../helpers/compiled-core.js'

const { BIN } = core
const { alive, control, journalled, json, sdVideoJob, waitFor } = sd

let ctx: SdContext
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-video-')
})
afterEach(() => sd.sdCleanup(ctx))

/** A PNG header with nothing behind it: enough for the poster check, which reads the header only. */
const POSTER = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0, 0, 0, 13]),
  Buffer.from('IHDR'),
  Buffer.from([0, 0, 0, 16, 0, 0, 0, 8, 8, 2, 0, 0, 0]),
  Buffer.alloc(4),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('IEND'),
  Buffer.from([0xae, 0x42, 0x60, 0x82]),
])

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')(
  'video generation on the compiled core',
  () => {
    it('loads a video model with its side files, generates on its own events, saves the clip with its sidecar, takes a poster and serves the video gallery', async () => {
      const argvFile = join(ctx.dataFolder, 'sd-argv.json')
      const audioVae = await sd.writeSdFile(ctx, 'shared/ltx/audio_vae.safetensors')
      const connectors = await sd.writeSdFile(ctx, 'shared/ltx/connectors.safetensors')
      const { ready, pid, modelFile } = await sd.loadedOwner(ctx, {
        video: true,
        tag: sd.NEW_TAG,
        env: { FAKE_SD_ARGV_FILE: argvFile },
        files: { audioVae, embeddingsConnectors: connectors },
      })
      expect(journalled(ctx)).toEqual([
        expect.objectContaining({ pid, provider: 'diffusion', model_id: 'ltx-2:q4_k_m' }),
      ])
      const argv = sd.sdArgv(argvFile)
      expect(argv[argv.indexOf('--audio-vae') + 1]).toBe(audioVae)
      expect(argv[argv.indexOf('--embeddings-connectors') + 1]).toBe(connectors)
      expect(argv).not.toContain('-M')
      const status = await sd.sdStatus(ctx, ready)
      expect(status.model.state).toBe('loaded')
      expect(status.videoOutputDir).toBe(join(ctx.dataFolder, 'videos'))
      expect(status.activeVideoJob).toBeNull()
      const capabilities = await json<{
        fps: number
        frames: { step: number; default: number }
        webmSupported: boolean
        workflows: string[]
      }>(await control(ctx, ready, '/diffusion/video/capabilities'))
      expect(capabilities).toMatchObject({
        fps: 24,
        frames: { step: 8, default: 9 },
        webmSupported: true,
        workflows: ['create'],
      })
      // The image capabilities are refused on a video model, in the app's code.
      const imageCaps = await control(ctx, ready, '/diffusion/capabilities')
      expect(imageCaps.status).toBe(400)
      expect(await imageCaps.json()).toMatchObject({ error: { code: 'MODEL_INCOMPATIBLE' } })

      const events = await sd.collectEvents(ctx, ready)
      const { jobId } = await json<{ jobId: string }>(
        await control(ctx, ready, '/diffusion/video/jobs', {
          method: 'POST',
          body: JSON.stringify(sd.sdVideoRequest({ seed: 7 })),
        })
      )
      expect((await sd.sdStatus(ctx, ready)).activeVideoJob?.id).toBe(jobId)
      // A second job of either kind is refused while it runs.
      const busy = await control(ctx, ready, '/diffusion/video/jobs', {
        method: 'POST',
        body: JSON.stringify(sd.sdVideoRequest()),
      })
      expect(busy.status).toBe(409)
      expect(await busy.json()).toMatchObject({
        error: { code: 'JOB_BUSY', message: 'A video is already being generated.', details: jobId },
      })
      const image = await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(sd.sdGenerateRequest()),
      })
      expect(image.status).toBe(400)
      expect(await image.json()).toMatchObject({ error: { code: 'MODEL_INCOMPATIBLE' } })

      await waitFor(
        async () => (await sdVideoJob(ctx, ready, jobId))?.state === 'completed',
        'the clip to complete'
      )
      const done = (await sdVideoJob(ctx, ready, jobId)) as VideoJob
      expect(done.outputs).toHaveLength(1)
      const [clip] = done.outputs
      expect(clip?.id).toBe(jobId)
      expect(clip?.path).toBe(join(ctx.dataFolder, 'videos', `${jobId}.webm`))
      expect(clip?.posterPath).toBeNull()
      expect([clip?.fps, clip?.frameCount, clip?.recipe.seed, clip?.recipe.frames]).toEqual([24, 9, 7, 9])
      expect((await readFile(clip?.path as string)).equals(await readFile(sd.WEBM_FIXTURE))).toBe(true)
      const sidecar = JSON.parse(await readFile(join(ctx.dataFolder, 'videos', `${jobId}.json`), 'utf8')) as {
        jobId: string
        seed: number
        outputFormat: string
      }
      expect(sidecar).toMatchObject({ jobId, seed: 7, outputFormat: 'webm' })
      expect(done.progress).toMatchObject({ phase: 'saving', totalSteps: 4 })
      // The image job lookup does not know it.
      expect(
        (await json<{ job: unknown }>(await control(ctx, ready, `/diffusion/jobs/${jobId}`))).job
      ).toBeNull()
      await waitFor(
        () =>
          events.some(
            (e) => e.event === 'diffusion:video-job' && (e.data['job'] as VideoJob).state === 'completed'
          ),
        'the completed video job event'
      )
      expect(
        events.some(
          (e) =>
            e.event === 'diffusion:video-progress' &&
            (e.data['progress'] as { phase: string }).phase === 'sampling'
        )
      ).toBe(true)
      expect(events.some((e) => e.event === 'diffusion:job' || e.event === 'diffusion:progress')).toBe(false)
      expect(events.some((e) => e.event === 'diffusion:error')).toBe(false)

      // The app renders the first frame and uploads it as the poster.
      const withPoster = await json<{ posterPath: string | null }>(
        await control(ctx, ready, `/diffusion/video/gallery/${jobId}/poster`, {
          method: 'PUT',
          body: JSON.stringify({ png: `data:image/png;base64,${POSTER.toString('base64')}` }),
        })
      )
      expect(withPoster.posterPath).toBe(join(ctx.dataFolder, 'videos', `${jobId}.thumb.png`))
      expect((await readFile(withPoster.posterPath as string)).equals(POSTER)).toBe(true)
      const notPng = await control(ctx, ready, `/diffusion/video/gallery/${jobId}/poster`, {
        method: 'PUT',
        body: JSON.stringify({ png: Buffer.from('not a png').toString('base64') }),
      })
      expect(notPng.status).toBe(400)
      expect(await notPng.json()).toMatchObject({
        error: { code: 'INVALID_REQUEST', message: 'The poster is not a PNG.' },
      })

      const page = await json<{ total: number; items: Array<{ id: string; posterPath: string | null }> }>(
        await control(ctx, ready, '/diffusion/video/gallery?offset=0&limit=10')
      )
      expect(page.total).toBe(1)
      expect(page.items[0]?.posterPath).toBe(withPoster.posterPath)
      const flagged = await json<{ pinned: boolean }>(
        await control(ctx, ready, `/diffusion/video/gallery/${jobId}/flags`, {
          method: 'PATCH',
          body: JSON.stringify({ pinned: true }),
        })
      )
      expect(flagged.pinned).toBe(true)
      expect(JSON.parse(await readFile(join(ctx.dataFolder, 'videos', '.flags.json'), 'utf8'))).toEqual({
        [jobId]: { pinned: true, archived: false },
      })
      const exported = join(ctx.dataFolder, 'exported.webm')
      await json(
        await control(ctx, ready, `/diffusion/video/gallery/${jobId}/export`, {
          method: 'POST',
          body: JSON.stringify({ targetPath: exported }),
        })
      )
      expect((await readFile(exported)).equals(await readFile(sd.WEBM_FIXTURE))).toBe(true)
      await json(
        await control(ctx, ready, '/diffusion/video/gallery/delete', {
          method: 'POST',
          body: JSON.stringify({ ids: [jobId] }),
        })
      )
      // The clip, its sidecar and its poster are gone; the flags file stays, rewritten without the entry.
      expect(await readdir(join(ctx.dataFolder, 'videos'))).toEqual(['.flags.json'])
      expect(
        (
          await json<{ total: number }>(
            await control(ctx, ready, '/diffusion/video/gallery?offset=0&limit=10')
          )
        ).total
      ).toBe(0)

      // The model files are the video model's.
      const inUse = await control(ctx, ready, '/diffusion/model-files/delete', {
        method: 'POST',
        body: JSON.stringify({ path: audioVae }),
      })
      expect(inUse.status).toBe(409)
      expect(await inUse.json()).toMatchObject({
        error: { message: 'That file belongs to the loaded video model. Unload it first.' },
      })
      await json(await control(ctx, ready, '/diffusion/model/unload', { method: 'POST' }))
      expect(alive(pid)).toBe(false)
      expect(journalled(ctx)).toEqual([])
      expect(existsSync(modelFile)).toBe(true)
    }, 60_000)

    it('emits -M vid_gen only when the environment opts in, and honours a video output folder of its own', async () => {
      const argvFile = join(ctx.dataFolder, 'sd-argv.json')
      const clips = join(ctx.dataFolder, 'Movies', 'Atomic')
      const { ready } = await sd.loadedOwner(ctx, {
        video: true,
        env: { FAKE_SD_ARGV_FILE: argvFile },
        daemonEnv: { ATOMIC_DIFFUSION_VID_GEN_MODE_FLAG: '1' },
        config: { videoOutputDir: clips },
      })
      const argv = sd.sdArgv(argvFile)
      expect(argv[argv.indexOf('-M') + 1]).toBe('vid_gen')
      expect(argv.indexOf('-M')).toBeLessThan(argv.indexOf('-v'))
      expect((await sd.sdStatus(ctx, ready)).videoOutputDir).toBe(clips)
      expect((await sd.sdStatus(ctx, ready)).outputDir).toBe(join(ctx.dataFolder, 'images'))
      const clip = await sd.runVideoJob(ctx, ready)
      expect(clip.state).toBe('completed')
      expect(clip.outputs[0]?.path.startsWith(clips)).toBe(true)
      expect(existsSync(join(clips, `${clip.id}.json`))).toBe(true)
    }, 60_000)

    it('stops an engine that ignores a cancel, and the next clip brings it back; a cancel the engine honours keeps it', async () => {
      const { ready, pid } = await sd.loadedOwner(ctx, { video: true, env: { FAKE_SD_STEP_MS: '400' } })
      const { jobId } = await json<{ jobId: string }>(
        await control(ctx, ready, '/diffusion/video/jobs', {
          method: 'POST',
          body: JSON.stringify(sd.sdVideoRequest({ steps: 40 })),
        })
      )
      await waitFor(
        async () => (await sdVideoJob(ctx, ready, jobId))?.state === 'generating',
        'the clip to start'
      )
      const cancelled = await json<{ cancelled: boolean; serverStopped: boolean }>(
        await control(ctx, ready, `/diffusion/video/jobs/${jobId}/cancel`, { method: 'POST' })
      )
      expect(cancelled).toEqual({ cancelled: true, serverStopped: true })
      expect(alive(pid)).toBe(false)
      expect((await sdVideoJob(ctx, ready, jobId))?.state).toBe('cancelled')
      expect(journalled(ctx)).toEqual([])
      expect(await readdir(join(ctx.dataFolder, 'videos')).catch(() => [])).toEqual([])
      // The image cancel route knows every job; a cancelled one answers as already over.
      const again = await control(ctx, ready, `/diffusion/jobs/${jobId}/cancel`, { method: 'POST' })
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual({ cancelled: true, serverStopped: false })

      const next = await sd.runVideoJob(ctx, ready, { steps: 1 })
      expect(next.state).toBe('completed')
      const respawned = await sd.sdStatus(ctx, ready)
      expect(respawned.model.state).toBe('loaded')
      expect(respawned.model.loaded?.pid).not.toBe(pid)
    }, 60_000)

    it('refuses a video model on an engine that serves images only, and an image model on one that serves video only', async () => {
      const dir = await sd.writeSdEngine(ctx, { env: { FAKE_SD_MODES: 'img_gen' } })
      const modelFile = await sd.writeSdFile(ctx, 'ltx-2/ltx.gguf')
      const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      await sd.configure(ctx, ready)
      await sd.finalizeEngine(ctx, ready, dir)
      const events = await sd.collectEvents(ctx, ready)
      const refused = await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(sd.sdVideoLoadRequest({ diffusionModel: modelFile })),
      })
      expect(refused.status).toBe(400)
      expect(await refused.json()).toMatchObject({
        error: {
          code: 'MODEL_INCOMPATIBLE',
          message: 'This model is not a video model.',
          details: 'supported_modes=img_gen; wanted vid_gen',
        },
      })
      const [pid] = sd.startedPids(ctx.pidFile)
      expect(pid).toBeDefined()
      expect(alive(pid as number)).toBe(false)
      expect(journalled(ctx)).toEqual([])
      await waitFor(() => sd.stateReasons(events).includes('load-failed'), 'the load-failed state event')
      expect((await sd.sdStatus(ctx, ready)).model).toMatchObject({
        state: 'failed',
        error: { code: 'MODEL_INCOMPATIBLE' },
      })

      // The other way round: an image model file on a video-only engine.
      await sd.writeSdEngine(ctx, { env: { FAKE_SD_MODES: 'vid_gen' } })
      const image = await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: await sd.writeSdFile(ctx) })),
      })
      expect(image.status).toBe(400)
      expect(await image.json()).toMatchObject({ error: { message: 'This model is not an image model.' } })

      // A missing side file is named before anything is spawned.
      const before = sd.startedPids(ctx.pidFile).length
      const missing = await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(
          sd.sdVideoLoadRequest({
            diffusionModel: modelFile,
            audioVae: join(ctx.dataFolder, 'nope', 'audio_vae.safetensors'),
          })
        ),
      })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({
        error: {
          code: 'SIDE_FILE_MISSING',
          message: 'audio_vae.safetensors is missing. Download the model again.',
        },
      })
      expect(sd.startedPids(ctx.pidFile)).toHaveLength(before)
    }, 60_000)

    it("refuses a build without WebM before submitting, and reports one that does not say as the engine's own 400", async () => {
      const { ready, pid } = await sd.loadedOwner(ctx, {
        video: true,
        env: { FAKE_SD_VID_FORMATS: 'no-webm' },
      })
      expect(
        (await json<{ webmSupported: boolean }>(await control(ctx, ready, '/diffusion/video/capabilities')))
          .webmSupported
      ).toBe(false)
      const refused = await sd.runVideoJob(ctx, ready)
      expect(refused.state).toBe('failed')
      expect(refused.error).toMatchObject({
        code: 'UNSUPPORTED_BACKEND',
        message: 'This engine build was made without WebM support.',
      })
      expect(alive(pid), 'the engine is left running').toBe(true)

      // A build that lists no formats is given the request; its own refusal comes back as INVALID_REQUEST.
      await json(await control(ctx, ready, '/diffusion/model/unload', { method: 'POST' }))
      await sd.writeSdEngine(ctx, { env: { FAKE_SD_MODES: 'vid_gen', FAKE_SD_VID_FORMATS: 'unreported' } })
      // The fake refuses webm only in its `no-webm` mode; `unreported` accepts it, so the clip completes.
      await json(
        await control(ctx, ready, '/diffusion/model/load', {
          method: 'POST',
          body: JSON.stringify(
            sd.sdVideoLoadRequest({ diffusionModel: await sd.writeSdFile(ctx, 'ltx-2/ltx.gguf') })
          ),
        })
      )
      expect(
        (
          await json<{ webmSupported: boolean | null }>(
            await control(ctx, ready, '/diffusion/video/capabilities')
          )
        ).webmSupported
      ).toBeNull()
      expect((await sd.runVideoJob(ctx, ready)).state).toBe('completed')
    }, 60_000)
  }
)
