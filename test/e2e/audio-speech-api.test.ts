/**
 * `POST /v1/audio/speech` on the compiled binary's public listener, against the fake
 * `audiocpp_server`: OpenAI's error envelope before a model is loaded and with a model that makes
 * no speech, the loaded speech model's WAV (and its bare samples for `pcm`) with the same job,
 * events and gallery clip as the studio's, the engine's refusal passed on, a busy answer while the
 * studio speaks, and a job cancelled when the client hangs up. The request is reported as
 * `atomic-audio` and never with the words.
 *
 * No imports from `src/`. POSIX only: the fake engine is a shell launcher.
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
  FAKE_AUDIO_BACKEND_ID,
  FAKE_AUDIO_TAG,
  installFakeAudioEngine,
  writeFakeAudioLaunchers,
  writeFakeAudioModel,
} from '../helpers/fake-audiocpp-server.js'
import type { FakeAudioOptions } from '../helpers/fake-audiocpp-server.js'

const { BIN } = core
const { alive, control, json, waitFor } = sd

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

interface Job {
  id: string
  state: string
  progress: { phase: string } | null
}

interface Status {
  model: { state: string; loaded: { pid: number } | null }
  activeJob: Job | null
}

interface OpenAiError {
  error: { message: string; type: string; code: string | null; param: string | null }
}

let ctx: SdContext
beforeEach(async () => {
  ctx = await sd.sdContext('atomic-core-e2e-audio-speech-api-')
})
afterEach(() => sd.sdCleanup(ctx))

const status = async (ready: ReadyLine) => json<Status>(await control(ctx, ready, '/audio/status'))
const job = async (ready: ReadyLine, id: string) =>
  (await json<{ job: Job | null }>(await control(ctx, ready, `/audio/jobs/${id}`))).job
const load = async (ready: ReadyLine, model: Record<string, unknown>) =>
  json<{ pid: number }>(
    await control(ctx, ready, '/audio/model/load', { method: 'POST', body: JSON.stringify(model) })
  )

async function startServer(ready: ReadyLine): Promise<number> {
  return (
    await json<{ port: number }>(
      await control(ctx, ready, '/server/start', { method: 'POST', body: JSON.stringify({ port: 0 }) })
    )
  ).port
}

const speech = (port: number, body: unknown, init: RequestInit = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/audio/speech`, {
    method: 'POST',
    ...init,
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

/** A core with the fake engine installed, both model files on disk, and the public listener up. */
async function owner(fake: FakeAudioOptions = {}) {
  await installFakeAudioEngine(ctx.dataFolder, { pidFile: ctx.pidFile, ...fake })
  await writeFakeAudioModel(ctx.dataFolder, SPEECH.file)
  await writeFakeAudioModel(ctx.dataFolder, MUSIC.file)
  const { ready } = await core.startDaemon(ctx.dataFolder, ctx.daemons)
  return { ready, port: await startServer(ready) }
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('the speech facade', () => {
  it("answers in OpenAI's envelope: 400 before 503, 503 with nothing or a music model loaded", async () => {
    const { ready, port } = await owner()

    // The format is checked before the model: an `mp3` request is a 400 even with nothing loaded.
    const mp3 = await speech(port, { input: 'Hello', response_format: 'mp3' })
    expect(mp3.status).toBe(400)
    expect(await mp3.json()).toEqual({
      error: {
        message: "response_format 'mp3' is not supported by the local engine; use 'wav' or 'pcm'",
        type: 'invalid_request_error',
        param: 'response_format',
        code: null,
      },
    })
    const sse = await speech(port, { input: 'Hello', stream_format: 'sse' })
    expect(sse.status).toBe(400)
    expect(((await sse.json()) as OpenAiError).error.param).toBe('stream_format')
    const noInput = await speech(port, { voice: 'alloy' })
    expect(await noInput.json()).toMatchObject({ error: { param: 'input', message: 'input is required' } })
    const broken = await speech(port, '{"input": ')
    expect(broken.status).toBe(400)

    const nothing = await speech(port, { model: 'tts-1', input: 'Hello', voice: 'alloy' })
    expect(nothing.status).toBe(503)
    expect(await nothing.json()).toEqual({
      error: {
        message: 'No speech model loaded. Load a speech model in Atomic Chat first.',
        type: 'server_error',
        param: null,
        code: 'model_not_loaded',
      },
    })

    await load(ready, MUSIC)
    const music = await speech(port, { input: 'Hello' })
    expect(music.status).toBe(503)
    expect(await music.json()).toMatchObject({
      error: {
        code: 'model_not_loaded',
        message:
          'The loaded audio model (ACE-Step 1.5 Turbo) makes music, not speech. Load a speech model in Atomic Chat first.',
      },
    })
    // Nothing ran: the music model made no clip.
    expect((await json<{ total: number }>(await control(ctx, ready, '/audio/gallery'))).total).toBe(0)

    // Transcription is not served, and only POST speaks.
    const stt = await fetch(`http://127.0.0.1:${port}/v1/audio/transcriptions`, { method: 'POST' })
    expect(stt.status).toBe(404)
    const get = await fetch(`http://127.0.0.1:${port}/v1/audio/speech`)
    expect([get.status, get.headers.get('allow')]).toEqual([405, 'POST'])
  }, 60_000)

  it('speaks with the loaded model: its WAV, the same clip in the gallery, pcm as bare samples', async () => {
    const bodyFile = join(ctx.dataFolder, 'body.json')
    const { ready, port } = await owner({ bodyFile })
    await load(ready, SPEECH)
    const events = await sd.collectEvents(ctx, ready)

    const res = await speech(port, {
      model: 'Kokoro 82M',
      input: 'Private words',
      voice: 'am_adam',
      speed: 1.5,
      language: 'en',
      seed: 11,
      response_format: 'wav',
      stream_format: 'audio',
      unknown_field: true,
    })
    expect(res.status, await res.clone().text()).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    const wav = Buffer.from(await res.arrayBuffer())
    expect(wav.toString('latin1', 0, 4)).toBe('RIFF')
    expect(wav.readUInt32LE(24)).toBe(24000)
    const jobId = res.headers.get('x-atomic-job-id') as string
    expect({
      seed: res.headers.get('x-atomic-seed'),
      rate: res.headers.get('x-atomic-sample-rate'),
      channels: res.headers.get('x-atomic-channels'),
    }).toEqual({ seed: '11', rate: '24000', channels: '1' })
    expect(JSON.parse(await readFile(bodyFile, 'utf8'))).toEqual({
      model: 'kokoro-82m:q8_0',
      input: 'Private words',
      seed: 11,
      voice: 'am_adam',
      speed: 1.5,
      language: 'en',
    })

    // The same job the studio would have run: its record, its clip and recipe, its events.
    expect(await job(ready, jobId)).toMatchObject({ id: jobId, state: 'completed', mode: 'speech' })
    const clip = join(ctx.dataFolder, 'audios', `${jobId}.wav`)
    expect(await readFile(clip)).toEqual(wav)
    expect(JSON.parse(await readFile(join(ctx.dataFolder, 'audios', `${jobId}.json`), 'utf8'))).toMatchObject(
      {
        jobId,
        mode: 'speech',
        text: 'Private words',
        voice: 'am_adam',
        speed: 1.5,
        seed: 11,
        engine: { kind: 'audio-cpp', tag: FAKE_AUDIO_TAG },
      }
    )
    await waitFor(
      () =>
        events.some(
          (e) =>
            e.event === 'audio:job' &&
            (e.data['job'] as Job).id === jobId &&
            (e.data['job'] as Job).state === 'completed'
        ),
      'the completed job event'
    )

    // `pcm`: the samples alone, the WAV's 44-byte header gone.
    const pcm = await speech(port, { input: 'Private words', response_format: 'pcm', speed: 1 })
    expect(pcm.status).toBe(200)
    expect(pcm.headers.get('content-type')).toBe('audio/pcm')
    const samples = Buffer.from(await pcm.arrayBuffer())
    const pcmClip = await readFile(
      join(ctx.dataFolder, 'audios', `${pcm.headers.get('x-atomic-job-id')}.wav`)
    )
    expect(samples).toEqual(pcmClip.subarray(44))
    expect(samples.length).toBe(24000 * 0.25 * 2)
    // OpenAI's default speed is not sent: an absent one is the model's own pace.
    expect(JSON.parse(await readFile(bodyFile, 'utf8'))).not.toHaveProperty('speed')
    expect(
      (await json<{ total: number }>(await control(ctx, ready, '/audio/gallery?offset=0&limit=10'))).total
    ).toBe(2)

    // Another model's name is not found; the engine's own refusal is a 400 with its words.
    const other = await speech(port, { model: 'tts-1', input: 'Hello' })
    expect(other.status).toBe(404)
    expect(await other.json()).toMatchObject({ error: { code: 'model_not_found', param: 'model' } })
    const refused = await speech(port, { input: 'Hello', instructions: 'Calmly' })
    expect(refused.status).toBe(400)
    const refusal = ((await refused.json()) as OpenAiError).error
    expect(refusal).toMatchObject({ type: 'invalid_request_error', code: 'invalid_request' })
    expect(refusal.message).toContain('unknown Kokoro TTS request option: instruct')

    await waitFor(
      () => events.filter((e) => e.event === 'api:request' && e.data['phase'] === 'finished').length >= 4,
      'the finished request events'
    )
    const finished = events
      .filter((e) => e.event === 'api:request' && e.data['phase'] === 'finished')
      .map((e) => e.data['observation'] as Record<string, unknown>)
    expect(finished.map((o) => [o['endpoint'], o['status'], o['backend'], o['model_id']])).toEqual([
      ['audio/speech', 200, 'atomic-audio', 'kokoro-82m:q8_0'],
      ['audio/speech', 200, 'atomic-audio', 'kokoro-82m:q8_0'],
      ['audio/speech', 404, 'unknown', 'tts-1'],
      ['audio/speech', 400, 'atomic-audio', 'kokoro-82m:q8_0'],
    ])
    expect(JSON.stringify(events.filter((e) => e.event === 'api:request'))).not.toContain('Private words')
  }, 60_000)

  it('answers busy while the studio speaks, and cancels its own job when the client hangs up', async () => {
    const { ready, port } = await owner({ mode: 'slow' })
    const { pid } = await load(ready, SPEECH)

    const studio = await json<Job>(
      await control(ctx, ready, '/audio/jobs', {
        method: 'POST',
        body: JSON.stringify({ mode: 'speech', request: { text: 'A long speech' } }),
      })
    )
    await waitFor(
      async () => (await job(ready, studio.id))?.progress?.phase === 'generating',
      'the studio job'
    )
    const busy = await speech(port, { input: 'Hello' })
    expect(busy.status).toBe(429)
    expect(await busy.json()).toMatchObject({
      error: {
        type: 'server_error',
        code: 'busy',
        message: 'Another clip is being made. Wait for it, or stop it.',
      },
    })
    await json(await control(ctx, ready, `/audio/jobs/${studio.id}/cancel`, { method: 'POST' }))
    expect(alive(pid)).toBe(false)

    // The facade's job respawns the server; hanging up cancels it, which stops that server too.
    const client = new AbortController()
    const pending = speech(port, { input: 'Hello' }, { signal: client.signal }).catch((e: Error) => e.name)
    await waitFor(
      async () => (await status(ready)).activeJob?.progress?.phase === 'generating',
      'the facade job to generate'
    )
    const { activeJob, model } = await status(ready)
    const respawned = model.loaded?.pid as number
    expect(respawned).not.toBe(pid)
    client.abort()
    expect(await pending).toBe('AbortError')
    await waitFor(
      async () => (await job(ready, (activeJob as Job).id))?.state === 'cancelled',
      'the facade job to be cancelled'
    )
    await waitFor(() => !alive(respawned), 'the server under the cancelled job to stop')
    expect((await json<{ total: number }>(await control(ctx, ready, '/audio/gallery'))).total).toBe(0)

    // With the engine quick again, the next request brings the server back and speaks.
    await writeFakeAudioLaunchers(
      join(ctx.dataFolder, 'audio', 'backends', FAKE_AUDIO_TAG, FAKE_AUDIO_BACKEND_ID),
      { pidFile: ctx.pidFile }
    )
    const next = await speech(port, { input: 'Hello' })
    expect(next.status, await next.clone().text()).toBe(200)
    expect((await status(ready)).model.state).toBe('loaded')
  }, 60_000)
})
