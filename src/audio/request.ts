/**
 * What a job sends `audiocpp_server` and how its answer is read. Pure.
 *
 * Speech goes to `POST /v1/audio/speech` (OpenAI's shape: `input`, `voice`, `speed`, plus audio.cpp's
 * `seed`, `language`, `voice_ref`, `reference_text` and `options`) and answers WAV bytes. Music and
 * effects go to `POST /v1/tasks/run` (`request.text` and `request.options`) and answer JSON with the
 * WAV as base64 `audio` — and the same bytes again under `named_audio_outputs`, which is ignored.
 *
 * audio.cpp refuses an option the family does not declare ("unknown … request option"), so a named
 * field is sent only when the request sets it; it then wins over the same key in `options`. A style
 * instruction travels as the `instruct` option (Qwen3-TTS declares it): the top-level `instructions`
 * becomes an `instruction` option no family declares.
 */

import type { AudioGenerateRequest, AudioMode, AudioOptions } from '../contracts/index.js'
import { audioError } from './errors.js'

export const SPEECH_PATH = '/v1/audio/speech'
export const TASK_PATH = '/v1/tasks/run'

/** The engine option each named field of a speech request stands for. */
const SPEECH_NAMED: ReadonlyArray<[keyof AudioGenerateRequest, string]> = [
  ['voice', 'voice_id'],
  ['speed', 'speed'],
  ['language', 'language'],
  ['instruct', 'instruct'],
  ['referenceText', 'reference_text'],
]

/** The engine option each named field of a music or effects request stands for. */
const TASK_NAMED: ReadonlyArray<[keyof AudioGenerateRequest, string]> = [
  ['durationSec', 'duration_sec'],
  ['lyrics', 'lyrics'],
  ['bpm', 'bpm'],
  ['steps', 'num_inference_steps'],
  ['negativePrompt', 'negative_prompt'],
]

/** The request's own `options`, minus every key a named field (the seed included) of `mode` sets. */
export function extraOptions(mode: AudioMode, request: AudioGenerateRequest): AudioOptions {
  const out: AudioOptions = { ...(request.options ?? {}) }
  delete out['seed']
  for (const [field, key] of mode === 'speech' ? SPEECH_NAMED : TASK_NAMED)
    if (request[field] !== undefined) delete out[key]
  return out
}

/** `POST /v1/audio/speech`. `voiceRef` is the reference WAV, base64. */
export function buildSpeechBody(
  modelId: string,
  request: AudioGenerateRequest,
  seed: number,
  voiceRef?: string
): Record<string, unknown> {
  const options = extraOptions('speech', request)
  if (request.instruct !== undefined) options['instruct'] = request.instruct
  const body: Record<string, unknown> = { model: modelId, input: request.text, seed }
  if (request.voice !== undefined) body['voice'] = request.voice
  if (request.speed !== undefined) body['speed'] = request.speed
  if (request.language !== undefined) body['language'] = request.language
  if (voiceRef !== undefined) body['voice_ref'] = { type: 'base64', data: voiceRef }
  if (request.referenceText !== undefined) body['reference_text'] = request.referenceText
  if (Object.keys(options).length > 0) body['options'] = options
  return body
}

/** `POST /v1/tasks/run` for music and effects. */
export function buildTaskBody(
  modelId: string,
  request: AudioGenerateRequest,
  seed: number
): Record<string, unknown> {
  const options: AudioOptions = { ...extraOptions('music', request), seed }
  for (const [field, key] of TASK_NAMED) {
    const value = request[field]
    if (typeof value === 'string' || typeof value === 'number') options[key] = value
  }
  return { model: modelId, request: { text: request.text, options } }
}

/** The WAV of a `/v1/tasks/run` answer; `INVALID_OUTPUT` when there is none. */
export function decodeTaskAudio(body: Buffer): Buffer {
  let parsed: unknown
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch (error) {
    throw audioError(
      'INVALID_OUTPUT',
      'The audio engine answered with something that is not JSON.',
      error instanceof Error ? error.message : String(error)
    )
  }
  const audio = (parsed as { audio?: unknown } | null)?.audio
  if (typeof audio !== 'string' || audio === '')
    throw audioError('INVALID_OUTPUT', 'The audio engine answered without audio.')
  return Buffer.from(audio, 'base64')
}
