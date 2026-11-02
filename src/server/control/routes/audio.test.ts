import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../../contracts/index.js'
import { startControlHarness as start } from '../../../../test/helpers/control-harness.js'
import type { ControlHarness } from '../../../../test/helpers/control-harness.js'
import {
  FAKE_AUDIO_CAPABILITIES,
  FAKE_AUDIO_ITEM,
  FAKE_AUDIO_JOB,
  FAKE_AUDIO_STATUS,
  FAKE_LOADED_AUDIO_MODEL,
} from '../../../../test/helpers/fake-audio-control.js'
import { MAX_AUDIO_JOB_BODY_BYTES } from './audio.js'

let h: ControlHarness

beforeEach(async () => {
  h = await start()
})
afterEach(() => h.server.close())

const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})
const audioCalls = () => h.calls.filter((c) => c.startsWith('audio '))
type ErrorBody = { error: { code: string; message: string; details?: string } }

describe('configuration and status', () => {
  it('answers the status, applies the settings and moves the output folder', async () => {
    expect(await (await h.get('/atomic/v1/audio/status')).json()).toEqual(FAKE_AUDIO_STATUS)
    const configured = await h.get(
      '/atomic/v1/audio/config',
      json({ idleUnloadSecs: 0, outputDir: null }, 'PUT')
    )
    expect(configured.status).toBe(200)
    expect(await configured.json()).toEqual({ ...FAKE_AUDIO_STATUS, idleUnloadSecs: 0 })
    const moved = await h.get('/atomic/v1/audio/output-dir', json({ path: '/sounds' }, 'PUT'))
    expect(((await moved.json()) as { outputDir: string }).outputDir).toBe('/sounds')
    expect(audioCalls()).toEqual([
      'audio config {"outputDir":null,"idleUnloadSecs":0}',
      'audio setOutputDir /sounds',
    ])
  })

  it('refuses a body that is not the contract, with the audio code', async () => {
    const res = await h.get('/atomic/v1/audio/config', json({ idleUnloadSecs: 'soon' }, 'PUT'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'The request is not valid.',
        details: 'idleUnloadSecs: expected a whole number, zero or more',
      },
    })
    expect(audioCalls()).toEqual([])
  })
})

