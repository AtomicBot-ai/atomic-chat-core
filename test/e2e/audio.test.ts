/**
 * Audio generation through the compiled binary, against the fake `audiocpp_server`
 * (`test/helpers/fake-audiocpp-server.mjs`). The build tree is written straight into
 * `<data>/audio/backends/<tag>/<backendId>/` with its marker and record (the engine-builds install
 * is covered with the engine-build row). What is asserted is what a client sees and what the machine
 * is left with: the control routes in their shapes, the events over SSE, the WAV and its recipe in
 * the gallery, a cancel that stops the server and a crash, each followed by a job that brings it
 * back, the journal, the idle unload and the model files.
 *
 * No imports from `src/`: a packaging change that breaks a route cannot pass by type-checking.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'
import * as sd from '../helpers/compiled-diffusion.js'
import type { SdContext } from '../helpers/compiled-diffusion.js'
import {
  installFakeAudioEngine,
  writeFakeAudioLaunchers,
  writeFakeAudioModel,
} from '../helpers/fake-audiocpp-server.js'
import type { FakeAudioOptions } from '../helpers/fake-audiocpp-server.js'

const { BIN } = core
const { alive, control, journalled, json, waitFor } = sd

interface Job {
  id: string
  state: string
  mode: string
  progress: { phase: string; elapsedMs: number } | null
  output: {
    id: string
    path: string
    sampleRate: number
    channels: number
    audioMs: number
    recipe: { seed: number; text: string; mode: string; engine: { kind: string; tag: string } }
  } | null
  error?: { code: string; message: string; details?: string }
}

interface Status {
  install: { state: string; tag?: string }
  model: { state: string; loaded: { pid: number; modelId: string } | null; error?: { code: string } }
  activeJob: Job | null
  outputDir: string
  idleUnloadSecs: number
}

const SPEECH = {
  modelId: 'kokoro-82m:q8_0',
  displayName: 'Kokoro 82M',
  mode: 'speech',
  file: 'kokoro/kokoro-82m-q8_0.gguf',
  family: 'kokoro_tts',
  task: 'tts',
  startupTimeoutSecs: 30,
}
const MUSIC = {
  modelId: 'ace-step-1.5-turbo:q8_0',
  displayName: 'ACE-Step 1.5 Turbo',
  mode: 'music',
  file: 'ace/ace-step-1.5-turbo-q8_0.gguf',
  family: 'ace_step',
  task: 'gen',
  startupTimeoutSecs: 30,
}

let ctx: SdContext
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-audio-')
})
afterEach(() => sd.sdCleanup(ctx))

const status = async (ready: ReadyLine) => json<Status>(await control(ctx, ready, '/audio/status'))
const job = async (ready: ReadyLine, id: string) =>
  (await json<{ job: Job | null }>(await control(ctx, ready, `/audio/jobs/${id}`))).job
const submit = (ready: ReadyLine, mode: string, request: Record<string, unknown>) =>
  control(ctx, ready, '/audio/jobs', { method: 'POST', body: JSON.stringify({ mode, request }) })

async function runJob(ready: ReadyLine, mode: string, request: Record<string, unknown>): Promise<Job> {
  const started = await json<Job>(await submit(ready, mode, request))
  await waitFor(
    async () => ['completed', 'failed', 'cancelled'].includes((await job(ready, started.id))?.state ?? ''),
    `audio job ${started.id} to end`
  )
  return (await job(ready, started.id)) as Job
}

/** A core with a fake build installed and `model` loaded over the control API. */
async function loadedOwner(fake: FakeAudioOptions = {}, model: Record<string, unknown> = SPEECH) {
  await installFakeAudioEngine(ctx.dataFolder, { pidFile: ctx.pidFile, ...fake })
  await writeFakeAudioModel(ctx.dataFolder, model['file'] as string)
  const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
  const loaded = await json<{ pid: number; modelId: string }>(
    await control(ctx, ready, '/audio/model/load', { method: 'POST', body: JSON.stringify(model) })
  )
  expect(loaded.modelId).toBe(model['modelId'])
  expect(alive(loaded.pid)).toBe(true)
  return { ready, pid: loaded.pid }
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')(
  'audio generation on the compiled core',
  () => {
    it('waits for a loading audio server to stop before the owner exits', async () => {
      await installFakeAudioEngine(ctx.dataFolder, { pidFile: ctx.pidFile, loadMs: 30_000 })
      await writeFakeAudioModel(ctx.dataFolder)
      const { ready, child } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      const loading = control(ctx, ready, '/audio/model/load', {
        method: 'POST',
        body: JSON.stringify(SPEECH),
      }).then(
        () => undefined,
        () => undefined
      )
      await waitFor(() => existsSync(ctx.pidFile), 'the audio server to spawn')
      const pid = Number((await readFile(ctx.pidFile, 'utf8')).trim().split('\n')[0])
      expect(alive(pid)).toBe(true)
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.kill('SIGTERM')
      await exited
      await loading
      expect(alive(pid)).toBe(false)
      expect(journalled(ctx)).toEqual([])
    })

    it('refuses a load without an engine, then loads, speaks with events, fills the gallery and unloads', async () => {
      const { ready: bare } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      expect(await status(bare)).toMatchObject({
        install: { state: 'not-installed' },
        model: { state: 'unloaded', loaded: null },
        outputDir: join(ctx.dataFolder, 'audios'),
        idleUnloadSecs: 600,
      })
      await writeFakeAudioModel(ctx.dataFolder)
      const missing = await control(ctx, bare, '/audio/model/load', {
        method: 'POST',
        body: JSON.stringify(SPEECH),
      })
      expect(missing.status).toBe(404)
      expect(await missing.json()).toMatchObject({ error: { code: 'ENGINE_MISSING' } })
      for (const daemon of ctx.daemons.splice(0)) daemon.kill('SIGKILL')

      const bodyFile = join(ctx.dataFolder, 'body.json')
      const { ready, pid } = await loadedOwner({ bodyFile })
      expect(journalled(ctx)).toEqual([
        expect.objectContaining({ pid, provider: 'audio', model_id: 'kokoro-82m:q8_0' }),
      ])
      expect(await status(ready)).toMatchObject({
        install: { state: 'installed', tag: 'v0.9.3-a1b2c3d4' },
        model: { state: 'loaded', loaded: { pid, modelId: 'kokoro-82m:q8_0' } },
      })
      const capabilities = await json<{
        voices: string[]
        supportsVoiceRef: boolean
        params: Array<{ name: string }>
      }>(await control(ctx, ready, '/audio/capabilities'))
      expect(capabilities.voices).toEqual(['af_heart', 'am_adam'])
      expect(capabilities.supportsVoiceRef).toBe(false)
      expect(capabilities.params.map((p) => p.name)).toContain('speed')
      // The audio model is not a chat session.
      expect((await json<{ sessions: unknown[] }>(await control(ctx, ready, '/sessions'))).sessions).toEqual(
        []
      )

      const events = await sd.collectEvents(ctx, ready)
      const done = await runJob(ready, 'speech', { text: 'Hello there', voice: 'am_adam', seed: 11 })
      expect(done).toMatchObject({
        state: 'completed',
        mode: 'speech',
        progress: { phase: 'saving' },
        output: {
          sampleRate: 24000,
          channels: 1,
          audioMs: 250,
          recipe: { seed: 11, text: 'Hello there', mode: 'speech' },
        },
      })
      expect(JSON.parse(await readFile(bodyFile, 'utf8'))).toEqual({
        model: 'kokoro-82m:q8_0',
        input: 'Hello there',
        seed: 11,
        voice: 'am_adam',
      })
      const wav = await readFile(done.output?.path as string)
      expect(wav.toString('latin1', 0, 4)).toBe('RIFF')
      expect(done.output?.path).toBe(join(ctx.dataFolder, 'audios', `${done.id}.wav`))
      expect(existsSync(join(ctx.dataFolder, 'audios', `${done.id}.json`))).toBe(true)
      await waitFor(
        () => events.some((e) => e.event === 'audio:job' && (e.data['job'] as Job).state === 'completed'),
        'the completed job event'
      )
      const phases = events
        .filter((e) => e.event === 'audio:job')
        .map((e) => (e.data['job'] as Job).progress?.phase)
      expect(phases).toEqual(['queued', 'generating', 'saving', 'saving'])
      expect(events.some((e) => e.event === 'audio:error')).toBe(false)

      // A music job on a speech model is refused for its mode, an unknown option by the engine.
      const wrongMode = await submit(ready, 'music', { text: 'synthwave' })
      expect(wrongMode.status).toBe(409)
      expect(await wrongMode.json()).toMatchObject({ error: { code: 'UNSUPPORTED_MODE' } })
      const rejected = await runJob(ready, 'speech', { text: 'x', options: { bogus_key: 1 } })
      expect(rejected).toMatchObject({ state: 'failed', error: { code: 'REQUEST_REJECTED' } })
      expect(rejected.error?.details).toContain('unknown Kokoro TTS request option: bogus_key')
      expect(alive(pid)).toBe(true)
      await waitFor(() => events.some((e) => e.event === 'audio:error'), 'the error event')

      const page = await json<{ total: number; items: Array<{ id: string }> }>(
        await control(ctx, ready, '/audio/gallery?offset=0&limit=10')
      )
      expect(page.total).toBe(1)
      const deleted = await control(ctx, ready, `/audio/gallery/${done.id}`, { method: 'DELETE' })
      expect(deleted.status).toBe(200)
      expect(existsSync(done.output?.path as string)).toBe(false)
      expect((await json<{ total: number }>(await control(ctx, ready, '/audio/gallery'))).total).toBe(0)

      await json(await control(ctx, ready, '/audio/model/unload', { method: 'POST' }))
      expect(alive(pid)).toBe(false)
      expect(journalled(ctx)).toEqual([])
      expect((await status(ready)).model.state).toBe('unloaded')
      const unloaded = await submit(ready, 'speech', { text: 'x' })
      expect(unloaded.status).toBe(404)
      expect(await unloaded.json()).toMatchObject({ error: { code: 'MODEL_NOT_LOADED' } })
    }, 60_000)

    it('makes music as a task and stores the decoded clip', async () => {
      const { ready } = await loadedOwner({}, MUSIC)
      const done = await runJob(ready, 'music', {
        text: 'synthwave',
        lyrics: '[verse] la la',
        durationSec: 1,
        bpm: 120,
      })
      expect(done).toMatchObject({
        state: 'completed',
        output: { sampleRate: 44100, channels: 2, audioMs: 1000, recipe: { mode: 'music' } },
      })
      const recipe = JSON.parse(
        await readFile(join(ctx.dataFolder, 'audios', `${done.id}.json`), 'utf8')
      ) as Record<string, unknown>
      expect(recipe).toMatchObject({
        lyrics: '[verse] la la',
        bpm: 120,
        durationSec: 1,
        engine: { kind: 'audio-cpp' },
      })
    }, 60_000)

    it('stops the server under a cancelled job, and the next job brings it back', async () => {
      const { ready, pid } = await loadedOwner({ mode: 'slow', onceMarker: join(ctx.dataFolder, 'once') })
      const started = await json<Job>(await submit(ready, 'speech', { text: 'a very long speech' }))
      await waitFor(
        async () => (await job(ready, started.id))?.progress?.phase === 'generating',
        'the job to generate'
      )
      const busy = await submit(ready, 'speech', { text: 'another' })
      expect(busy.status).toBe(409)
      expect(await busy.json()).toMatchObject({ error: { code: 'JOB_BUSY', details: started.id } })
      const cancelled = await json<{ cancelled: boolean; serverStopped: boolean }>(
        await control(ctx, ready, `/audio/jobs/${started.id}/cancel`, { method: 'POST' })
      )
      expect(cancelled).toEqual({ cancelled: true, serverStopped: true })
      expect(alive(pid)).toBe(false)
      expect((await job(ready, started.id))?.state).toBe('cancelled')
      expect(journalled(ctx)).toEqual([])
      expect((await status(ready)).model.state).toBe('unloaded')

      const next = await runJob(ready, 'speech', { text: 'short' })
      expect(next.state).toBe('completed')
      const respawned = await status(ready)
      expect(respawned.model.state).toBe('loaded')
      expect(respawned.model.loaded?.pid).not.toBe(pid)
      expect(journalled(ctx)).toEqual([
        expect.objectContaining({ provider: 'audio', pid: respawned.model.loaded?.pid }),
      ])
    }, 60_000)

    it('reports a server that crashed mid-job, and the next job respawns it', async () => {
      const { ready, pid } = await loadedOwner({
        mode: 'crash-mid-job',
        onceMarker: join(ctx.dataFolder, 'once'),
      })
      const crashed = await runJob(ready, 'speech', { text: 'x' })
      expect(crashed).toMatchObject({ state: 'failed', error: { code: 'ENGINE_CRASHED' } })
      expect(crashed.error?.details).toContain('GGML_ASSERT')
      expect(alive(pid)).toBe(false)
      expect(await status(ready)).toMatchObject({
        model: { state: 'failed', error: { code: 'ENGINE_CRASHED' } },
      })
      const next = await runJob(ready, 'speech', { text: 'again' })
      expect(next.state).toBe('completed')
      expect((await status(ready)).model.loaded?.pid).not.toBe(pid)
    }, 60_000)

    it('reports a model that fails to load, and a server that is not ours', async () => {
      await installFakeAudioEngine(ctx.dataFolder, { pidFile: ctx.pidFile, mode: 'load-fail' })
      await writeFakeAudioModel(ctx.dataFolder)
      const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
      const failed = await control(ctx, ready, '/audio/model/load', {
        method: 'POST',
        body: JSON.stringify(SPEECH),
      })
      expect(failed.status).toBe(500)
      expect(await failed.json()).toMatchObject({ error: { code: 'MODEL_LOAD_FAILED' } })
      expect((await status(ready)).model).toMatchObject({
        state: 'failed',
        error: { code: 'MODEL_LOAD_FAILED' },
      })

      await writeFakeAudioLaunchers(
        join(ctx.dataFolder, 'audio', 'backends', 'v0.9.3-a1b2c3d4', 'fake-cpu'),
        {
          pidFile: ctx.pidFile,
          mode: 'foreign-listener',
        }
      )
      const foreign = await control(ctx, ready, '/audio/model/load', {
        method: 'POST',
        body: JSON.stringify(SPEECH),
      })
      expect(await foreign.json()).toMatchObject({
        error: { code: 'MODEL_LOAD_FAILED', message: "Another process answered on the audio server's port." },
      })
      expect(journalled(ctx)).toEqual([])
    }, 60_000)

    it("reaps a crashed owner's audiocpp_server on the next start", async () => {
      const { pid } = await loadedOwner()
      for (const daemon of ctx.daemons.splice(0)) daemon.kill('SIGKILL')
      expect(alive(pid)).toBe(true)
      await core.startDaemon(ctx.dataFolder, ctx.daemons)
      await waitFor(() => !alive(pid), 'the orphan to be reaped')
      expect(journalled(ctx)).toEqual([])
    }, 60_000)

    it('lists and deletes model files, never the loaded one, and moves the output folder', async () => {
      const { ready } = await loadedOwner()
      await writeFakeAudioModel(ctx.dataFolder, 'sfx/stable-audio-3-small-sfx-q8_0.gguf')
      const files = await json<{ files: Array<{ relativePath: string }> }>(
        await control(ctx, ready, '/audio/model-files')
      )
      expect(files.files.map((f) => f.relativePath)).toEqual([
        'kokoro/kokoro-82m-q8_0.gguf',
        'sfx/stable-audio-3-small-sfx-q8_0.gguf',
      ])
      const inUse = await control(ctx, ready, '/audio/model-files', {
        method: 'DELETE',
        body: JSON.stringify({ relativePath: 'kokoro/kokoro-82m-q8_0.gguf' }),
      })
      expect(inUse.status).toBe(409)
      expect(await inUse.json()).toMatchObject({ error: { code: 'BACKEND_IN_USE' } })
      await json(
        await control(ctx, ready, '/audio/model-files', {
          method: 'DELETE',
          body: JSON.stringify({ relativePath: 'sfx/stable-audio-3-small-sfx-q8_0.gguf' }),
        })
      )
      expect(existsSync(join(ctx.dataFolder, 'audio', 'models', 'sfx'))).toBe(false)
      const escape = await control(ctx, ready, '/audio/model-files', {
        method: 'DELETE',
        body: JSON.stringify({ relativePath: '../audios/x.wav' }),
      })
      expect(escape.status).toBe(400)

      const elsewhere = join(ctx.dataFolder, 'Music', 'Atomic')
      const moved = await json<Status>(
        await control(ctx, ready, '/audio/output-dir', {
          method: 'PUT',
          body: JSON.stringify({ path: elsewhere }),
        })
      )
      expect(moved.outputDir).toBe(elsewhere)
      const clip = await runJob(ready, 'speech', { text: 'here' })
      expect(clip.output?.path.startsWith(elsewhere)).toBe(true)
    }, 60_000)

    it('unloads an idle model after idleUnloadSecs, on the next tick', async () => {
      const { ready, pid } = await loadedOwner()
      const events = await sd.collectEvents(ctx, ready)
      const configured = await json<Status>(
        await control(ctx, ready, '/audio/config', {
          method: 'PUT',
          body: JSON.stringify({ idleUnloadSecs: 1 }),
        })
      )
      expect(configured.idleUnloadSecs).toBe(1)
      // The idle task looks every 30 s; a one-second allowance has expired by then. `unloading`
      // carries the same reason but comes before the server is stopped: wait for `unloaded`.
      const idleUnloaded = () =>
        events.some(
          (e) =>
            e.event === 'audio:state' &&
            e.data['reason'] === 'idle' &&
            (e.data['status'] as { model?: { state?: string } } | undefined)?.model?.state === 'unloaded'
        )
      await waitFor(idleUnloaded, 'the idle unload', 45_000)
      expect(alive(pid)).toBe(false)
      expect((await status(ready)).model.state).toBe('unloaded')
      expect(journalled(ctx)).toEqual([])
    }, 60_000)
  }
)
