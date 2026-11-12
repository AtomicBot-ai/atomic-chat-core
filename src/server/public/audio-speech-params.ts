/**
 * The client's `POST /v1/audio/speech` body, structurally validated but not yet bound to the loaded
 * model; the sample data inside the engine's WAV, for `pcm`; and audio failures in OpenAI's error
 * envelope (`errorBody` of `images-params.ts`). Pure.
 *
 * OpenAI's fields where the local engine has them — `input`, `voice` (a built-in voice of the loaded
 * model, passed as is: OpenAI's names reach the engine, which refuses one it does not have), `speed`,
 * `instructions` (audio.cpp's `instruct`), `response_format` `wav` or `pcm` — plus audio.cpp's `seed`
 * and `language`. Every other field is ignored.
 */

import type { AudioErrorCode, AudioGenerateRequest } from '../../contracts/index.js'
import { ParamError } from './images-params.js'
import type { MappedError } from './images-params.js'

/** OpenAI's limit on `input`, in characters. */
export const MAX_SPEECH_INPUT_CHARS = 4096
export const MIN_SPEECH_SPEED = 0.25
export const MAX_SPEECH_SPEED = 4
export const SPEECH_FORMATS = ['wav', 'pcm'] as const
export type SpeechFormat = (typeof SPEECH_FORMATS)[number]
/** OpenAI's formats the local engine cannot encode: it only writes WAV. */
export const ENCODED_SPEECH_FORMATS = ['mp3', 'opus', 'aac', 'flac'] as const
export const SPEECH_CONTENT_TYPES: Readonly<Record<SpeechFormat, string>> = {
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

export interface SpeechParams {
  model?: string
  input: string
  voice?: string
  speed?: number
  instructions?: string
  format: SpeechFormat
  seed?: number
  language?: string
}

const bad = (param: string, message: string) => new ParamError(param, message)
const isNil = (value: unknown): value is undefined | null => value === undefined || value === null

/** Whether `text` holds more than `max` characters (code points), without spreading a huge string. */
function longerThan(text: string, max: number): boolean {
  if (text.length <= max) return false
  let count = 0
  for (const _ of text) if (++count > max) return true
  return false
}

/** A string field, trimmed; absent when it is missing, `null` or blank. */
function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  if (isNil(value)) return undefined
  if (typeof value !== 'string') throw bad(key, `${key} must be a string`)
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

function parseFormat(obj: Record<string, unknown>): SpeechFormat {
  const format = obj['response_format']
  if (isNil(format)) return 'wav'
  if (typeof format !== 'string') throw bad('response_format', 'response_format must be a string')
  if ((SPEECH_FORMATS as readonly string[]).includes(format)) return format as SpeechFormat
  if ((ENCODED_SPEECH_FORMATS as readonly string[]).includes(format))
    throw bad(
      'response_format',
      `response_format '${format}' is not supported by the local engine; use 'wav' or 'pcm'`
    )
  throw bad(
    'response_format',
    `response_format must be one of ${[...ENCODED_SPEECH_FORMATS, ...SPEECH_FORMATS].join(', ')}`
  )
}

export function parseSpeechParams(body: unknown): SpeechParams {
  if (body === null || typeof body !== 'object' || Array.isArray(body))
    throw bad('body', 'request body must be a JSON object')
  const obj = body as Record<string, unknown>
  const rawInput = obj['input']
  const input = typeof rawInput === 'string' ? rawInput.trim() : ''
  if (input === '') throw bad('input', 'input is required')
  if (longerThan(input, MAX_SPEECH_INPUT_CHARS))
    throw bad('input', `input must be at most ${MAX_SPEECH_INPUT_CHARS} characters`)

  const params: SpeechParams = { input, format: parseFormat(obj) }
  const stream = obj['stream_format']
  if (!isNil(stream) && stream !== 'audio')
    throw bad(
      'stream_format',
      stream === 'sse'
        ? "stream_format 'sse' is not supported by the local server; leave it out or use 'audio'"
        : "stream_format must be 'audio' or 'sse'"
    )
  if (!isNil(obj['speed'])) {
    const speed = obj['speed']
    if (
      typeof speed !== 'number' ||
      !Number.isFinite(speed) ||
      speed < MIN_SPEECH_SPEED ||
      speed > MAX_SPEECH_SPEED
    )
      throw bad('speed', `speed must be a number between ${MIN_SPEECH_SPEED} and ${MAX_SPEECH_SPEED}`)
    params.speed = speed
  }
  if (!isNil(obj['seed'])) {
    const seed = obj['seed']
    if (typeof seed !== 'number' || !Number.isSafeInteger(seed)) throw bad('seed', 'seed must be an integer')
    params.seed = seed
  }
  const model = optionalString(obj, 'model')
  if (model !== undefined) params.model = model
  const voice = optionalString(obj, 'voice')
  if (voice !== undefined) params.voice = voice
  const instructions = optionalString(obj, 'instructions')
  if (instructions !== undefined) params.instructions = instructions
  const language = optionalString(obj, 'language')
  if (language !== undefined) params.language = language
  return params
}

/**
 * The job request. A `speed` of 1 is OpenAI's default and is left out: a model that declares no
 * speed option (Qwen3-TTS) refuses the key even at 1, and an absent one is the model's own pace.
 */
export function buildSpeechRequest(params: SpeechParams): AudioGenerateRequest {
  const request: AudioGenerateRequest = { text: params.input }
  if (params.voice !== undefined) request.voice = params.voice
  if (params.speed !== undefined && params.speed !== 1) request.speed = params.speed
  if (params.instructions !== undefined) request.instruct = params.instructions
  if (params.language !== undefined) request.language = params.language
  if (params.seed !== undefined) request.seed = params.seed
  return request
}

export interface WavPcm {
  /** The `data` chunk: 16-bit little-endian samples, interleaved when there is more than one channel. */
  pcm: Buffer
  sampleRate: number
  channels: number
}

/** The sample data of a 16-bit PCM WAV, header stripped; `undefined` for anything else. */
export function wavPcmData(wav: Buffer): WavPcm | undefined {
  if (wav.length < 12 || wav.toString('latin1', 0, 4) !== 'RIFF' || wav.toString('latin1', 8, 12) !== 'WAVE')
    return undefined
  let format: { tag: number; channels: number; sampleRate: number; bits: number } | undefined
  let at = 12
  while (at + 8 <= wav.length) {
    const id = wav.toString('latin1', at, at + 4)
    const size = wav.readUInt32LE(at + 4)
    const body = at + 8
    if (id === 'fmt ') {
      if (size < 16 || body + 16 > wav.length) return undefined
      format = {
        tag: wav.readUInt16LE(body),
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bits: wav.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      // WAVE_FORMAT_PCM, or WAVE_FORMAT_EXTENSIBLE around it.
      if (!format || (format.tag !== 1 && format.tag !== 0xfffe) || format.bits !== 16) return undefined
      if (format.channels === 0 || format.sampleRate === 0) return undefined
      // A streamed WAV says 0xFFFFFFFF; a short file is cut where it ends.
      const end = Math.min(body + size, wav.length)
      return { pcm: wav.subarray(body, end), sampleRate: format.sampleRate, channels: format.channels }
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    at = body + size + (size % 2)
  }
  return undefined
}

/** HTTP status, error type and `code` for an audio error, as `/audio/speech` answers it. */
export function mapSpeechError(code: AudioErrorCode): MappedError {
  switch (code) {
    case 'INVALID_REQUEST':
    case 'REQUEST_REJECTED':
      return { status: 400, type: 'invalid_request_error', code: 'invalid_request' }
    // A model switched to music or effects between the check and the start is no speech model either.
    case 'MODEL_NOT_LOADED':
    case 'UNSUPPORTED_MODE':
    case 'ENGINE_MISSING':
    case 'MODEL_MISSING':
      return { status: 503, type: 'server_error', code: 'model_not_loaded' }
    case 'JOB_BUSY':
      return { status: 429, type: 'server_error', code: 'busy' }
    // The subsystem is shutting down: try again later, like any other busy answer.
    case 'AUDIO_UNAVAILABLE':
      return { status: 503, type: 'server_error', code: 'busy' }
    case 'OUT_OF_MEMORY':
      return { status: 500, type: 'server_error', code: 'insufficient_memory' }
    case 'CANCELLED':
      return { status: 500, type: 'server_error', code: 'cancelled' }
    default:
      return { status: 500, type: 'server_error', code: 'server_error' }
  }
}
