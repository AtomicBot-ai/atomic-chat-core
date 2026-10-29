/**
 * `POST /v1/audio/speech`: an OpenAI-shaped facade over the audio job runner, so a client gets the
 * same job, `audio:job` events, gallery write and idle timer as the app's Audios studio. The loaded
 * audio model is the only one that speaks, and only when it is a speech model; audio models are
 * absent from `/v1/models` like image models. The answer is the clip itself: the engine's WAV, or for
 * `pcm` its 16-bit samples without the header. What OpenAI's body has no room for — the job, the seed,
 * the sample rate and channels — rides in `X-Atomic-*` headers.
 */

import type { AudioErrorCode, AudioGenerateRequest, AudioMode } from '../../contracts/index.js'
import { answer, clientGone, invalidJsonMessage } from './exchange.js'
import type { Exchange } from './exchange.js'
import {
  buildSpeechRequest,
  mapSpeechError,
  parseSpeechParams,
  SPEECH_CONTENT_TYPES,
  wavPcmData,
} from './audio-speech-params.js'
import type { SpeechFormat } from './audio-speech-params.js'
import { errorBody, errorKindFor, modelMatches, ParamError } from './images-params.js'
import type { AudioSpeechBackend } from './types.js'
import type { HeaderPairs } from './wire.js'
import { readBody } from './wire.js'

/** The facade's own ceiling, as for images; the runner's six-hour one is for the studio, which shows the job. */
export const SPEECH_TIMEOUT_MS = 30 * 60 * 1000
export const NO_SPEECH_MODEL_MESSAGE = 'No speech model loaded. Load a speech model in Atomic Chat first.'
export const AUDIO_BACKEND_LABEL = 'atomic-audio'

const MAKES: Readonly<Record<Exclude<AudioMode, 'speech'>, string>> = {
  music: 'music',
  effects: 'sound effects',
}

const JSON_HEADERS: HeaderPairs = [['Content-Type', 'application/json']]

function fail(ex: Exchange, status: number, body: string, errorKind: string): void {
  ex.trace.errorKind = errorKind
  answer(ex, status, body, JSON_HEADERS)
}

/** An audio failure in OpenAI's envelope; `details` follow a 400 in brackets and anything else on their own line. */
function failWith(
  ex: Exchange,
  error: { code?: string; message: string; details?: string | undefined },
  join: 'start' | 'job'
): void {
  const mapped = mapSpeechError((error.code ?? 'INTERNAL') as AudioErrorCode)
  let message = error.message
  if (error.details && join === 'job') message = `${message}\n${error.details}`
  else if (error.details && mapped.status === 400) message = `${message} (${error.details})`
  fail(ex, mapped.status, errorBody(message, mapped.type, mapped.code, null), errorKindFor(mapped.status))
}

export async function serveAudioSpeech(ex: Exchange, timeoutMs = SPEECH_TIMEOUT_MS): Promise<void> {
  const { trace, deps } = ex
  let parsed: unknown
  try {
    parsed = JSON.parse((ex.body ?? (await readBody(ex.req))).toString('utf8'))
  } catch (e) {
    return fail(ex, 400, errorBody(invalidJsonMessage(e), 'invalid_request_error', null, null), 'bad_request')
  }
  let request: AudioGenerateRequest
  let format: SpeechFormat
  let loaded: ReturnType<AudioSpeechBackend['loaded']>
  try {
    // The body is checked before the model: a bad format is a 400 even with nothing loaded.
    const params = parseSpeechParams(parsed)
    trace.modelId = params.model ?? null
    loaded = deps.speech?.loaded()
    if (!loaded)
      return fail(
        ex,
        503,
        errorBody(NO_SPEECH_MODEL_MESSAGE, 'server_error', 'model_not_loaded', null),
        'not_found'
      )
    if (loaded.mode !== 'speech')
      return fail(
        ex,
        503,
        errorBody(
          `The loaded audio model (${loaded.displayName}) makes ${MAKES[loaded.mode]}, not speech. Load a speech model in Atomic Chat first.`,
          'server_error',
          'model_not_loaded',
          null
        ),
        'not_found'
      )
    if (!modelMatches(params.model, loaded))
      return fail(
        ex,
        404,
        errorBody(
          `The model '${params.model}' is not loaded; the loaded speech model is '${loaded.modelId}'.`,
          'invalid_request_error',
          'model_not_found',
          'model'
        ),
        'not_found'
      )
    request = buildSpeechRequest(params)
    format = params.format
  } catch (e) {
    if (!(e instanceof ParamError)) throw e
    return fail(ex, 400, errorBody(e.message, 'invalid_request_error', null, e.param), 'bad_request')
  }
  trace.modelId = loaded.modelId
  trace.backend = AUDIO_BACKEND_LABEL
  return runToAnswer(ex, deps.speech as AudioSpeechBackend, request, format, timeoutMs)
}

/** Start the job, wait for it (the client leaving or the ceiling cancels it), and answer its clip. */
async function runToAnswer(
  ex: Exchange,
  speech: AudioSpeechBackend,
  request: AudioGenerateRequest,
  format: SpeechFormat,
  timeoutMs: number
): Promise<void> {
  let started: Awaited<ReturnType<AudioSpeechBackend['start']>>
  try {
    started = await speech.start(request)
  } catch (raw) {
    return failWith(ex, raw as { code?: string; message: string; details?: string }, 'start')
  }

  // The client going away cancels the job, and so does the ceiling: nobody is waiting for it.
  const gone = clientGone(ex)
  const onGone = () => void speech.cancel(started.id)
  gone.addEventListener('abort', onGone, { once: true })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const result = await Promise.race([started.done, timeout])
    if (result === 'timeout') {
      void speech.cancel(started.id)
      const minutes = Math.round(timeoutMs / 60_000)
      return fail(
        ex,
        504,
        errorBody(
          `Speech did not finish within ${minutes} minutes and was cancelled.`,
          'server_error',
          'timeout',
          null
        ),
        'timeout'
      )
    }
    if (!result.ok) return failWith(ex, result.error, 'job')
    const { job, item, wav } = result.outcome
    let bytes = wav
    if (format === 'pcm') {
      const pcm = wavPcmData(wav)
      if (!pcm)
        return fail(
          ex,
          500,
          errorBody(
            'The clip is not 16-bit PCM, so it cannot be answered as pcm; ask for wav.',
            'server_error',
            'server_error',
            null
          ),
          'upstream'
        )
      bytes = pcm.pcm
    }
    answer(ex, 200, bytes, [
      ['Content-Type', SPEECH_CONTENT_TYPES[format]],
      ['X-Atomic-Job-Id', job.id],
      ['X-Atomic-Seed', String(item.recipe.seed)],
      ['X-Atomic-Sample-Rate', String(item.sampleRate)],
      ['X-Atomic-Channels', String(item.channels)],
    ])
  } finally {
    clearTimeout(timer)
    gone.removeEventListener('abort', onGone)
  }
}
