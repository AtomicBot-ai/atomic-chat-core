/**
 * Which engine may serve which image model, through the compiled binary (app v2.0.42, stages
 * 7k–7l): Qwen Image 2.1 refused on build 849 and served once an 883 tree is finalized; the
 * Qwen3-VL projector handed to `sd-server` as `--llm_vision` and the reference workflows offered
 * only with it; an engine update unloading the resident model and the old tree removable only then;
 * Qwen-Image capped at one megapixel on a Metal engine and the M5 switch absent on other machines;
 * a missing file named on load; a load that fails, and one stopped by an unload, leaving nothing.
 *
 * No imports from `src/`. POSIX only: the fake engine is a shell launcher.
 */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext } from '../helpers/compiled-diffusion.js'
import * as core from '../helpers/compiled-core.js'

const { BIN } = core
const { alive, control, journalled, json, waitFor } = sd

let ctx: SdContext
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-diffusion-engine-')
})
afterEach(() => sd.sdCleanup(ctx))

const QWEN_2_1 = {
  modelId: 'qwen-image-2.1:q4_k',
  family: 'qwen-image-2.1',
  displayName: 'Qwen Image 2.1',
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')(
  'the image engine and the models it may serve',
  () => {
    it('blocks Qwen Image 2.1 on engine build 849 with ENGINE_UPDATE_REQUIRED, and loads it once an 883 tree of the same backend is finalized', async () => {
      const old = await sd.writeSdEngine(ctx, { tag: sd.OLD_TAG })
      const modelFile = await sd.writeSdFile(ctx, 'qwen-image-2.1/qwen-image-2.1-Q4_K_M.gguf')
      const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      await sd.configure(ctx, ready)
      await sd.finalizeEngine(ctx, ready, old, { tag: sd.OLD_TAG })
      const events = await sd.collectEvents(ctx, ready)

      const blocked = await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: modelFile }, QWEN_2_1)),
      })
      expect(blocked.status).toBe(409)
      expect(await blocked.json()).toMatchObject({
        error: {
          code: 'ENGINE_UPDATE_REQUIRED',
          message:
            'qwen-image-2.1 requires an image engine update. Update the engine, then retry loading the model.',
          details: `installed=${sd.OLD_TAG}; required=${sd.NEW_TAG} or newer`,
        },
      })
      // Refused before anything is spawned.
      expect(sd.startedPids(ctx.pidFile)).toEqual([])
      expect(journalled(ctx)).toEqual([])
      const status = await sd.sdStatus(ctx, ready)
      expect(status.model.state).toBe('failed')
      expect(status.model.error?.code).toBe('ENGINE_UPDATE_REQUIRED')
      expect(status.install.tag).toBe(sd.OLD_TAG)
      await waitFor(() => sd.stateReasons(events).includes('load-blocked'), 'the load-blocked state event')
      expect(events.some((e) => e.event === 'diffusion:error')).toBe(false)

      // The app's engine update: a newer tree of the same backend, finalized the ordinary way.
      const fresh = await sd.writeSdEngine(ctx, { tag: sd.NEW_TAG })
      await sd.finalizeEngine(ctx, ready, fresh, { tag: sd.NEW_TAG })
      const loaded = await json<{ pid: number; family: string }>(
        await control(ctx, ready, '/diffusion/model/load', {
          method: 'POST',
          body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: modelFile }, QWEN_2_1)),
        })
      )
      expect(loaded.family).toBe('qwen-image-2.1')
      expect(alive(loaded.pid)).toBe(true)
      const served = await sd.sdStatus(ctx, ready)
      expect(served.model.state).toBe('loaded')
      expect(served.install).toMatchObject({ tag: sd.NEW_TAG, dir: fresh })
      // Both trees are installed; the load picked the compatible one.
      const { backends } = await json<{ backends: Array<{ tag: string }> }>(
        await control(ctx, ready, '/diffusion/backends')
      )
      expect(backends.map((b) => b.tag).sort()).toEqual([sd.OLD_TAG, sd.NEW_TAG].sort())
    }, 60_000)

    it('passes the vision projector as --llm_vision right after --llm, and offers the reference workflows only with it', async () => {
      const argvFile = join(ctx.dataFolder, 'sd-argv.json')
      const llm = 'shared/Qwen--Qwen3-VL-4B/qwen3-vl-4b-Q8_0.gguf'
      const projector = 'shared/Qwen--Qwen3-VL-4B/mmproj-Q8_0.gguf'
      const { ready, modelFile } = await sd.loadedOwner(ctx, {
        tag: sd.NEW_TAG,
        env: { FAKE_SD_ARGV_FILE: argvFile },
        files: { llm: await sd.writeSdFile(ctx, llm), llmVision: await sd.writeSdFile(ctx, projector) },
        load: QWEN_2_1,
      })
      const argv = sd.sdArgv(argvFile)
      const llmAt = argv.indexOf('--llm')
      expect(llmAt).toBeGreaterThan(0)
      expect(argv[llmAt + 1]).toBe(join(ctx.dataFolder, 'diffusion', 'models', ...llm.split('/')))
      expect(argv[llmAt + 2]).toBe('--llm_vision')
      expect(argv[llmAt + 3]).toBe(join(ctx.dataFolder, 'diffusion', 'models', ...projector.split('/')))

      const withProjector = await json<{ workflows: string[] }>(
        await control(ctx, ready, '/diffusion/capabilities')
      )
      expect(withProjector.workflows).toEqual(['create', 'reference', 'edit'])

      // The projector belongs to the loaded model: not deletable while it is loaded.
      const projectorPath = join(ctx.dataFolder, 'diffusion', 'models', ...projector.split('/'))
      const refused = await control(ctx, ready, '/diffusion/model-files/delete', {
        method: 'POST',
        body: JSON.stringify({ path: projectorPath }),
      })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: { code: 'BACKEND_IN_USE' } })
      expect(existsSync(projectorPath)).toBe(true)

      // Loaded without the projector, the model only creates, and an edit says what is missing.
      await json(
        await control(ctx, ready, '/diffusion/model/load', {
          method: 'POST',
          body: JSON.stringify(
            sd.sdLoadRequest(
              {
                diffusionModel: modelFile,
                llm: join(ctx.dataFolder, 'diffusion', 'models', ...llm.split('/')),
              },
              QWEN_2_1
            )
          ),
        })
      )
      expect(sd.sdArgv(argvFile)).not.toContain('--llm_vision')
      const without = await json<{ workflows: string[] }>(
        await control(ctx, ready, '/diffusion/capabilities')
      )
      expect(without.workflows).toEqual(['create'])
      const edit = await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(
          sd.sdGenerateRequest({
            workflow: 'edit',
            initImage: { base64: Buffer.from('png').toString('base64') },
          })
        ),
      })
      expect(edit.status).toBe(404)
      expect(await edit.json()).toMatchObject({
        error: {
          code: 'SIDE_FILE_MISSING',
          message: 'Qwen Image 2.1 editing needs its Qwen3-VL vision projector.',
        },
      })
      expect((await sd.sdStatus(ctx, ready)).activeJob).toBeNull()
    }, 60_000)

    it('unloads a resident model when a newer engine is finalized, and only then lets the old tree be removed', async () => {
      const { ready, dir: old, pid } = await sd.loadedOwner(ctx, { tag: sd.OLD_TAG })
      const inUse = await control(ctx, ready, '/diffusion/backends/remove', {
        method: 'POST',
        body: JSON.stringify({ dir: old }),
      })
      expect(inUse.status).toBe(409)
      expect(await inUse.json()).toMatchObject({ error: { code: 'BACKEND_IN_USE' } })
      expect(existsSync(old)).toBe(true)

      const events = await sd.collectEvents(ctx, ready)
      const fresh = await sd.writeSdEngine(ctx, { tag: sd.NEW_TAG })
      await sd.finalizeEngine(ctx, ready, fresh, { tag: sd.NEW_TAG })
      await waitFor(
        () => sd.stateReasons(events).includes('engine-updated'),
        'the engine-updated state event'
      )
      await waitFor(() => !alive(pid), 'the old server to be gone')
      expect(journalled(ctx)).toEqual([])
      const updated = await sd.sdStatus(ctx, ready)
      expect(updated.model.state).toBe('unloaded')
      expect(updated.install).toMatchObject({ tag: sd.NEW_TAG })
      // The spec is gone with the unload: a job does not respawn the old binary.
      const noModel = await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(sd.sdGenerateRequest()),
      })
      expect(noModel.status).toBe(404)
      expect(await noModel.json()).toMatchObject({ error: { code: 'MODEL_NOT_LOADED' } })

      await json(
        await control(ctx, ready, '/diffusion/backends/remove', {
          method: 'POST',
          body: JSON.stringify({ dir: old }),
        })
      )
      expect(existsSync(old)).toBe(false)
      // The now-empty `<tag>` parent goes with it.
      expect(existsSync(join(old, '..'))).toBe(false)
      const { backends } = await json<{ backends: Array<{ tag: string; dir: string }> }>(
        await control(ctx, ready, '/diffusion/backends')
      )
      expect(backends).toEqual([expect.objectContaining({ tag: sd.NEW_TAG, dir: fresh })])

      // A tree the app did not install is not deleted, and nothing outside the backends root is touched.
      const foreign = join(ctx.dataFolder, 'diffusion', 'backends', 'x', 'y')
      await mkdir(foreign, { recursive: true })
      const unowned = await control(ctx, ready, '/diffusion/backends/remove', {
        method: 'POST',
        body: JSON.stringify({ dir: foreign }),
      })
      expect(unowned.status).toBe(400)
      expect(await unowned.json()).toMatchObject({
        error: {
          code: 'INVALID_REQUEST',
          message: 'Refusing to delete a directory Atomic Chat did not install.',
        },
      })
      expect(existsSync(foreign)).toBe(true)
      const outside = await control(ctx, ready, '/diffusion/backends/remove', {
        method: 'POST',
        body: JSON.stringify({ dir: join(ctx.dataFolder, 'diffusion', 'models') }),
      })
      expect(outside.status).toBe(400)
      expect(existsSync(join(ctx.dataFolder, 'diffusion', 'models'))).toBe(true)
    }, 60_000)

    it('refuses Qwen-Image past one megapixel on a Metal engine before anything runs', async () => {
      const envFile = join(ctx.dataFolder, 'sd-env.json')
      const { ready, pid } = await sd.loadedOwner(ctx, {
        backend: 'metal',
        env: { FAKE_SD_ENV_FILE: envFile },
        load: { modelId: 'qwen-image:q4_k', family: 'qwen-image', displayName: 'Qwen-Image' },
      })
      expect((await sd.sdStatus(ctx, ready)).install).toMatchObject({ backend: 'metal' })
      const events = await sd.collectEvents(ctx, ready)
      const tooBig = await control(ctx, ready, '/diffusion/jobs', {
        method: 'POST',
        body: JSON.stringify(sd.sdGenerateRequest({ width: 1280, height: 1024 })),
      })
      expect(tooBig.status).toBe(400)
      expect(await tooBig.json()).toMatchObject({
        error: {
          code: 'INVALID_DIMENSIONS',
          message: 'Qwen-Image is limited to about one megapixel on Apple GPUs. Choose a smaller resolution.',
          details: '1280x1024 exceeds the Metal-safe pixel budget',
        },
      })
      expect((await sd.sdStatus(ctx, ready)).activeJob).toBeNull()
      expect(events.some((e) => e.event === 'diffusion:job')).toBe(false)
      const fits = await sd.runJob(ctx, ready, { width: 1024, height: 1024 })
      expect(fits.state).toBe('completed')
      expect(fits.outputs[0]).toMatchObject({ width: 1024, height: 1024 })
      expect((await sd.sdStatus(ctx, ready)).model.loaded?.pid).toBe(pid)

      // The M5 Metal switch reaches the engine's environment only on an M5; this machine decides.
      const m5 = process.platform === 'darwin' && /\bM5\b/.test(cpus()[0]?.model ?? '')
      expect(JSON.parse(readFileSync(envFile, 'utf8'))).toEqual({
        GGML_METAL_TENSOR_DISABLE: m5 ? '1' : null,
      })
    }, 60_000)

    it('names the missing file on load: MODEL_MISSING for the transformer, SIDE_FILE_MISSING for a side file', async () => {
      const dir = await sd.writeSdEngine(ctx)
      const modelFile = await sd.writeSdFile(ctx)
      const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      await sd.configure(ctx, ready)
      await sd.finalizeEngine(ctx, ready, dir)
      const missingModel = join(ctx.dataFolder, 'diffusion', 'models', 'z-image', 'gone.gguf')
      const transformer = await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: missingModel })),
      })
      expect(transformer.status).toBe(404)
      expect(await transformer.json()).toMatchObject({
        error: {
          code: 'MODEL_MISSING',
          message: 'gone.gguf is missing. Download the model again.',
          details: `diffusionModel: ${missingModel}`,
        },
      })
      const missingVae = join(ctx.dataFolder, 'diffusion', 'models', 'shared', 'ae.safetensors')
      const side = await control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: modelFile, vae: missingVae })),
      })
      expect(side.status).toBe(404)
      expect(await side.json()).toMatchObject({
        error: {
          code: 'SIDE_FILE_MISSING',
          message: 'ae.safetensors is missing. Download the model again.',
          details: `vae: ${missingVae}`,
        },
      })
      // Checked before the engine is started.
      expect(sd.startedPids(ctx.pidFile)).toEqual([])
      expect((await sd.sdStatus(ctx, ready)).model.state).toBe('unloaded')
    }, 60_000)

    it('reports a load that fails: an early exit read as OUT_OF_MEMORY, a listener that is not sd-server as MODEL_LOAD_FAILED, and nothing left running', async () => {
      const dir = await sd.writeSdEngine(ctx, {
        env: {
          FAKE_SD_MODE: 'exit-early',
          FAKE_SD_STDERR: 'ggml_backend_cuda_buffer_type_alloc_buffer: cudaMalloc failed: out of memory\n',
        },
      })
      const modelFile = await sd.writeSdFile(ctx)
      const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      await sd.configure(ctx, ready)
      await sd.finalizeEngine(ctx, ready, dir)
      const events = await sd.collectEvents(ctx, ready)
      const load = () =>
        control(ctx, ready, '/diffusion/model/load', {
          method: 'POST',
          body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: modelFile })),
        })

      const oom = await load()
      expect(oom.status).toBe(500)
      const oomBody = (await oom.json()) as { error: { code: string; message: string; details: string } }
      expect(oomBody).toMatchObject({
        error: { code: 'OUT_OF_MEMORY', message: 'The image model ran out of memory while loading.' },
      })
      expect(oomBody.error.details).toContain('out of memory')
      const failed = await sd.sdStatus(ctx, ready)
      expect(failed.model.state).toBe('failed')
      expect(failed.model.error?.code).toBe('OUT_OF_MEMORY')

      // The launcher is read at every spawn: the same tree now answers like a stranger on the port.
      await sd.writeSdEngine(ctx, { env: { FAKE_SD_MODE: 'foreign' } })
      const foreign = await load()
      expect(foreign.status).toBe(500)
      expect(await foreign.json()).toMatchObject({
        error: { code: 'MODEL_LOAD_FAILED', message: "Another process answered on sd-server's port." },
      })
      await waitFor(
        () => sd.stateReasons(events).filter((reason) => reason === 'load-failed').length >= 2,
        'both load-failed state events'
      )
      expect(events.filter((e) => e.event === 'diffusion:error').map((e) => e.data['code'])).toEqual([
        'OUT_OF_MEMORY',
        'MODEL_LOAD_FAILED',
      ])
      const pids = sd.startedPids(ctx.pidFile)
      expect(pids).toHaveLength(2)
      await waitFor(() => pids.every((pid) => !alive(pid)), 'every failed engine to be gone')
      expect(journalled(ctx)).toEqual([])
      expect((await sd.sdStatus(ctx, ready)).model.state).toBe('failed')
    }, 60_000)

    it('stops a load when the model is unloaded meanwhile: CANCELLED, the child gone first', async () => {
      const dir = await sd.writeSdEngine(ctx, { env: { FAKE_SD_LOAD_MS: '20000' } })
      const modelFile = await sd.writeSdFile(ctx)
      const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      await sd.configure(ctx, ready)
      await sd.finalizeEngine(ctx, ready, dir)
      const pending = control(ctx, ready, '/diffusion/model/load', {
        method: 'POST',
        body: JSON.stringify(sd.sdLoadRequest({ diffusionModel: modelFile })),
      })
      await waitFor(() => sd.startedPids(ctx.pidFile).length === 1, 'the engine to be started')
      const [pid] = sd.startedPids(ctx.pidFile) as [number]
      expect((await sd.sdStatus(ctx, ready)).model.state).toBe('loading')
      await json(await control(ctx, ready, '/diffusion/model/unload', { method: 'POST' }))
      const cancelled = await pending
      expect(cancelled.status).toBe(409)
      expect(await cancelled.json()).toMatchObject({
        error: { code: 'CANCELLED', message: 'The image model load was stopped.' },
      })
      expect(alive(pid)).toBe(false)
      expect(journalled(ctx)).toEqual([])
      expect((await sd.sdStatus(ctx, ready)).model.state).toBe('unloaded')
    }, 60_000)
  }
)
