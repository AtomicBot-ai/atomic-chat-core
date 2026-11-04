import { afterEach, describe, expect, it } from 'vitest'
import type {
  AudioGalleryItem,
  AudioGenerateRequest,
  AudioJob,
  AudioMode,
  CoreEvents,
} from '../../contracts/index.js'
import { AtomicCoreError } from '../../contracts/index.js'
import { closeAll, postJson, startPublic } from '../../../test/helpers/public-server.js'
import {
  AUDIO_BACKEND_LABEL,
  NO_SPEECH_MODEL_MESSAGE,
  serveAudioSpeech,
  SPEECH_TIMEOUT_MS,
} from './audio-speech.js'
import type { AudioSpeechBackend } from './types.js'

afterEach(closeAll)

type Done = Awaited<ReturnType<AudioSpeechBackend['start']>>['done']

interface FakeSpeech extends AudioSpeechBackend {
  requests: AudioGenerateRequest[]
  cancelled: string[]
  /** What the next job settles with; a function can hold the job open. */
  next: () => Done
  mode: AudioMode | undefined
}

const SAMPLES = Buffer.from([1, 0, 2, 0, 3, 0, 4, 0])

/** A 16-bit mono WAV at 24 kHz holding `SAMPLES`. */
function wav(samples = SAMPLES, bits = 16): Buffer {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(36 + samples.length, 4)
  head.write('WAVE', 8, 'latin1')
  head.write('fmt ', 12, 'latin1')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(bits === 32 ? 3 : 1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(24000, 24)
  head.writeUInt32LE((24000 * bits) / 8, 28)
  head.writeUInt16LE(bits / 8, 32)
  head.writeUInt16LE(bits, 34)
  head.write('data', 36, 'latin1')
  head.writeUInt32LE(samples.length, 40)
  return Buffer.concat([head, samples])
}

function item(): AudioGalleryItem {
  return {
    id: 'job-9',
    path: '/audios/job-9.wav',
    sampleRate: 24000,
    channels: 1,
    audioMs: 0,
    sizeBytes: 52,
    createdAtMs: 1,
    recipe: {
      jobId: 'job-9',
      mode: 'speech',
      text: 'Hello',
      voice: null,
      voiceRef: false,
      speed: null,
      language: null,
      instruct: null,
      lyrics: null,
      durationSec: null,
      bpm: null,
      seed: 42,
      steps: null,
      negativePrompt: null,
      options: {},
      model: {
        modelId: 'kokoro-82m:q8_0',
        family: 'kokoro_tts',
        task: 'tts',
        displayName: 'Kokoro 82M',
        filename: 'kokoro-82m-q8_0.gguf',
      },
      engine: { kind: 'audio-cpp', backend: 'metal', tag: 'v0.9.3-a1b2c3d4' },
      createdAtMs: 1,
      durationMs: 2,
    },
  }
}

function job(): AudioJob {
  return {
    id: 'job-9',
    state: 'completed',
    mode: 'speech',
    modelId: 'kokoro-82m:q8_0',
    request: { text: 'Hello' },
    createdAtMs: 1,
    progress: { phase: 'saving', elapsedMs: 2 },
    output: item(),
  }
}

function fakeSpeech(clip = wav()): FakeSpeech {
  const fake: FakeSpeech = {
    requests: [],
    cancelled: [],
    mode: 'speech',
    next: () => Promise.resolve({ ok: true, outcome: { job: job(), item: item(), wav: clip } }),
    loaded: () =>
      fake.mode ? { modelId: 'kokoro-82m:q8_0', displayName: 'Kokoro 82M', mode: fake.mode } : undefined,
    start: async (request) => {
      fake.requests.push(request)
      return { id: 'job-9', done: fake.next() }
    },
    cancel: async (id) => {
      fake.cancelled.push(id)
    },
  }
  return fake
}

async function server(speech?: AudioSpeechBackend) {
  const events: CoreEvents['api:request'][] = []
  const started = await startPublic({
    ...(speech ? { speech } : {}),
    emit: (name, payload) => {
      if (name === 'api:request') events.push(payload as CoreEvents['api:request'])
    },
    inspecting: () => false,
  })
  const finished = async (count: number) => {
    await expect.poll(() => events.filter((e) => e.phase === 'finished').length).toBeGreaterThanOrEqual(count)
    return events.flatMap((e) => (e.phase === 'finished' && e.observation ? [e.observation] : []))
  }
  return { started, finished }
}

const errorOf = async (res: Response) => ((await res.json()) as { error: Record<string, unknown> }).error

describe('POST /v1/audio/speech', () => {
  it('answers 503 without a speech model, and 400 for a bad body before that', async () => {
    const { started, finished } = await server()
    const none = await postJson(started, '/audio/speech', { input: 'Hello', voice: 'alloy' })
    expect(none.status).toBe(503)
    expect(none.headers.get('content-type')).toBe('application/json')
    expect(await errorOf(none)).toEqual({
      message: NO_SPEECH_MODEL_MESSAGE,
      type: 'server_error',
      param: null,
      code: 'model_not_loaded',
    })

    // The format is checked before the model: an `mp3` request is a 400 even with nothing loaded.
    const mp3 = await postJson(started, '/audio/speech', { input: 'Hello', response_format: 'mp3' })
    expect(mp3.status).toBe(400)
    expect(await errorOf(mp3)).toEqual({
      message: "response_format 'mp3' is not supported by the local engine; use 'wav' or 'pcm'",
      type: 'invalid_request_error',
      param: 'response_format',
      code: null,
    })

    const garbage = await fetch(`http://127.0.0.1:${started.port}/v1/audio/speech`, {
      method: 'POST',
      body: '{"input": ',
      headers: { 'content-type': 'application/json' },
    })
    expect(garbage.status).toBe(400)
    expect((await errorOf(garbage))['message']).toMatch(/^Invalid JSON body: /)

    // Only POST: the method table knows the route.
    const get = await fetch(`http://127.0.0.1:${started.port}/v1/audio/speech`)
    expect(get.status).toBe(405)
    expect(get.headers.get('allow')).toBe('POST')
    // Transcription is not served.
    const stt = await postJson(started, '/audio/transcriptions', { model: 'whisper-1' })
    expect(stt.status).toBe(404)

    expect(
      (await finished(4)).map((o) => [o.endpoint, o.status, o.error_kind, o.backend, o.model_id])
    ).toEqual([
      ['audio/speech', 503, 'not_found', 'unknown', null],
      ['audio/speech', 400, 'bad_request', 'unknown', null],
      ['audio/speech', 400, 'bad_request', 'unknown', null],
      ['audio/speech', 405, 'method_not_allowed', 'unknown', null],
    ])
  })

  it('speaks: the WAV as the engine wrote it, the job in the headers, and the analytics label', async () => {
    const speech = fakeSpeech()
    const { started, finished } = await server(speech)
    const res = await postJson(started, '/audio/speech', {
      model: 'Kokoro 82M',
      input: ' Hello ',
      voice: 'am_adam',
      speed: 1,
      instructions: 'Warmly',
      seed: 42,
      language: 'en',
      response_format: 'wav',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/wav')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(wav())
    expect({
      job: res.headers.get('x-atomic-job-id'),
      seed: res.headers.get('x-atomic-seed'),
      rate: res.headers.get('x-atomic-sample-rate'),
      channels: res.headers.get('x-atomic-channels'),
    }).toEqual({ job: 'job-9', seed: '42', rate: '24000', channels: '1' })
    expect(speech.requests).toEqual([
      { text: 'Hello', voice: 'am_adam', instruct: 'Warmly', language: 'en', seed: 42 },
    ])
    expect((await finished(1))[0]).toMatchObject({
      endpoint: 'audio/speech',
      status: 200,
      backend: AUDIO_BACKEND_LABEL,
      model_id: 'kokoro-82m:q8_0',
      error_kind: null,
    })
  })

  it('answers pcm as the bare samples, and refuses a clip that is not 16-bit', async () => {
    const speech = fakeSpeech()
    const { started } = await server(speech)
    const pcm = await postJson(started, '/audio/speech', { input: 'Hello', response_format: 'pcm' })
    expect(pcm.status).toBe(200)
    expect(pcm.headers.get('content-type')).toBe('audio/pcm')
    expect(Buffer.from(await pcm.arrayBuffer())).toEqual(SAMPLES)

    const float = wav(Buffer.alloc(8), 32)
    speech.next = () => Promise.resolve({ ok: true, outcome: { job: job(), item: item(), wav: float } })
    const refused = await postJson(started, '/audio/speech', { input: 'Hello', response_format: 'pcm' })
    expect(refused.status).toBe(500)
    expect(await errorOf(refused)).toMatchObject({
      code: 'server_error',
      message: expect.stringMatching(/wav/),
    })
    // The same clip as a WAV is fine.
    const whole = await postJson(started, '/audio/speech', { input: 'Hello' })
    expect(Buffer.from(await whole.arrayBuffer())).toEqual(float)
  })

  it('serves speech only: music and effects models are no speech model, another name is not found', async () => {
    const speech = fakeSpeech()
    const { started, finished } = await server(speech)
    speech.mode = 'music'
    const music = await postJson(started, '/audio/speech', { input: 'Hello' })
    expect(music.status).toBe(503)
    expect(await errorOf(music)).toEqual({
      message:
        'The loaded audio model (Kokoro 82M) makes music, not speech. Load a speech model in Atomic Chat first.',
      type: 'server_error',
      param: null,
      code: 'model_not_loaded',
    })
    speech.mode = 'effects'
    const effects = await postJson(started, '/audio/speech', { input: 'Hello' })
    expect((await errorOf(effects))['message']).toContain('makes sound effects, not speech')

    speech.mode = 'speech'
    const other = await postJson(started, '/audio/speech', { model: 'tts-1', input: 'Hello' })
    expect(other.status).toBe(404)
    expect(await errorOf(other)).toEqual({
      message: "The model 'tts-1' is not loaded; the loaded speech model is 'kokoro-82m:q8_0'.",
      type: 'invalid_request_error',
      param: 'model',
      code: 'model_not_found',
    })
    // The proxy's `.`/`_` fold applies, as for images.
    expect((await postJson(started, '/audio/speech', { model: 'kokoro-82m:q8.0', input: 'x' })).status).toBe(
      200
    )
    expect(speech.requests).toHaveLength(1)
    expect((await finished(4)).map((o) => [o.status, o.error_kind, o.model_id])).toEqual([
      [503, 'not_found', null],
      [503, 'not_found', null],
      [404, 'not_found', 'tts-1'],
      [200, null, 'kokoro-82m:q8_0'],
    ])
  })

  it('maps a refusal to start, with the details of a 400 in brackets', async () => {
    const speech = fakeSpeech()
    const { started } = await server(speech)
    speech.start = async () => {
      throw new AtomicCoreError('INVALID_REQUEST', 'This voice model speaks only in a cloned voice.', 'qwen')
    }
    const refused = await postJson(started, '/audio/speech', { input: 'Hello' })
    expect(refused.status).toBe(400)
    expect(await errorOf(refused)).toEqual({
      message: 'This voice model speaks only in a cloned voice. (qwen)',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_request',
    })
    speech.start = async () => {
      throw new AtomicCoreError('JOB_BUSY', 'Another clip is being made. Wait for it, or stop it.', 'job-1')
    }
    const busy = await postJson(started, '/audio/speech', { input: 'Hello' })
    expect(busy.status).toBe(429)
    expect(await errorOf(busy)).toMatchObject({
      message: 'Another clip is being made. Wait for it, or stop it.',
      code: 'busy',
    })
    speech.start = async () => {
      throw new AtomicCoreError('UNSUPPORTED_MODE', 'The loaded model makes music, not speech.')
    }
    expect(await errorOf(await postJson(started, '/audio/speech', { input: 'Hello' }))).toMatchObject({
      code: 'model_not_loaded',
    })
    speech.start = async () => {
      throw new Error('no code at all')
    }
    const odd = await postJson(started, '/audio/speech', { input: 'Hello' })
    expect(odd.status).toBe(500)
    expect(await errorOf(odd)).toMatchObject({ message: 'no code at all', code: 'server_error' })
    // A bug on our side is no refusal of the body: the server's own 500.
    speech.loaded = () => {
      throw new TypeError('lookup bug')
    }
    const bug = await postJson(started, '/audio/speech', { input: 'Hello' })
    expect(bug.status).toBe(500)
    expect(await bug.text()).toBe('Internal server error')
  })

  it("maps a job that failed, with the engine's words on their own line", async () => {
    const speech = fakeSpeech()
    speech.next = () =>
      Promise.resolve({
        ok: false,
        error: {
          code: 'REQUEST_REJECTED',
          message: 'The audio engine refused the request.',
          details: 'unknown Kokoro TTS request option: instruct',
        },
      })
    const { started, finished } = await server(speech)
    const rejected = await postJson(started, '/audio/speech', { input: 'Hello', instructions: 'Calm' })
    expect(rejected.status).toBe(400)
    expect(await errorOf(rejected)).toEqual({
      message: 'The audio engine refused the request.\nunknown Kokoro TTS request option: instruct',
      type: 'invalid_request_error',
      param: null,
      code: 'invalid_request',
    })
    speech.next = () =>
      Promise.resolve({ ok: false, error: { code: 'ENGINE_CRASHED', message: 'The audio engine crashed.' } })
    const crashed = await postJson(started, '/audio/speech', { input: 'Hello' })
    expect(crashed.status).toBe(500)
    expect(await errorOf(crashed)).toEqual({
      message: 'The audio engine crashed.',
      type: 'server_error',
      param: null,
      code: 'server_error',
    })
    expect((await finished(2)).map((o) => [o.status, o.error_kind, o.backend])).toEqual([
      [400, 'bad_request', AUDIO_BACKEND_LABEL],
      [500, 'upstream', AUDIO_BACKEND_LABEL],
    ])
  })

  it('cancels the job when the client goes away', async () => {
    const speech = fakeSpeech()
    let release: (() => void) | undefined
    speech.next = () =>
      new Promise((resolve) => {
        release = () =>
          resolve({ ok: false, error: { code: 'CANCELLED', message: 'The job was cancelled.' } })
      })
    const { started } = await server(speech)
    const controller = new AbortController()
    const pending = postJson(started, '/audio/speech', { input: 'Hello' }, { signal: controller.signal })
    await expect.poll(() => speech.requests.length).toBe(1)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await expect.poll(() => speech.cancelled).toEqual(['job-9'])
    release?.()
    expect(SPEECH_TIMEOUT_MS).toBe(30 * 60 * 1000)
  })

  it('answers 504 and cancels once the ceiling passes', async () => {
    const speech = fakeSpeech()
    speech.next = () => new Promise(() => {})
    const ex = await fakeExchange(speech)
    await serveAudioSpeech(ex.exchange, 50)
    expect(ex.status).toBe(504)
    expect(JSON.parse(ex.body).error).toEqual({
      message: 'Speech did not finish within 0 minutes and was cancelled.',
      type: 'server_error',
      param: null,
      code: 'timeout',
    })
    expect(speech.cancelled).toEqual(['job-9'])
    expect(ex.exchange.trace.errorKind).toBe('timeout')
  })

  it('reads a body a route already read', async () => {
    const speech = fakeSpeech()
    const ex = await fakeExchange(speech)
    ex.exchange.body = Buffer.from(JSON.stringify({ input: 'Read before' }))
    await serveAudioSpeech(ex.exchange)
    expect(ex.status).toBe(200)
    expect(speech.requests).toEqual([{ text: 'Read before' }])
  })
})

/** An `Exchange` over a bare response object, for the paths a real listener cannot reach. */
async function fakeExchange(speech: AudioSpeechBackend) {
  const { EventEmitter } = await import('node:events')
  const { RequestTrace } = await import('./trace.js')
  const { newExchange } = await import('./exchange.js')
  const { Readable } = await import('node:stream')
  type Req = Parameters<typeof newExchange>[0]
  type Res = Parameters<typeof newExchange>[1]
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ input: 'Hello' }))]), {
    method: 'POST',
    url: '/v1/audio/speech',
    headers: {},
    socket: { localAddress: '127.0.0.1' },
  })
  const captured = { status: 0, body: '' }
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
    writeHead: (status: number) => {
      captured.status = status
      return res
    },
    end: (body: Buffer) => {
      captured.body = body.toString()
      return res
    },
  })
  const deps = {
    findLocal: () => undefined,
    listLocal: () => [],
    providers: () => new Map(),
    increaseCtx: async () => ({ ok: false }),
    speech,
  }
  const trace = new RequestTrace('POST', deps)
  const exchange = newExchange(
    req as unknown as Req,
    res as unknown as Res,
    '/audio/speech',
    { host: '127.0.0.1', port: 1337, prefix: '/v1', apiKey: '', trustedHosts: [], proxyTimeoutSecs: 1 },
    deps,
    trace
  )
  return {
    exchange,
    get status() {
      return captured.status
    },
    get body() {
      return captured.body
    },
  }
}
