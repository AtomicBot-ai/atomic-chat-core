import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { AudioJob, CoreEvents } from '../contracts/index.js'
import { AsyncMutex } from '../diffusion/index.js'
import {
  fakeHandle,
  hangUntilAborted,
  sampleAudioSpec,
  sampleCapabilities,
  sampleWav,
  scriptedHttp,
} from '../../test/helpers/audio-fixtures.js'
import type { FakeHandle } from '../../test/helpers/audio-fixtures.js'
import { audioError } from './errors.js'
import { AudioGallery } from './gallery.js'
import { AudioTimeoutError } from './http.js'
import {
  cancelAudioJob,
  DEFAULT_AUDIO_JOB_TIMINGS,
  drawAudioSeed,
  finishAudioJob,
  readVoiceRefFile,
  resolveVoiceRef,
  runAudioJob,
  setJobPhase,
  startAudioJob,
  withoutInlineAudio,
} from './jobs.js'
import type { AudioJobDeps } from './jobs.js'
import { loadFromSpec, unloadSession } from './session.js'
import { AudioState } from './state.js'
import type { AudioServerSpec } from './types.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface World {
  dir: string
  deps: AudioJobDeps
  state: AudioState
  http: ReturnType<typeof scriptedHttp>
  handles: FakeHandle[]
  events: Array<{ name: string; payload: unknown }>
  /** Every `audio:job` event's state and phase, in order. */
  jobTrail: () => string[]
  /** Set to hold the next spawn until its signal aborts. */
  holdSpawn: { on: boolean }
}

async function world(spec: Partial<AudioServerSpec> = {}, loaded = true): Promise<World> {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-core-audio-jobs-'))
  dirs.push(dir)
  const layout = dataLayout(dir)
  const state = new AudioState(layout.audio)
  const events: World['events'] = []
  const handles: FakeHandle[] = []
  const http = scriptedHttp()
  const holdSpawn = { on: false }
  const deps: AudioJobDeps = {
    state,
    emit: <K extends keyof CoreEvents>(name: K, payload: CoreEvents[K]) =>
      void events.push({ name, payload }),
    log: () => {},
    platform: process.platform,
    now: Date.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 20))),
    spawn: async (s, signal) => {
      if (holdSpawn.on) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true })
        )
        throw audioError('CANCELLED', 'The audio model load was stopped.')
      }
      const handle = fakeHandle(s)
      handle.capabilities = sampleCapabilities(s)
      handles.push(handle)
      return handle
    },
    http,
    gallery: new AudioGallery(),
    loadLock: new AsyncMutex(),
    timings: { ...DEFAULT_AUDIO_JOB_TIMINGS, exitWaitMs: 30 },
    drawSeed: () => 99,
    readSource: readVoiceRefFile,
  }
  if (loaded) await loadFromSpec(deps, sampleAudioSpec({ binaryDir: join(dir, 'engine'), ...spec }), 'load')
  const jobTrail = () =>
    events
      .filter((e) => e.name === 'audio:job')
      .map((e) => {
        const job = (e.payload as { job: AudioJob }).job
        return `${job.state}/${job.progress?.phase ?? '-'}`
      })
  return { dir, deps, state, http, handles, events, jobTrail, holdSpawn }
}

const errorEvents = (w: World) => w.events.filter((e) => e.name === 'audio:error').map((e) => e.payload)

