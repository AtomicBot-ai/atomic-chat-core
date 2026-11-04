/**
 * An in-memory `AudioControl` for the control server and client tests: records what it was asked and
 * answers canned values in the wire shapes. The real service is exercised by
 * `src/audio/service.test.ts` and `test/e2e/audio.test.ts`.
 */
import type {
  AudioCapabilities,
  AudioGalleryItem,
  AudioJob,
  AudioStatus,
  LoadedAudioModel,
} from '../../src/contracts/index.js'
import type { AudioControl } from '../../src/server/control/index.js'

export const FAKE_AUDIO_STATUS: AudioStatus = {
  install: { state: 'not-installed' },
  model: { state: 'unloaded', loaded: null },
  activeJob: null,
  outputDir: '/tmp/data/audios',
  idleUnloadSecs: 600,
}

export const FAKE_LOADED_AUDIO_MODEL: LoadedAudioModel = {
  modelId: 'kokoro-82m:q8_0',
  displayName: 'Kokoro 82M',
  mode: 'speech',
  family: 'kokoro_tts',
  task: 'tts',
  backend: 'metal',
  tag: 'v0.9.3-a1b2c3d4',
  backendId: 'macos-arm64',
  port: 3457,
  pid: 778,
  loadedAtMs: 2,
}

export const FAKE_AUDIO_CAPABILITIES: AudioCapabilities = {
  modelId: 'kokoro-82m:q8_0',
  mode: 'speech',
  family: 'kokoro_tts',
  task: 'tts',
  params: [{ name: 'voice_id', type: 'enum', required: false, default: 'af_heart', values: ['af_heart'] }],
  voices: ['af_heart'],
  supportsVoiceRef: false,
  requiresVoiceRef: false,
}

export const FAKE_AUDIO_ITEM: AudioGalleryItem = {
  id: '0000000000000000000000000000000a',
  path: '/tmp/data/audios/0000000000000000000000000000000a.wav',
  sampleRate: 24000,
  channels: 1,
  audioMs: 500,
  sizeBytes: 24044,
  createdAtMs: 3,
  recipe: {
    jobId: '0000000000000000000000000000000a',
    mode: 'speech',
    text: 'hello',
    voice: 'af_heart',
    voiceRef: false,
    speed: null,
    language: null,
    instruct: null,
    lyrics: null,
    durationSec: null,
    bpm: null,
    seed: 7,
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
    createdAtMs: 3,
    durationMs: 4,
  },
}

export const FAKE_AUDIO_JOB: AudioJob = {
  id: 'ajob-1',
  state: 'queued',
  mode: 'speech',
  modelId: 'kokoro-82m:q8_0',
  request: { text: 'hello' },
  createdAtMs: 5,
  progress: { phase: 'queued', elapsedMs: 0 },
  output: null,
}

export interface FakeAudioControl extends AudioControl {
  /** `getJob` answers `null` for any other id. */
  knownJobId: string
}

export function fakeAudioControl(calls: string[]): FakeAudioControl {
  const note = (call: string) => calls.push(`audio ${call}`)
  const fake: FakeAudioControl = {
    knownJobId: FAKE_AUDIO_JOB.id,
    config: async (config) => {
      note(`config ${JSON.stringify(config)}`)
      return {
        ...FAKE_AUDIO_STATUS,
        idleUnloadSecs: config.idleUnloadSecs ?? FAKE_AUDIO_STATUS.idleUnloadSecs,
      }
    },
    status: async () => FAKE_AUDIO_STATUS,
    setOutputDir: async (path) => {
      note(`setOutputDir ${path}`)
      return { ...FAKE_AUDIO_STATUS, outputDir: path }
    },
    listModelFiles: async () => [
      { path: '/tmp/data/audio/models/kokoro/k.gguf', relativePath: 'kokoro/k.gguf', bytes: 5 },
    ],
    deleteModelFile: async (relativePath) => {
      note(`deleteModelFile ${relativePath}`)
    },
    loadModel: async (request) => {
      note(`loadModel ${request.modelId} ${request.mode}`)
      return { ...FAKE_LOADED_AUDIO_MODEL, modelId: request.modelId }
    },
    unloadModel: async () => {
      note('unloadModel')
    },
    touchIdle: () => note('touchIdle'),
    capabilities: () => FAKE_AUDIO_CAPABILITIES,
    generate: async (mode, request) => {
      note(`generate ${mode} ${request.text}`)
      return { ...FAKE_AUDIO_JOB, mode, request }
    },
    getJob: (id) => (id === fake.knownJobId ? FAKE_AUDIO_JOB : null),
    cancelJob: async (id) => {
      note(`cancelJob ${id}`)
      return { cancelled: true, serverStopped: true }
    },
    gallery: async (options) => {
      note(`gallery ${JSON.stringify(options)}`)
      return { items: [FAKE_AUDIO_ITEM], hasMore: false, total: 1 }
    },
    deleteGalleryItem: async (id) => {
      note(`deleteGalleryItem ${id}`)
    },
  }
  return fake
}