describe('model files', () => {
  it('lists them and deletes one by its relative path', async () => {
    expect(await (await h.get('/atomic/v1/audio/model-files')).json()).toEqual({
      files: [{ path: '/tmp/data/audio/models/kokoro/k.gguf', relativePath: 'kokoro/k.gguf', bytes: 5 }],
    })
    const deleted = await h.get(
      '/atomic/v1/audio/model-files',
      json({ relativePath: 'kokoro/k.gguf' }, 'DELETE')
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({})
    expect((await h.get('/atomic/v1/audio/model-files', json({}, 'DELETE'))).status).toBe(400)
    expect(audioCalls()).toEqual(['audio deleteModelFile kokoro/k.gguf'])
  })
})

describe('the session', () => {
  it('loads, unloads, answers capabilities and touches the idle timer', async () => {
    const request = {
      modelId: 'kokoro-82m:q8_0',
      displayName: 'Kokoro 82M',
      mode: 'speech',
      file: 'kokoro/k.gguf',
      family: 'kokoro_tts',
      task: 'tts',
    }
    expect(await (await h.get('/atomic/v1/audio/model/load', json(request))).json()).toEqual(
      FAKE_LOADED_AUDIO_MODEL
    )
    expect(await (await h.get('/atomic/v1/audio/capabilities')).json()).toEqual(FAKE_AUDIO_CAPABILITIES)
    expect(await (await h.get('/atomic/v1/audio/idle/touch', { method: 'POST' })).json()).toEqual({})
    expect(await (await h.get('/atomic/v1/audio/model/unload', { method: 'POST' })).json()).toEqual({})
    const bad = await h.get('/atomic/v1/audio/model/load', json({ ...request, task: 'stt' }))
    expect(bad.status).toBe(400)
    expect(audioCalls()).toEqual([
      'audio loadModel kokoro-82m:q8_0 speech',
      'audio touchIdle',
      'audio unloadModel',
    ])
  })

  it('answers a service refusal with its status: no model is 404, the wrong mode 409, an engine refusal 422', async () => {
    const refusals: Array<[AtomicCoreError, number]> = [
      [new AtomicCoreError('MODEL_NOT_LOADED', 'No audio model is loaded.'), 404],
      [new AtomicCoreError('UNSUPPORTED_MODE', 'The loaded model makes speech, not music.'), 409],
      [
        new AtomicCoreError('REQUEST_REJECTED', 'The audio engine refused the request.', 'unknown option'),
        422,
      ],
      [new AtomicCoreError('JOB_BUSY', 'Another clip is being made.', 'ajob-0'), 409],
    ]
    for (const [error, status] of refusals) {
      h.audio.generate = async () => {
        throw error
      }
      const res = await h.get('/atomic/v1/audio/jobs', json({ mode: 'music', request: { text: 'x' } }))
      expect(res.status, error.code).toBe(status)
      expect(((await res.json()) as ErrorBody).error.code).toBe(error.code)
    }
  })
})

describe('jobs', () => {
  it('starts a job, reads it back wrapped, and cancels it', async () => {
    const started = await h.get('/atomic/v1/audio/jobs', json({ mode: 'speech', request: { text: 'hello' } }))
    expect(started.status).toBe(200)
    expect(await started.json()).toEqual({ ...FAKE_AUDIO_JOB, request: { text: 'hello' } })
    expect(await (await h.get(`/atomic/v1/audio/jobs/${FAKE_AUDIO_JOB.id}`)).json()).toEqual({
      job: FAKE_AUDIO_JOB,
    })
    expect(await (await h.get('/atomic/v1/audio/jobs/nope')).json()).toEqual({ job: null })
    expect(
      await (await h.get(`/atomic/v1/audio/jobs/${FAKE_AUDIO_JOB.id}/cancel`, { method: 'POST' })).json()
    ).toEqual({ cancelled: true, serverStopped: true })
    expect(audioCalls()).toEqual(['audio generate speech hello', `audio cancelJob ${FAKE_AUDIO_JOB.id}`])
  })

  it('takes a reference voice inline up to the body cap, and refuses a mode that does not exist', async () => {
    expect(MAX_AUDIO_JOB_BODY_BYTES).toBeGreaterThan((5 * 1024 * 1024 * 4) / 3)
    const big = { mode: 'speech', request: { text: 'hi', voiceRef: { base64: 'A'.repeat(7 * 1024 * 1024) } } }
    expect((await h.get('/atomic/v1/audio/jobs', json(big))).status).toBe(200)
    const res = await h.get('/atomic/v1/audio/jobs', json({ mode: 'song', request: { text: 'x' } }))
    expect(res.status).toBe(400)
    expect(((await res.json()) as ErrorBody).error.details).toBe(
      'mode: expected one of speech, music, effects'
    )
  })
})

describe('gallery', () => {
  it('pages through the clips with defaults, and deletes one by id', async () => {
    expect(await (await h.get('/atomic/v1/audio/gallery?offset=10&limit=5')).json()).toEqual({
      items: [FAKE_AUDIO_ITEM],
      hasMore: false,
      total: 1,
    })
    await h.get('/atomic/v1/audio/gallery')
    expect((await h.get('/atomic/v1/audio/gallery?offset=')).status).toBe(400)
    expect((await h.get('/atomic/v1/audio/gallery?limit=-1')).status).toBe(400)
    const deleted = await h.get(`/atomic/v1/audio/gallery/${FAKE_AUDIO_ITEM.id}`, { method: 'DELETE' })
    expect(await deleted.json()).toEqual({})
    expect(audioCalls()).toEqual([
      'audio gallery {"offset":10,"limit":5}',
      'audio gallery {"offset":0,"limit":50}',
      `audio deleteGalleryItem ${FAKE_AUDIO_ITEM.id}`,
    ])
  })
})