describe('a speech job', () => {
  it.each(['replace', 'unload', 'shutdown'] as const)(
    'refuses a reference voice read overtaken by %s before registering or sending a job',
    async (change) => {
      const w = await world()
      let finishRead!: (bytes: Buffer) => void
      w.deps.readSource = () => new Promise<Buffer>((resolve) => (finishRead = resolve))
      const starting = startAudioJob(w.deps, 'speech', {
        text: 'Hello',
        voiceRef: { path: '/reference.wav' },
      }).catch((error: unknown) => error)
      if (change === 'shutdown') w.state.closing = true
      else {
        await unloadSession(w.deps, 'unload')
        if (change === 'replace')
          await loadFromSpec(w.deps, sampleAudioSpec({ modelId: 'another-voice' }), 'load')
      }
      finishRead(sampleWav())
      expect(await starting).toMatchObject({ code: change === 'shutdown' ? 'AUDIO_UNAVAILABLE' : 'CANCELLED' })
      expect(w.state.activeJobId).toBeUndefined()
      expect(w.http.posts).toEqual([])
      expect(w.events.filter((event) => event.name === 'audio:job')).toEqual([])
    }
  )

  it('goes through its phases, sends the speech request, saves the clip and re-arms the idle timer', async () => {
    const w = await world()
    const { job, done } = await startAudioJob(w.deps, 'speech', {
      text: 'Hello',
      voice: 'af_heart',
      speed: 1.1,
    })
    expect(job).toMatchObject({ state: 'queued', mode: 'speech', modelId: 'kokoro-82m:q8_0', output: null })
    expect(w.state.activeJobId).toBe(job.id)
    const result = await done
    expect(result.ok).toBe(true)
    expect(w.http.posts).toEqual([
      {
        url: `http://127.0.0.1:3900/v1/audio/speech`,
        body: { model: 'kokoro-82m:q8_0', input: 'Hello', seed: 99, voice: 'af_heart', speed: 1.1 },
      },
    ])
    expect(w.jobTrail()).toEqual([
      'queued/queued',
      'generating/generating',
      'generating/saving',
      'completed/saving',
    ])
    const finished = w.state.job(job.id) as AudioJob
    expect(finished.output).toMatchObject({
      id: job.id,
      path: join(w.dir, 'audios', `${job.id}.wav`),
      sampleRate: 24000,
      channels: 1,
      audioMs: 250,
      recipe: { seed: 99, voice: 'af_heart', speed: 1.1, mode: 'speech', engine: { kind: 'audio-cpp' } },
    })
    expect(finished.startedAtMs).toBeGreaterThanOrEqual(finished.createdAtMs)
    expect(finished.finishedAtMs).toBeGreaterThanOrEqual(finished.startedAtMs as number)
    expect(w.state.activeJobId).toBeUndefined()
    expect(w.state.idleExpired()).toBe(false)
    expect(result.ok && result.outcome.wav.subarray(0, 4).toString('latin1')).toBe('RIFF')
    expect(errorEvents(w)).toEqual([])
  })

  it('keeps a seed it was given and draws one for a negative seed', async () => {
    const w = await world()
    await runAudioJob(w.deps, 'speech', { text: 'a', seed: 1234 })
    await runAudioJob(w.deps, 'speech', { text: 'b', seed: -1 })
    expect(w.http.posts.map((p) => p.body['seed'])).toEqual([1234, 99])
  })

  it('clones a voice from base64 or from a file, and keeps neither the bytes nor the instruction out of the recipe', async () => {
    const w = await world({ modelId: 'qwen', family: 'qwen3_tts' })
    const ref = sampleWav(16000, 1, 0.2)
    const outcome = await runAudioJob(w.deps, 'speech', {
      text: 'Привет',
      voiceRef: { base64: `data:audio/wav;base64,${ref.toString('base64')}` },
      referenceText: 'reference words',
      instruct: 'calm',
    })
    expect(w.http.posts[0]?.body).toMatchObject({
      voice_ref: { type: 'base64', data: ref.toString('base64') },
      reference_text: 'reference words',
      options: { instruct: 'calm' },
    })
    expect(outcome.job.request.voiceRef).toEqual({ base64: '' })
    expect(outcome.item.recipe).toMatchObject({
      voiceRef: true,
      instruct: 'calm',
      options: { instruct: 'calm' },
    })
    const file = join(w.dir, 'ref.wav')
    await writeFile(file, ref)
    const second = await runAudioJob(w.deps, 'speech', { text: 'x', voiceRef: { path: file } })
    expect(second.job.request.voiceRef).toEqual({ path: file })
    expect(w.http.posts[1]?.body['voice_ref']).toEqual({ type: 'base64', data: ref.toString('base64') })
  })
})

describe('a music or effects job', () => {
  it('runs as a task, decodes the base64 WAV and records the music fields', async () => {
    const w = await world({ mode: 'music', family: 'ace_step', task: 'gen', modelId: 'ace' })
    const outcome = await runAudioJob(w.deps, 'music', {
      text: 'synthwave',
      lyrics: '[verse] la',
      durationSec: 30,
      bpm: 120,
      options: { shift: 3 },
    })
    expect(w.http.posts[0]).toEqual({
      url: 'http://127.0.0.1:3900/v1/tasks/run',
      body: {
        model: 'ace',
        request: {
          text: 'synthwave',
          options: { shift: 3, seed: 99, duration_sec: 30, lyrics: '[verse] la', bpm: 120 },
        },
      },
    })
    expect(outcome.item).toMatchObject({ sampleRate: 44100, channels: 2, audioMs: 500 })
    expect(outcome.item.recipe).toMatchObject({
      lyrics: '[verse] la',
      bpm: 120,
      durationSec: 30,
      options: { shift: 3 },
    })
    expect(JSON.parse(await readFile(join(w.dir, 'audios', `${outcome.job.id}.json`), 'utf8'))).toEqual(
      outcome.item.recipe
    )
  })
})

