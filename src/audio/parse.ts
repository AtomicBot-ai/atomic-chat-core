/**
 * Request bodies of the audio routes, read strictly: closed enums, finite numbers, `null` taken as
 * absent for anything optional, unknown fields ignored. A body that does not fit is `INVALID_REQUEST`,
 * and nothing downstream has to doubt a type again (as image generation's `parse.ts`).
 */

import { AUDIO_MODES, AUDIO_TASKS } from '../contracts/index.js'
import type {
  AudioConfig,
  AudioGalleryListOptions,
  AudioGenerateRequest,
  AudioJobSubmission,
  AudioMode,
  AudioOptions,
  AudioSource,
  AudioTask,
  LoadAudioModelRequest,
} from '../contracts/index.js'
import { audioError } from './errors.js'

type Fields = Record<string, unknown>

function invalid(field: string, expected: string): never {
  throw audioError('INVALID_REQUEST', 'The request is not valid.', `${field}: expected ${expected}`)
}

function fields(value: unknown, field: string): Fields {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(field, 'an object')
  return value as Fields
}

/** `undefined` for a field that is absent or `null`. */
function present(source: Fields, key: string): unknown {
  const value = source[key]
  return value === null ? undefined : value
}

function string(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field, 'a string')
  return value
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(field, 'a non-empty string')
  return value
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(field, 'a number')
  return value
}

function positive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    invalid(field, 'a number above zero')
  return value
}

function integer(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) invalid(field, 'a whole number')
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0)
    invalid(field, 'a whole number above zero')
  return value
}

function wholeNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    invalid(field, 'a whole number, zero or more')
  return value
}

function oneOf<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value))
    invalid(field, `one of ${allowed.join(', ')}`)
  return value as T
}

function options(value: unknown, field: string): AudioOptions {
  const source = fields(value, field)
  const out: AudioOptions = {}
  for (const [key, entry] of Object.entries(source)) {
    if (
      typeof entry !== 'string' &&
      typeof entry !== 'boolean' &&
      !(typeof entry === 'number' && Number.isFinite(entry))
    )
      invalid(`${field}.${key}`, 'a string, a number or true/false')
    out[key] = entry
  }
  return out
}

/** Set `target[key]` from `source[key]` when it is present, through `read`. */
function copy<T extends object, K extends keyof T>(
  target: T,
  key: K,
  source: Fields,
  read: (value: unknown, field: string) => T[K]
): void {
  const value = present(source, key as string)
  if (value !== undefined) target[key] = read(value, key as string)
}

export function parseAudioMode(value: unknown): AudioMode {
  return oneOf(value, 'mode', AUDIO_MODES)
}

function audioSource(value: unknown, field: string): AudioSource {
  const source = fields(value, field)
  const path = present(source, 'path')
  const base64 = present(source, 'base64')
  if ((path === undefined) === (base64 === undefined)) invalid(field, 'either a path or base64')
  return path !== undefined
    ? { path: nonEmpty(path, `${field}.path`) }
    : { base64: nonEmpty(base64, `${field}.base64`) }
}

export function parseAudioConfig(body: unknown): AudioConfig {
  const source = fields(body, 'config')
  const config: AudioConfig = {}
  if ('outputDir' in source)
    config.outputDir = source['outputDir'] === null ? null : string(source['outputDir'], 'outputDir')
  copy(config, 'idleUnloadSecs', source, wholeNumber)
  return config
}

export function parseLoadAudioModelRequest(body: unknown): LoadAudioModelRequest {
  const source = fields(body, 'request')
  const request: LoadAudioModelRequest = {
    modelId: nonEmpty(source['modelId'], 'modelId'),
    displayName: string(source['displayName'], 'displayName'),
    mode: parseAudioMode(source['mode']),
    file: nonEmpty(source['file'], 'file'),
    family: nonEmpty(source['family'], 'family'),
    task: oneOf<AudioTask>(source['task'], 'task', AUDIO_TASKS),
  }
  copy(request, 'loadOptions', source, options)
  copy(request, 'sessionOptions', source, options)
  copy(request, 'defaultRequestOptions', source, options)
  copy(request, 'defaultVoice', source, string)
  copy(request, 'threads', source, positiveInteger)
  copy(request, 'startupTimeoutSecs', source, positiveInteger)
  return request
}

export function parseAudioGenerateRequest(body: unknown): AudioGenerateRequest {
  const source = fields(body, 'request')
  const request: AudioGenerateRequest = { text: nonEmpty(source['text'], 'text') }
  copy(request, 'voice', source, string)
  copy(request, 'voiceRef', source, audioSource)
  copy(request, 'referenceText', source, string)
  copy(request, 'speed', source, positive)
  copy(request, 'language', source, string)
  copy(request, 'instruct', source, string)
  copy(request, 'lyrics', source, string)
  copy(request, 'durationSec', source, number)
  copy(request, 'bpm', source, positive)
  copy(request, 'seed', source, integer)
  copy(request, 'steps', source, positiveInteger)
  copy(request, 'negativePrompt', source, string)
  copy(request, 'options', source, options)
  return request
}

/** `POST /audio/jobs`: `{mode, request}`. */
export function parseAudioJobSubmission(body: unknown): AudioJobSubmission {
  const source = fields(body, 'body')
  return { mode: parseAudioMode(source['mode']), request: parseAudioGenerateRequest(source['request']) }
}

export function parseAudioGalleryListOptions(body: unknown): AudioGalleryListOptions {
  const source = fields(body, 'options')
  return { offset: wholeNumber(source['offset'], 'offset'), limit: wholeNumber(source['limit'], 'limit') }
}

/** One required string out of a body, for the routes that take nothing else (`path`, `relativePath`). */
export function requireAudioString(body: unknown, key: string): string {
  return string(fields(body, 'body')[key], key)
}
