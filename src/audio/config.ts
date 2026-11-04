/**
 * The `server.json` the core writes for each `audiocpp_server` it starts: one model, loaded before
 * the server listens (`lazy_load: false`), never unloaded by the engine (`idle_unload_ms: 0` — the
 * core owns the idle unload) and never joined by another (`max_loaded_models: 1`). audio.cpp declares
 * models only in its config: `/v1/models/load` needs `--ui-management`, which the core never passes.
 * Pure.
 */

import { posix, win32 } from 'node:path'
import type { AudioMode, AudioOptions, AudioTask } from '../contracts/index.js'
import { audioError } from './errors.js'
import type { AudioServerSpec } from './types.js'

/** The audio.cpp task a mode is served by: speech is `tts`, music and effects are `gen`. */
export function taskForMode(mode: AudioMode): AudioTask {
  return mode === 'speech' ? 'tts' : 'gen'
}

/**
 * The model a load names, absolute. An absolute path is taken as it is; a relative one is resolved
 * against the models folder and refused when it climbs out of it.
 */
export function resolveModelPath(file: string, modelsDir: string, platform: NodeJS.Platform): string {
  const path = platform === 'win32' ? win32 : posix
  if (file.trim() === '') throw audioError('INVALID_REQUEST', 'The load names no model file.')
  if (path.isAbsolute(file)) return path.normalize(file)
  const resolved = path.resolve(modelsDir, file)
  const rel = path.relative(modelsDir, resolved)
  if (rel === '' || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw audioError('INVALID_REQUEST', 'The model file is outside the audio models folder.', file)
  return resolved
}

export interface AudioServerModelEntry {
  id: string
  family: string
  path: string
  task: AudioTask
  mode: 'offline'
  load_options?: AudioOptions
  session_options?: AudioOptions
  default_request_options?: AudioOptions
  default_voice_preset?: { voice_id: string }
}

export interface AudioServerConfig {
  host: '127.0.0.1'
  port: number
  backend: string
  lazy_load: false
  max_loaded_models: 1
  idle_unload_ms: 0
  models: AudioServerModelEntry[]
}

/** The config for `spec` served on `port`. */
export function buildServerConfig(spec: AudioServerSpec, port: number): AudioServerConfig {
  const model: AudioServerModelEntry = {
    id: spec.modelId,
    family: spec.family,
    path: spec.modelPath,
    task: spec.task,
    mode: 'offline',
  }
  if (spec.loadOptions && Object.keys(spec.loadOptions).length > 0)
    model.load_options = { ...spec.loadOptions }
  if (spec.sessionOptions && Object.keys(spec.sessionOptions).length > 0)
    model.session_options = { ...spec.sessionOptions }
  if (spec.defaultRequestOptions && Object.keys(spec.defaultRequestOptions).length > 0)
    model.default_request_options = { ...spec.defaultRequestOptions }
  if (spec.defaultVoice !== undefined && spec.defaultVoice !== '')
    model.default_voice_preset = { voice_id: spec.defaultVoice }
  return {
    host: '127.0.0.1',
    port,
    backend: spec.backend,
    lazy_load: false,
    max_loaded_models: 1,
    idle_unload_ms: 0,
    models: [model],
  }
}