describe('refusals before a job starts', () => {
  it('needs a loaded model of the same mode, some text, and no other job running', async () => {
    const empty = await world({}, false)
    await expect(startAudioJob(empty.deps, 'speech', { text: 'x' })).rejects.toMatchObject({
      code: 'MODEL_NOT_LOADED',
    })
    const w = await world()
    await expect(startAudioJob(w.deps, 'music', { text: 'x' })).rejects.toMatchObject({
      code: 'UNSUPPORTED_MODE',
      message: 'The loaded model makes speech, not music.',
    })
    await expect(startAudioJob(w.deps, 'speech', { text: '  ' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    w.http.reply.current = hangUntilAborted
    const { job } = await startAudioJob(w.deps, 'speech', { text: 'first' })
    await expect(startAudioJob(w.deps, 'speech', { text: 'second' })).rejects.toMatchObject({
      code: 'JOB_BUSY',
      details: job.id,
    })
    await cancelAudioJob(w.deps, job.id)
    w.state.closing = true
    await expect(startAudioJob(w.deps, 'speech', { text: 'x' })).rejects.toMatchObject({
      code: 'AUDIO_UNAVAILABLE',
    })
  })

  it('asks a clone-only voice model for a reference voice, and checks the reference', async () => {
    const w = await world({ modelId: 'qwen', family: 'qwen3_tts' })
    w.state.capabilities = sampleCapabilities(w.state.spec as AudioServerSpec, { requiresVoiceRef: true })
    await expect(startAudioJob(w.deps, 'speech', { text: 'x' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
    await expect(
      startAudioJob(w.deps, 'speech', {
        text: 'x',
        voiceRef: { base64: Buffer.from('not a wav').toString('base64') },
      })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'The reference voice is not a WAV file.' })
    await expect(
      startAudioJob(w.deps, 'speech', { text: 'x', voiceRef: { path: join(w.dir, 'missing.wav') } })
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', message: 'The reference voice file was not found.' })
    expect(w.state.activeJobId).toBeUndefined()
    expect(w.http.posts).toEqual([])
  })
})

describe('resolveVoiceRef and readVoiceRefFile', () => {
  it('refuses a reference over 5 MiB before it is decoded or read', async () => {
    const huge = 'A'.repeat(8 * 1024 * 1024)
    await expect(resolveVoiceRef({ base64: huge }, readVoiceRefFile)).rejects.toMatchObject({
      message: 'The reference voice is larger than 5 MiB.',
    })
    const dir = await mkdtemp(join(tmpdir(), 'atomic-core-audio-ref-'))
    dirs.push(dir)
    const big = join(dir, 'big.wav')
    await writeFile(big, Buffer.alloc(5 * 1024 * 1024 + 1))
    await expect(readVoiceRefFile(big, 5 * 1024 * 1024)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(readVoiceRefFile(dir, 10)).rejects.toMatchObject({
      message: 'The reference voice file was not found.',
    })
  })

  it('answers the WAV as canonical base64', async () => {
    const wav = sampleWav(8000, 1, 0.1)
    expect(await resolveVoiceRef({ base64: wav.toString('base64') }, readVoiceRefFile)).toBe(
      wav.toString('base64')
    )
    expect(await resolveVoiceRef({ path: '/x.wav' }, async () => wav)).toBe(wav.toString('base64'))
  })
})

describe('engine refusals and failures', () => {
  it('passes the engine words on as REQUEST_REJECTED, keeps the server, and says so in an error event', async () => {
    const w = await world()
    w.http.reply.current = async () => ({
      status: 500,
      contentType: 'application/json',
      body: Buffer.from('{"error":{"message":"unknown Kokoro voice id: nope","type":"server_error"}}'),
    })
    const { job, done } = await startAudioJob(w.deps, 'speech', { text: 'x', voice: 'nope' })
    expect(await done).toEqual({
      ok: false,
      error: {
        code: 'REQUEST_REJECTED',
        message: 'The audio engine refused the request.',
        details: 'unknown Kokoro voice id: nope',
      },
    })
    expect(w.state.job(job.id)?.state).toBe('failed')
    expect(errorEvents(w)).toEqual([
      {
        code: 'REQUEST_REJECTED',
        message: 'The audio engine refused the request.',
        details: 'unknown Kokoro voice id: nope',
        jobId: job.id,
      },
    ])
    expect(w.handles[0]?.terminated).toBe(0)
    expect(w.state.modelState).toBe('loaded')
  })

  it.each([
    [503, '{"error":{"message":"model is busy","type":"server_busy"}}', 'audio/json', 'JOB_BUSY'],
    [200, '{"not":"a wav"}', 'application/json', 'INVALID_OUTPUT'],
  ])('reads a %s answer as %s', async (status, text, contentType, code) => {
    const w = await world()
    w.http.reply.current = async () => ({ status, contentType, body: Buffer.from(text) })
    await expect(runAudioJob(w.deps, 'speech', { text: 'x' })).rejects.toMatchObject({ code })
  })

  it('reads a task answer without a WAV as INVALID_OUTPUT', async () => {
    const w = await world({ mode: 'effects', family: 'stable_audio', task: 'gen' })
    w.http.reply.current = async () => ({
      status: 200,
      contentType: 'application/json',
      body: Buffer.from(JSON.stringify({ audio: Buffer.from('nope').toString('base64') })),
    })
    await expect(runAudioJob(w.deps, 'effects', { text: 'door' })).rejects.toMatchObject({
      code: 'INVALID_OUTPUT',
    })
  })

  it('reports a server that died mid-job as a crash with its words, keeps the spec, and respawns for the next job', async () => {
    const w = await world()
    w.http.reply.current = async () => {
      w.handles[0]?.die({ code: 134, signal: null }, ['GGML_ASSERT(ggml_nelements(a) == ne0*ne1) failed'])
      throw new Error('socket hang up')
    }
    const { job, done } = await startAudioJob(w.deps, 'speech', { text: 'x' })
    const result = await done
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'ENGINE_CRASHED', details: 'GGML_ASSERT(ggml_nelements(a) == ne0*ne1) failed' },
    })
    expect(w.state.session).toBeUndefined()
    expect(w.state.spec).toBeDefined()
    expect(w.state.modelState).toBe('failed')
    expect(w.state.modelError?.code).toBe('ENGINE_CRASHED')
    expect(errorEvents(w)).toHaveLength(1)
    expect(w.state.job(job.id)?.state).toBe('failed')

    w.http.reply.current = undefined
    w.events.length = 0
    const outcome = await runAudioJob(w.deps, 'speech', { text: 'again' })
    expect(outcome.job.state).toBe('completed')
    expect(w.handles).toHaveLength(2)
    expect(w.jobTrail()).toEqual([
      'queued/queued',
      'queued/loading',
      'generating/generating',
      'generating/saving',
      'completed/saving',
    ])
    expect(w.state.modelState).toBe('loaded')
  })

  it('stops a server that dropped the connection without dying, and calls it a crash', async () => {
    const w = await world()
    w.http.reply.current = async () => {
      throw new Error('read ECONNRESET')
    }
    await expect(runAudioJob(w.deps, 'speech', { text: 'x' })).rejects.toMatchObject({
      code: 'ENGINE_CRASHED',
      message: 'The audio engine dropped the connection while generating.',
      details: 'read ECONNRESET',
    })
    expect(w.handles[0]?.terminated).toBe(1)
    expect(w.state.spec).toBeDefined()
  })

  it('stops the server once a generation outlives the ceiling', async () => {
    const w = await world()
    w.http.reply.current = async () => {
      throw new AudioTimeoutError(21_600_000)
    }
    await expect(runAudioJob(w.deps, 'speech', { text: 'x' })).rejects.toMatchObject({
      code: 'INTERNAL',
      message: 'Generation exceeded 6 hours and was stopped.',
    })
    expect(w.handles[0]?.terminated).toBe(1)
    expect(w.state.modelError?.code).toBe('INTERNAL')
  })

  it('reads an out-of-memory refusal as OUT_OF_MEMORY', async () => {
    const w = await world()
    w.http.reply.current = async () => ({
      status: 500,
      contentType: 'application/json',
      body: Buffer.from('{"error":{"message":"ggml_gallocr: failed to allocate Metal buffer"}}'),
    })
    await expect(runAudioJob(w.deps, 'speech', { text: 'x' })).rejects.toMatchObject({
      code: 'OUT_OF_MEMORY',
    })
  })

  it('fails a respawn when the model was unloaded meanwhile', async () => {
    const w = await world()
    await w.state.session?.server.terminate()
    w.state.session = undefined
    w.state.spec = undefined
    w.state.capabilities = sampleCapabilities(sampleAudioSpec())
    // The check at start sees no spec; force the respawn path by keeping one until the lock is held.
    w.state.spec = sampleAudioSpec()
    const release = await w.deps.loadLock.acquire()
    const started = await startAudioJob(w.deps, 'speech', { text: 'x' })
    w.state.spec = undefined
    release()
    expect(await started.done).toMatchObject({ ok: false, error: { code: 'MODEL_NOT_LOADED' } })
  })
})

describe('cancelAudioJob', () => {
  it('stops the server under a generating job, keeps the spec, and the next job brings it back', async () => {
    const w = await world()
    w.http.reply.current = hangUntilAborted
    const { job, done } = await startAudioJob(w.deps, 'speech', { text: 'long' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(w.state.job(job.id)?.progress?.phase).toBe('generating')
    expect(await cancelAudioJob(w.deps, job.id)).toEqual({ cancelled: true, serverStopped: true })
    expect(await done).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(w.state.job(job.id)?.state).toBe('cancelled')
    expect(w.handles[0]?.terminated).toBe(1)
    expect(w.state.session).toBeUndefined()
    expect(w.state.spec).toBeDefined()
    expect(w.state.modelState).toBe('unloaded')
    expect(errorEvents(w)).toEqual([])
    expect(w.state.activeJobId).toBeUndefined()

    w.http.reply.current = undefined
    expect((await runAudioJob(w.deps, 'speech', { text: 'next' })).job.state).toBe('completed')
    expect(w.handles).toHaveLength(2)
    expect(await cancelAudioJob(w.deps, job.id)).toEqual({ cancelled: true, serverStopped: false })
  })

  it('ends a job still waiting for its server without stopping anything', async () => {
    const w = await world()
    await w.state.session?.server.terminate()
    w.holdSpawn.on = true
    const { job, done } = await startAudioJob(w.deps, 'speech', { text: 'x' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(w.state.job(job.id)?.progress?.phase).toBe('loading')
    expect(await cancelAudioJob(w.deps, job.id)).toEqual({ cancelled: true, serverStopped: false })
    expect(await done).toMatchObject({ ok: false, error: { code: 'CANCELLED' } })
    expect(w.state.modelState).toBe('unloaded')
    expect(errorEvents(w)).toEqual([])
  })

  it('answers what a finished job became, and refuses an unknown id', async () => {
    const w = await world()
    const outcome = await runAudioJob(w.deps, 'speech', { text: 'x' })
    expect(await cancelAudioJob(w.deps, outcome.job.id)).toEqual({ cancelled: false, serverStopped: false })
    await expect(cancelAudioJob(w.deps, 'nope')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' })
  })
})

describe('job bookkeeping', () => {
  it('never moves a job out of a terminal state, and finishes it once', async () => {
    const w = await world()
    const outcome = await runAudioJob(w.deps, 'speech', { text: 'x' })
    const before = w.events.length
    setJobPhase(w.deps, outcome.job.id, 'generating')
    expect(
      finishAudioJob(w.deps, outcome.job.id, { ok: false, error: { code: 'INTERNAL', message: 'late' } })
    ).toBe(false)
    expect(w.events).toHaveLength(before)
    expect(w.state.job(outcome.job.id)?.state).toBe('completed')
    setJobPhase(w.deps, 'missing', 'saving')
    expect(finishAudioJob(w.deps, 'missing', { ok: false, error: { code: 'INTERNAL', message: 'x' } })).toBe(
      false
    )
  })

  it('blanks inline audio but keeps paths', () => {
    expect(withoutInlineAudio({ text: 'x', voiceRef: { base64: 'UklGRg==' } })).toEqual({
      text: 'x',
      voiceRef: { base64: '' },
    })
    expect(withoutInlineAudio({ text: 'x', voiceRef: { path: '/r.wav' } })).toEqual({
      text: 'x',
      voiceRef: { path: '/r.wav' },
    })
  })

  it('draws a seed audio.cpp takes', () => {
    for (let i = 0; i < 50; i++) {
      const seed = drawAudioSeed()
      expect(Number.isInteger(seed) && seed >= 0 && seed < 0x8000_0000).toBe(true)
    }
  })
})
