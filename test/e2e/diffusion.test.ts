/**
 * Stage 7: image generation through the compiled binary, against the fake `sd-server`. What is
 * asserted is what the app sees and what the machine is left with: the control routes answer in
 * the app's shapes, the events arrive over SSE, the PNG and its thumbnail land in the gallery, the
 * OpenAI facade serves the same job, a cancel that the engine ignores stops the process and the next
 * job brings it back, an unload leaves no journal entry, and a crashed core's successor reaps the
 * orphan. Then the housekeeping the Images page does: the output folder moved, gallery items and
 * model files deleted, the 64 MiB body cap, and the idle unload.
 *
 * No imports from `src/`: a packaging change that breaks a route cannot pass by type-checking.
 */
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as sd from '../helpers/compiled-diffusion.js'
import type { Job, SdContext } from '../helpers/compiled-diffusion.js'
import * as core from '../helpers/compiled-core.js'

const { BIN } = core
const { alive, control, journalled, json, sdJob, waitFor } = sd

let ctx: SdContext
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-diffusion-')
})
afterEach(() => sd.sdCleanup(ctx))

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')(
  'image generation on the compiled core',
  () => {
    it('finalizes, loads, generates with events, fills the gallery and serves the OpenAI facade', async () => {
      const { ready, pid } = await sd.loadedOwner(ctx)
      expect(journalled(ctx)).toEqual([
        expect.objectContaining({ pid, provider: 'diffusion', model_id: 'z-image:q4_k_m' }),
      ])
      const status = await sd.sdStatus(ctx, ready)
      expect(status.model.state).toBe('loaded')
      expect(status.model.loaded?.pid).toBe(pid)
      expect(status.install.backendId).toBe('fake-cpu')
      const capabilities = await json<{ workflows: string[]; maxBatch: number }>(
        await control(ctx, ready, '/diffusion/capabilities')
      )
      expect(capabilities.maxBatch).toBe(4)
      expect(capabilities.workflows).toContain('inpaint')
      // The image model is not a chat session.
      expect((await json<{ sessions: unknown[] }>(await control(ctx, ready, '/sessions'))).sessions).toEqual(
        []
      )

      const events = await sd.collectEvents(ctx, ready)
      const { jobId } = await json<{ jobId: string }>(
        await control(ctx, ready, '/diffusion/jobs', {
          method: 'POST',
          body: JSON.stringify(sd.sdGenerateRequest({ batchSize: 2, seed: 7 })),
        })
      )
      const busy = await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(sd.sdGenerateRequest({ prompt: 'another' })),
      })
      expect(busy.status).toBe(409)
      expect(await busy.json()).toMatchObject({ error: { code: 'JOB_BUSY', details: jobId } })

      await waitFor(
        async () => (await sdJob(ctx, ready, jobId))?.state === 'completed',
        'the job to complete'
      )
      const done = (await sdJob(ctx, ready, jobId)) as Job
      expect(done.outputs).toHaveLength(2)
      expect(done.outputs.map((o) => o.recipe.seed)).toEqual([7, 8])
      expect(done.progress).toMatchObject({ phase: 'saving', totalSteps: 4 })
      for (const output of done.outputs) {
        expect(output.path.startsWith(join(ctx.dataFolder, 'images'))).toBe(true)
        expect(existsSync(output.path)).toBe(true)
        expect(output.thumbnailPath).not.toBeNull()
        expect(existsSync(output.thumbnailPath as string)).toBe(true)
        const png = await readFile(output.path)
        expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
        expect(png.indexOf('tEXtatomic\0{"jobId":"')).toBeGreaterThan(0)
        expect(png.indexOf('tEXtparameters\0a cat\n')).toBeGreaterThan(0)
      }
      await waitFor(
        () => events.some((e) => e.event === 'diffusion:job' && (e.data['job'] as Job).state === 'completed'),
        'the completed job event'
      )
      expect(events.some((e) => e.event === 'diffusion:progress')).toBe(true)
      expect(
        events.some(
          (e) =>
            e.event === 'diffusion:progress' && (e.data['progress'] as { phase: string }).phase === 'sampling'
        )
      ).toBe(true)
      expect(events.some((e) => e.event === 'diffusion:error')).toBe(false)

      const page = await json<{ total: number; items: Array<{ id: string; pinned: boolean }> }>(
        await control(ctx, ready, '/diffusion/gallery?offset=0&limit=10')
      )
      expect(page.total).toBe(2)
      const first = page.items[0] as { id: string }
      const flagged = await json<{ pinned: boolean }>(
        await control(ctx, ready, `/diffusion/gallery/${first.id}/flags`, {
          method: 'PATCH',
          body: JSON.stringify({ pinned: true }),
        })
      )
      expect(flagged.pinned).toBe(true)
      expect(JSON.parse(await readFile(join(ctx.dataFolder, 'images', '.flags.json'), 'utf8'))).toEqual({
        [first.id]: { pinned: true, archived: false },
      })
      const exported = join(ctx.dataFolder, 'exported.png')
      await json(
        await control(ctx, ready, `/diffusion/gallery/${first.id}/export`, {
          method: 'POST',
          body: JSON.stringify({ targetPath: exported }),
        })
      )
      expect(existsSync(exported)).toBe(true)

      // The OpenAI facade on the public listener runs the same job and answers with the bytes.
      const started = await json<{ port: number }>(
        await control(ctx, ready, '/server/start', { method: 'POST', body: JSON.stringify({ port: 0 }) })
      )
      const base = `http://127.0.0.1:${started.port}/v1`
      const models = await (await fetch(`${base}/models`)).json()
      expect(JSON.stringify(models)).not.toContain('z-image')
      const generated = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat', size: 'auto', n: 1, seed: 11, model: 'Z-Image Turbo' }),
      })
      expect(generated.status, await generated.clone().text()).toBe(200)
      const answer = (await generated.json()) as {
        data: Array<{ b64_json: string }>
        atomic: { seed: number; paths: string[] }
      }
      expect(Buffer.from(answer.data[0]?.b64_json ?? '', 'base64').subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47])
      )
      expect(answer.atomic.seed).toBe(11)
      expect(existsSync(answer.atomic.paths[0] as string)).toBe(true)
      const refused = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'a cat', model: 'gpt-image-1' }),
      })
      expect(refused.status).toBe(503)
      expect(await refused.json()).toMatchObject({ error: { code: 'model_not_loaded' } })

      // Unload: the process is gone and so is its journal entry.
      await json(await control(ctx, ready, '/diffusion/model/unload', { method: 'POST' }))
      expect(alive(pid)).toBe(false)
      expect(journalled(ctx)).toEqual([])
      expect((await sd.sdStatus(ctx, ready)).model.state).toBe('unloaded')
    }, 60_000)

    it('stops an engine that ignores a cancel, and the next job brings it back', async () => {
      const { ready, pid } = await sd.loadedOwner(ctx, { env: { FAKE_SD_STEP_MS: '400' } })
      const { jobId } = await json<{ jobId: string }>(
        await control(ctx, ready, '/diffusion/jobs', {
          method: 'POST',
          // Forty steps at 400 ms: well past the 5 s grace a cancel gets before the process is stopped.
          body: JSON.stringify(sd.sdGenerateRequest({ steps: 40 })),
        })
      )
      await waitFor(async () => (await sdJob(ctx, ready, jobId))?.state === 'generating', 'the job to start')
      const cancelled = await json<{ cancelled: boolean; serverStopped: boolean }>(
        await control(ctx, ready, `/diffusion/jobs/${jobId}/cancel`, { method: 'POST' })
      )
      // The default grace is 5 s; the fake never honours a cancel, so the process is stopped.
      expect(cancelled).toEqual({ cancelled: true, serverStopped: true })
      expect(alive(pid)).toBe(false)
      expect((await sdJob(ctx, ready, jobId))?.state).toBe('cancelled')
      expect(journalled(ctx)).toEqual([])
      expect((await sd.sdStatus(ctx, ready)).model.state).toBe('unloaded')

      const next = await sd.runJob(ctx, ready, { steps: 1 })
      expect(next.state).toBe('completed')
      const respawned = await sd.sdStatus(ctx, ready)
      expect(respawned.model.state).toBe('loaded')
      expect(respawned.model.loaded?.pid).not.toBe(pid)
      expect(journalled(ctx)).toEqual([
        expect.objectContaining({ provider: 'diffusion', pid: respawned.model.loaded?.pid }),
      ])
    }, 60_000)

    it("reaps a crashed owner's sd-server on the next start", async () => {
      const { pid } = await sd.loadedOwner(ctx)
      for (const daemon of ctx.daemons.splice(0)) daemon.kill('SIGKILL')
      expect(alive(pid)).toBe(true)
      const { ready: next } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      await waitFor(() => !alive(pid), 'the orphan to be reaped')
      expect(journalled(ctx)).toEqual([])
      // A new generation has forgotten the configuration: the app sends it again on `snapshot`.
      expect(await sd.sdStatus(ctx, next)).toMatchObject({ configured: false, model: { state: 'unloaded' } })
    }, 60_000)

    it('moves the output folder, deletes gallery items, and lists and deletes model files', async () => {
      const { ready, modelFile } = await sd.loadedOwner(ctx)
      const events = await sd.collectEvents(ctx, ready)
      const first = await sd.runJob(ctx, ready)
      expect(first.outputs[0]?.path.startsWith(join(ctx.dataFolder, 'images'))).toBe(true)

      // The output folder the user picks is created and takes the next picture.
      const elsewhere = join(ctx.dataFolder, 'Pictures', 'Atomic')
      const moved = await json<{ outputDir: string }>(
        await control(ctx, ready, '/diffusion/output-dir', {
          method: 'PUT',
          body: JSON.stringify({ path: elsewhere }),
        })
      )
      expect(moved.outputDir).toBe(elsewhere)
      expect(existsSync(elsewhere)).toBe(true)
      await waitFor(() => sd.stateReasons(events).includes('output-dir'), 'the output-dir state event')
      const second = await sd.runJob(ctx, ready)
      expect(second.outputs[0]?.path.startsWith(elsewhere)).toBe(true)
      expect(existsSync(second.outputs[0]?.path as string)).toBe(true)

      // Deleting takes the PNG and its thumbnail; a file the app did not write is never listed or touched.
      const foreign = join(elsewhere, 'holiday.png')
      await writeFile(foreign, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))
      const page = await json<{ total: number; items: Array<{ id: string; path: string }> }>(
        await control(ctx, ready, '/diffusion/gallery?offset=0&limit=10')
      )
      expect(page.total).toBe(1)
      expect(page.items.map((item) => item.path)).toEqual([second.outputs[0]?.path])
      await json(
        await control(ctx, ready, '/diffusion/gallery/delete', {
          method: 'POST',
          body: JSON.stringify({ ids: page.items.map((item) => item.id) }),
        })
      )
      expect(existsSync(second.outputs[0]?.path as string)).toBe(false)
      expect(existsSync(second.outputs[0]?.thumbnailPath as string)).toBe(false)
      expect(existsSync(foreign)).toBe(true)
      expect(
        (await json<{ total: number }>(await control(ctx, ready, '/diffusion/gallery?offset=0&limit=10')))
          .total
      ).toBe(0)
      expect(await readdir(elsewhere)).toEqual(['holiday.png'])
      // The first picture, in the old folder, is not part of the gallery any more but still on disk.
      expect(existsSync(first.outputs[0]?.path as string)).toBe(true)

      // Model files: listed with their relative path, protected while loaded, deletable after.
      const listed = await json<{ files: Array<{ path: string; relativePath: string; bytes: number }> }>(
        await control(ctx, ready, '/diffusion/model-files')
      )
      expect(listed.files).toEqual([
        { path: modelFile, relativePath: 'z-image/z-image-turbo-Q4_K_M.gguf', bytes: 9 },
      ])
      const inUse = await control(ctx, ready, '/diffusion/model-files/delete', {
        method: 'POST',
        body: JSON.stringify({ path: modelFile }),
      })
      expect(inUse.status).toBe(409)
      expect(await inUse.json()).toMatchObject({
        error: {
          code: 'BACKEND_IN_USE',
          message: 'That file belongs to the loaded image model. Unload it first.',
        },
      })
      expect(existsSync(modelFile)).toBe(true)
      await json(await control(ctx, ready, '/diffusion/model/unload', { method: 'POST' }))
      await json(
        await control(ctx, ready, '/diffusion/model-files/delete', {
          method: 'POST',
          body: JSON.stringify({ path: modelFile }),
        })
      )
      expect(existsSync(modelFile)).toBe(false)
      // The family folder it left empty is gone too; the models root stays.
      expect(existsSync(join(modelFile, '..'))).toBe(false)
      expect(existsSync(join(ctx.dataFolder, 'diffusion', 'models'))).toBe(true)
      expect(
        (await json<{ files: unknown[] }>(await control(ctx, ready, '/diffusion/model-files'))).files
      ).toEqual([])
    }, 60_000)

    it('refuses a generation body over 64 MiB and takes a large inline source below it', async () => {
      const { ready } = await sd.loadedOwner(ctx)
      const mib = 1024 * 1024
      // A source image sent inline: a PNG header, then padding, as base64.
      const source = (bytes: number) =>
        Buffer.concat([
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          Buffer.alloc(bytes - 8, 0x20),
        ]).toString('base64')
      const tooLarge = await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(
          sd.sdGenerateRequest({ workflow: 'transform', initImage: { base64: source(49 * mib) } })
        ),
      })
      expect(tooLarge.status).toBe(400)
      expect(await tooLarge.json()).toMatchObject({
        error: { code: 'INVALID_ARGUMENT', message: 'Request body is too large.' },
      })
      expect((await sd.sdStatus(ctx, ready)).activeJob).toBeNull()
      // Below the cap the body is read whole; the source itself is then judged by the validator.
      const large = await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(
          sd.sdGenerateRequest({ workflow: 'transform', initImage: { base64: source(40 * mib) } })
        ),
      })
      expect(large.status).not.toBe(413)
      const body = (await large.json()) as { jobId?: string; error?: { code: string; message: string } }
      expect(body.error?.code ?? 'accepted').not.toBe('INVALID_ARGUMENT')
      if (body.jobId)
        await json(await control(ctx, ready, `/diffusion/jobs/${body.jobId}/cancel`, { method: 'POST' }))
    }, 60_000)

    it('unloads an idle model after idleUnloadSecs, on the next tick', async () => {
      const { ready, pid } = await sd.loadedOwner(ctx, { config: { idleUnloadSecs: 1 } })
      expect((await sd.sdStatus(ctx, ready)).idleUnloadSecs).toBe(1)
      const events = await sd.collectEvents(ctx, ready)
      // The idle task looks every 30 s; a one-second allowance has expired by then.
      await waitFor(() => sd.stateReasons(events).includes('idle'), 'the idle unload', 45_000)
      expect(alive(pid)).toBe(false)
      expect(journalled(ctx)).toEqual([])
      const status = await sd.sdStatus(ctx, ready)
      expect(status.model.state).toBe('unloaded')
      expect(status.model.loaded).toBeNull()
      // Forgotten with the unload: the next job cannot respawn it, the page loads again.
      const noModel = await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(sd.sdGenerateRequest()),
      })
      expect(noModel.status).toBe(404)
    }, 60_000)
  }
)
