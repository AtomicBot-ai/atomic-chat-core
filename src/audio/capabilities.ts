/**
 * What a running `audiocpp_server` says about its model: the entry `GET /v1/models?include_params=true`
 * lists for it, and the client-facing `AudioCapabilities` built from that entry and the facts the
 * loader traced. Pure.
 */

import type { AudioCapabilities, AudioModelParam, AudioOptionValue } from '../contracts/index.js'
import type { AudioModelFacts } from './output.js'
import type { AudioServerSpec } from './types.js'

/** One model of `/v1/models`, as far as the core reads it. */
export interface ServedAudioModel {
  id: string
  family: string
  task: string
  loaded: boolean
  params: AudioModelParam[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isOptionValue = (value: unknown): value is AudioOptionValue =>
  typeof value === 'string' ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value))

/** One declared parameter, or `undefined` when it has no name. Unknown keys are dropped. */
export function parseModelParam(raw: unknown): AudioModelParam | undefined {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || raw['name'] === '') return undefined
  const param: AudioModelParam = {
    name: raw['name'],
    type: typeof raw['type'] === 'string' ? raw['type'] : 'string',
    required: raw['required'] === true,
  }
  if (typeof raw['description'] === 'string') param.description = raw['description']
  if (isOptionValue(raw['default'])) param.default = raw['default']
  if (typeof raw['min'] === 'number' && Number.isFinite(raw['min'])) param.min = raw['min']
  if (typeof raw['max'] === 'number' && Number.isFinite(raw['max'])) param.max = raw['max']
  if (Array.isArray(raw['values']))
    param.values = raw['values'].filter((value): value is string => typeof value === 'string')
  return param
}

/** Every model of a `/v1/models` body; an entry without an id is skipped, a body that is not a list gives none. */
export function parseServedModels(body: unknown): ServedAudioModel[] {
  const data = isRecord(body) ? body['data'] : undefined
  if (!Array.isArray(data)) return []
  const out: ServedAudioModel[] = []
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string') continue
    const params = Array.isArray(entry['params']) ? entry['params'] : []
    out.push({
      id: entry['id'],
      family: typeof entry['family'] === 'string' ? entry['family'] : '',
      task: typeof entry['task'] === 'string' ? entry['task'] : '',
      loaded: entry['loaded'] === true,
      params: params.map(parseModelParam).filter((param): param is AudioModelParam => param !== undefined),
    })
  }
  return out
}

/** The voice ids of `GET /v1/audio/voices`: strings, or objects naming an `id`, `voice_id` or `name`. */
export function parseVoiceList(body: unknown): string[] {
  const voices = isRecord(body) ? body['voices'] : undefined
  if (!Array.isArray(voices)) return []
  const out: string[] = []
  for (const voice of voices) {
    if (typeof voice === 'string') out.push(voice)
    else if (isRecord(voice))
      for (const key of ['id', 'voice_id', 'name'])
        if (typeof voice[key] === 'string') {
          out.push(voice[key])
          break
        }
  }
  return out
}

/**
 * Families whose variant speaks only in a cloned voice. Qwen3-TTS Base refuses a request without a
 * reference ("Qwen3 base TTS requires voice clone reference audio") although its `voice_id` still
 * lists the CustomVoice speakers.
 */
const CLONE_ONLY_VARIANTS: Readonly<Record<string, RegExp>> = { qwen3_tts: /(^|[-_ ])base$/i }

/** The capabilities of `spec`'s model, as the server that serves it declared them. */
export function buildCapabilities(
  spec: Pick<AudioServerSpec, 'modelId' | 'mode' | 'family' | 'task'>,
  served: ServedAudioModel,
  facts: AudioModelFacts,
  listedVoices: readonly string[] = []
): AudioCapabilities {
  const speech = spec.mode === 'speech'
  const voiceParam = served.params.find((param) => param.name === 'voice_id')
  const cloneOnly =
    speech && facts.variant !== undefined && (CLONE_ONLY_VARIANTS[spec.family]?.test(facts.variant) ?? false)
  const declared = voiceParam?.values && voiceParam.values.length > 0 ? voiceParam.values : listedVoices
  const supportsVoiceRef =
    speech &&
    (cloneOnly ||
      facts.supportsSpeakerReference === true ||
      served.params.some((param) => param.name === 'reference_text'))
  return {
    modelId: spec.modelId,
    mode: spec.mode,
    family: spec.family,
    task: spec.task,
    params: served.params.map((param) => structuredClone(param)),
    voices: speech && !cloneOnly ? [...declared] : [],
    supportsVoiceRef,
    requiresVoiceRef: cloneOnly,
  }
}
