/**
 * The recipe written next to every clip as `<jobId>.json`: what was asked, with which model, engine
 * and seed, and how long the engine took. A WAV whose recipe does not parse is not ours. Pure.
 */

import { AUDIO_BACKENDS, AUDIO_MODES, AUDIO_TASKS } from '../contracts/index.js'
import type { AudioGenerateRequest, AudioOptions, AudioRecipe } from '../contracts/index.js'
import type { AudioServerSpec } from './types.js'

export interface RecipeInput {
  jobId: string
  request: AudioGenerateRequest
  spec: AudioServerSpec
  seed: number
  /** The options sent to the engine, named fields merged in. */
  options: AudioOptions
  createdAtMs: number
  durationMs: number
}

const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** The recipe of a finished job. Speech fields are `null` for music and effects, and the other way round. */
export function buildAudioRecipe(input: RecipeInput): AudioRecipe {
  const { request, spec } = input
  const speech = spec.mode === 'speech'
  const or = <T>(value: T | undefined, applies: boolean): T | null =>
    applies && value !== undefined ? value : null
  return {
    jobId: input.jobId,
    mode: spec.mode,
    text: request.text,
    voice: or(request.voice, speech),
    voiceRef: speech && request.voiceRef !== undefined,
    speed: or(request.speed, speech),
    language: or(request.language, speech),
    instruct: or(request.instruct, speech),
    lyrics: or(request.lyrics, !speech),
    durationSec: or(request.durationSec, !speech),
    bpm: or(request.bpm, !speech),
    seed: input.seed,
    steps: or(request.steps, !speech),
    negativePrompt: or(request.negativePrompt, !speech),
    options: { ...input.options },
    model: {
      modelId: spec.modelId,
      family: spec.family,
      task: spec.task,
      displayName: spec.displayName,
      filename: basename(spec.modelPath),
    },
    engine: { kind: 'audio-cpp', backend: spec.backend, tag: spec.tag },
    createdAtMs: input.createdAtMs,
    durationMs: input.durationMs,
  }
}

/** Two-space JSON with every key, `null`s included. */
export function serializeAudioRecipe(recipe: AudioRecipe): string {
  return `${JSON.stringify(recipe, null, 2)}\n`
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const stringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string'
const numberOrNull = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value))
const isOptions = (value: unknown): value is AudioOptions =>
  isRecord(value) &&
  Object.values(value).every(
    (v) => typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))
  )

/** The recipe in a sidecar's text, or `undefined` when it is not one of ours. */
export function parseAudioRecipe(text: string): AudioRecipe | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(raw)) return undefined
  const model = raw['model']
  const engine = raw['engine']
  if (
    typeof raw['jobId'] !== 'string' ||
    !(AUDIO_MODES as readonly unknown[]).includes(raw['mode']) ||
    typeof raw['text'] !== 'string' ||
    !stringOrNull(raw['voice']) ||
    typeof raw['voiceRef'] !== 'boolean' ||
    !numberOrNull(raw['speed']) ||
    !stringOrNull(raw['language']) ||
    !stringOrNull(raw['instruct']) ||
    !stringOrNull(raw['lyrics']) ||
    !numberOrNull(raw['durationSec']) ||
    !numberOrNull(raw['bpm']) ||
    typeof raw['seed'] !== 'number' ||
    !numberOrNull(raw['steps']) ||
    !stringOrNull(raw['negativePrompt']) ||
    !isOptions(raw['options']) ||
    !isRecord(model) ||
    typeof model['modelId'] !== 'string' ||
    typeof model['family'] !== 'string' ||
    !(AUDIO_TASKS as readonly unknown[]).includes(model['task']) ||
    typeof model['displayName'] !== 'string' ||
    typeof model['filename'] !== 'string' ||
    !isRecord(engine) ||
    engine['kind'] !== 'audio-cpp' ||
    !(AUDIO_BACKENDS as readonly unknown[]).includes(engine['backend']) ||
    typeof engine['tag'] !== 'string' ||
    typeof raw['createdAtMs'] !== 'number' ||
    typeof raw['durationMs'] !== 'number'
  )
    return undefined
  return raw as unknown as AudioRecipe
}
