/**
 * Live checks of audio generation against a real audio.cpp `audiocpp_server` and a real model (the
 * audio side of `diffusion.test.ts`). The fake engine (`test/helpers/fake-audiocpp-server.mjs`) proves
 * the core's own logic; only the real one proves that the argv and the `server.json` the core writes
 * are accepted, that the model facts the core reads are the ones the loader traces, that the speech
 * and `/v1/tasks/run` bodies it sends are taken, and that the WAV it answers lands in the gallery
 * with its recipe.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_AUDIO_ENGINE=/path/to/dir         (holds audiocpp_server; copied into the temporary data folder)
 *   ATOMIC_LIVE_AUDIO_MODEL=/path/to/model.gguf   (read where it is)
 *   ATOMIC_LIVE_AUDIO_FAMILY=moss_tts_nano        (optional; audio.cpp's family, default moss_tts_nano)
 *   ATOMIC_LIVE_AUDIO_MODE=speech                 (optional; speech, music or effects, default speech)
 *   ATOMIC_LIVE_AUDIO_TASK=tts                    (optional; default the mode's: tts for speech, gen otherwise)
 *   ATOMIC_LIVE_AUDIO_TAG=v0.9.3                  (optional; the build's release tag, default v0.9.3)
 *   ATOMIC_LIVE_AUDIO_BACKEND=cpu                 (optional; every load on the CPU backend, through
 *                                                 ATOMIC_AUDIO_BACKEND, as on CI runners)
 *   ATOMIC_LIVE_AUDIO_MANIFEST=/path/or/https-url (optional; the build is installed through this
 *                                                 conf-shaped manifest, ATOMIC_AUDIOCPP_MANIFEST_URL,
 *                                                 instead of copying the engine folder)
 *   ATOMIC_LIVE_AUDIO_VOICE_REF=/path/to/ref.wav  (a voice to clone, and its transcript in
 *   ATOMIC_LIVE_AUDIO_REFERENCE_TEXT="…"          ATOMIC_LIVE_AUDIO_REFERENCE_TEXT: a speech model that
 *                                                 speaks only in a cloned voice, Qwen3-TTS Base, needs
 *                                                 both, and the generation is skipped without them)
 *
 * Speech says a short sentence; music and effects make 3 s. The long job that is cancelled says a
 * long text, or asks for 120 s. Neither upstream's release builds nor ours carry eSpeak-ng (GPL; ADR
 * 2026-10-29), so a model that phonemizes with it (Kokoro) refuses every speech request
 * ("Could not load eSpeak-ng"); MOSS-TTS-Nano, Qwen3-TTS, Stable Audio and ACE-Step need none.
 *
 * Nothing is written outside the temporary data folder.
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  audioServerBinaryName,
  buildAudioServerArgs,
  parseAudioRecipe,
  parseWav,
  prepareAudiocppTree,
  taskForMode,
  writeAudioInstallRecord,
} from '../../src/audio/index.js'
import { parseAudioHelp } from '../../scripts/lib/audiocpp-surface.mjs'
import { CoreClient } from '../../src/client/index.js'
import { AUDIO_MODES } from '../../src/contracts/index.js'
import type {
  AudioBackend,
  AudioGenerateRequest,
  AudioJob,
  AudioMode,
  CoreEvents,
} from '../../src/contracts/index.js'
import { AtomicCore } from '../../src/core/index.js'
import { audioBackendKindOf } from '../../src/engine-builds/index.js'
import { isProcessAlive } from '../../src/runtime/shared/index.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'

const ENGINE = process.env['ATOMIC_LIVE_AUDIO_ENGINE'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_AUDIO_MODEL'] ?? ''
const FAMILY = process.env['ATOMIC_LIVE_AUDIO_FAMILY'] || 'moss_tts_nano'
const MODE_ENV = process.env['ATOMIC_LIVE_AUDIO_MODE'] || 'speech'
const TASK_ENV = process.env['ATOMIC_LIVE_AUDIO_TASK'] ?? ''
const TAG = process.env['ATOMIC_LIVE_AUDIO_TAG'] || 'v0.9.3'
const BACKEND = process.env['ATOMIC_LIVE_AUDIO_BACKEND'] ?? ''
const MANIFEST = process.env['ATOMIC_LIVE_AUDIO_MANIFEST'] ?? ''
const VOICE_REF = process.env['ATOMIC_LIVE_AUDIO_VOICE_REF'] ?? ''
const REFERENCE_TEXT = process.env['ATOMIC_LIVE_AUDIO_REFERENCE_TEXT'] ?? ''
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && ENGINE !== '' && MODEL !== ''

const MODE = MODE_ENV as AudioMode
const TASK = TASK_ENV || ((AUDIO_MODES as readonly string[]).includes(MODE_ENV) ? taskForMode(MODE) : '')
const MODEL_ID = `${FAMILY}:live`
/** The env the core runs with: the manifest and the backend override when they are asked for. */
const CORE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  ...(BACKEND ? { ATOMIC_AUDIO_BACKEND: BACKEND } : {}),
  ...(MANIFEST
    ? {
        ATOMIC_AUDIOCPP_MANIFEST_URL: /^https?:\/\//.test(MANIFEST) ? MANIFEST : pathToFileURL(MANIFEST).href,
      }
    : {}),
}

/** What one quick job asks for, per mode. */
const SHORT: Readonly<Record<AudioMode, AudioGenerateRequest>> = {
  speech: { text: 'The quick brown fox jumps over the lazy dog.' },
  music: { text: 'a calm lo-fi piano loop with soft drums', durationSec: 3 },
  effects: { text: 'rain falling on a tin roof', durationSec: 3 },
}
const PARAGRAPH =
  'The lighthouse keeper climbed the spiral stairs every evening, counting each step aloud. ' +
  'Far below, the sea rolled against the rocks and the gulls settled into their nests. ' +
  'He trimmed the wick, polished the great lens and wrote the weather into his book. ' +
  'Ships passed in the dark, and each one blinked its lamp to say that it had seen him. '
/** What a job long enough to be cancelled while the engine generates asks for, per mode. */
const LONG: Readonly<Record<AudioMode, AudioGenerateRequest>> = {
  speech: { text: PARAGRAPH.repeat(5).trim() },
  music: { text: 'an epic orchestral score with choir and timpani', durationSec: 120 },
  effects: { text: 'a thunderstorm over a forest, heavy rain and distant thunder', durationSec: 120 },
}
/** Contract log text (test/fixtures/audiocpp/engine-contract.json `strings`) every load prints. */
const EVERY_LOAD = [
  'ready.listening-on',
  'load.phase',
  'load.server-progress',
  'model.variant',
  'model.supports-speaker-reference',
]
const TERMINAL = ['completed', 'failed', 'cancelled']

interface ContractStrings {
  routes: Array<{ method: string; path: string }>
  strings: Array<{ id: string; text: string; channel: string }>
}

const readContract = async () =>
  JSON.parse(
    await readFile(new URL('../fixtures/audiocpp/engine-contract.json', import.meta.url), 'utf8')
  ) as ContractStrings

/** The backend id the host's CPU archive installs under (macOS has one archive, a Metal build). */
function hostBackendId(platform: NodeJS.Platform, arch: string): string {
  const cpu = arch === 'arm64' ? 'arm64' : 'x64'
  if (platform === 'darwin') return `macos-${cpu}`
  return platform === 'win32' ? `win-cpu-${cpu}` : `linux-cpu-${cpu}`
}

let data: TmpDataFolder
let core: AtomicCore
let client: CoreClient
const events: Array<{ name: string; payload: unknown }> = []
/** Every line `audiocpp_server` printed, for the life of the core. */
const output: string[] = []

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function untilJob(id: string, states: string[], timeoutMs: number, everyMs = 200): Promise<AudioJob> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const job = await client.audioJob(id)
    if (job && states.includes(job.state)) return job
    if (Date.now() > deadline) throw new Error(`audio job ${id} is still ${job?.state ?? 'missing'}`)
    await sleep(everyMs)
  }
}

/** The phases an `audio:job` event showed for job `id`, in order, each once. */
function phasesOf(id: string): string[] {
  const phases: string[] = []
  for (const e of events) {
    if (e.name !== 'audio:job') continue
    const job = (e.payload as CoreEvents['audio:job']).job
    const phase = job.progress?.phase
    if (job.id === id && phase !== undefined && phases.at(-1) !== phase) phases.push(phase)
  }
  return phases
}

/** Why a job failed, with a hint for a model that needs eSpeak-ng, which no build we run carries. */
function failure(job: AudioJob): string {
  const text = JSON.stringify(job.error ?? null)
  return /espeak/i.test(text)
    ? `${text} — this model phonemizes with eSpeak-ng, which audio.cpp builds here do not carry: pick a model that needs none (MOSS-TTS-Nano, Qwen3-TTS)`
    : text
}

describe.skipIf(!ENABLED)('a real audio.cpp engine', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-audio-')
    core = await AtomicCore.create({
      dataFolder: data.root,
      controlPort: 0,
      env: CORE_ENV,
      backendOutput: ({ provider, line }) => {
        if (provider === 'audio-cpp') output.push(line)
      },
    })
    client = new CoreClient({ baseUrl: core.control.url, token: core.controlToken })
    for (const name of ['audio:state', 'audio:job', 'audio:error'] as const)
      core.events.on(name, (payload) => events.push({ name, payload }))
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('answers --help with every flag the core passes', async () => {
    const help = spawnSync(join(ENGINE, audioServerBinaryName(process.platform)), ['--help'], {
      cwd: ENGINE,
      encoding: 'utf8',
      timeout: 120_000,
    })
    expect(help.status, `${help.error?.message ?? ''}${help.stderr}`).toBe(0)
    const parsed = parseAudioHelp(`${help.stdout}${help.stderr}`)
    // Every flag the argv builder can emit (the thread count included), as whole tokens. The contract
    // names exactly these (test/contract/audiocpp-engine-contract.test.ts).
    const passed = [
      ...new Set(buildAudioServerArgs('/run/server.json', 8080, 'cpu', 2).filter((a) => a.startsWith('--'))),
    ]
    expect(passed).toContain('--load-progress')
    expect(
      passed.filter((flag) => !parsed.flags.includes(flag)),
      'flags the build does not know'
    ).toEqual([])
    // And every route the core calls, under `Endpoints:` with its method.
    const contract = await readContract()
    const listed = parsed.routes.map((r) => `${r.method} ${r.path}`)
    expect(
      contract.routes.map((r) => `${r.method} ${r.path}`).filter((route) => !listed.includes(route)),
      'routes the build does not list'
    ).toEqual([])
  }, 130_000)

  it(
    'installs the tree, loads the model, generates, cancels and unloads',
    async (ctx) => {
      expect(AUDIO_MODES, 'ATOMIC_LIVE_AUDIO_MODE is speech, music or effects').toContain(MODE_ENV)

      // The build: through the manifest the way a user gets it, or the engine folder put in place the
      // way the engine-builds install leaves an unpacked archive (the real probe, the marker, the record).
      let tag = TAG
      let backendId = hostBackendId(process.platform, process.arch)
      if (MANIFEST !== '') {
        const catalog = await client.engineBuildCatalog('audio-cpp', { force: true })
        expect(catalog.manifest_error).toBeNull()
        const result = await client.installEngineBuild('audio-cpp', { task_id: 'live-audio' })
        expect(result).toMatchObject({ installed: true })
        tag = result.build?.tag as string
        backendId = result.build?.backend_id as string
      } else {
        const backend = audioBackendKindOf(backendId) as AudioBackend
        const dir = join(data.layout.audio.backendsDir, tag, backendId)
        await mkdir(dir, { recursive: true })
        await cp(ENGINE, dir, { recursive: true })
        await prepareAudiocppTree(dir, backend)
        await writeAudioInstallRecord(dir, {
          tag,
          backendId,
          backend,
          engine: 'audio-cpp',
          sha256: null,
          installedAtMs: Date.now(),
          dir,
        })
      }
      const buildBackend = audioBackendKindOf(backendId) as AudioBackend
      const backend: AudioBackend = BACKEND.trim().toLowerCase() === 'cpu' ? 'cpu' : buildBackend
      expect((await client.engineBuildCatalog('audio-cpp')).installed.map((b) => b.backend_id)).toEqual([
        backendId,
      ])
      expect((await client.audioStatus()).install).toMatchObject({
        state: 'installed',
        backend: buildBackend,
        tag,
        backendId,
      })

      // The model, served as the env names it; the engine's idle unload stays out of the way.
      await client.configureAudio({ idleUnloadSecs: 0 })
      let started = Date.now()
      const loaded = await client.loadAudioModel({
        modelId: MODEL_ID,
        displayName: 'Live audio model',
        mode: MODE,
        file: MODEL,
        family: FAMILY,
        task: TASK as 'tts' | 'gen',
        startupTimeoutSecs: 600,
      })
      const loadMs = Date.now() - started
      expect(loaded).toMatchObject({
        modelId: MODEL_ID,
        mode: MODE,
        family: FAMILY,
        task: TASK,
        backend,
        tag,
      })
      expect(isProcessAlive(loaded.pid)).toBe(true)

      // What the engine declared, and the load lines the contract lists, as the real build prints them.
      const capabilities = await client.audioCapabilities()
      expect(capabilities).toMatchObject({ modelId: MODEL_ID, mode: MODE, family: FAMILY, task: TASK })
      expect(capabilities.params.length).toBeGreaterThan(0)
      if (MODE !== 'speech') expect(capabilities.params.map((p) => p.name)).toContain('duration_sec')
      if (capabilities.requiresVoiceRef) expect(capabilities.voices).toEqual([])
      const contract = await readContract()
      const everyLoad = contract.strings.filter((s) => s.channel === 'log' && EVERY_LOAD.includes(s.id))
      expect(everyLoad.map((s) => s.id).sort()).toEqual([...EVERY_LOAD].sort())
      expect(
        everyLoad
          .filter((s) => !output.some((line) => line.toLowerCase().includes(s.text.toLowerCase())))
          .map((s) => s.text),
        'log text of the contract the load did not print'
      ).toEqual([])
      console.log(
        'live audio capabilities',
        JSON.stringify({
          ...capabilities,
          params: capabilities.params.map((p) => p.name),
          voices: capabilities.voices.length,
        })
      )

      // A model that speaks only in a cloned voice needs one; the core refuses a job without it.
      const clone =
        MODE === 'speech' && capabilities.supportsVoiceRef && VOICE_REF !== '' && REFERENCE_TEXT !== ''
      if (capabilities.requiresVoiceRef && !clone) {
        await client.unloadAudioModel()
        ctx.skip(
          `${FAMILY} speaks only in a cloned voice: set ATOMIC_LIVE_AUDIO_VOICE_REF (a WAV) and ` +
            'ATOMIC_LIVE_AUDIO_REFERENCE_TEXT (its transcript) to run its jobs'
        )
      }
      if (capabilities.requiresVoiceRef)
        await expect(client.generateAudio('speech', { text: 'No voice given.' })).rejects.toMatchObject({
          code: 'INVALID_REQUEST',
        })
      const ask = (request: AudioGenerateRequest, seed: number): AudioGenerateRequest => ({
        ...request,
        seed,
        ...(clone ? { voiceRef: { path: VOICE_REF }, referenceText: REFERENCE_TEXT } : {}),
      })

      // One quick job: the WAV, its recipe beside it, the gallery, the phases.
      const first = await client.generateAudio(MODE, ask(SHORT[MODE], 7))
      const done = await untilJob(first.id, TERMINAL, 30 * 60_000)
      expect(done.state, failure(done)).toBe('completed')
      const clip = done.output as NonNullable<AudioJob['output']>
      const bytes = await readFile(clip.path)
      expect(bytes.length).toBe(clip.sizeBytes)
      expect(parseWav(bytes)).toMatchObject({
        sampleRate: clip.sampleRate,
        channels: clip.channels,
        audioMs: clip.audioMs,
      })
      expect(clip.audioMs).toBeGreaterThan(MODE === 'speech' ? 500 : 2_000)
      expect(parseAudioRecipe(await readFile(clip.path.replace(/\.wav$/, '.json'), 'utf8'))).toEqual(
        clip.recipe
      )
      expect(clip.recipe).toMatchObject({
        jobId: first.id,
        mode: MODE,
        text: SHORT[MODE].text,
        seed: 7,
        voiceRef: clone,
        durationSec: MODE === 'speech' ? null : 3,
        model: { modelId: MODEL_ID, family: FAMILY, task: TASK, filename: basename(MODEL) },
        engine: { kind: 'audio-cpp', backend, tag },
      })
      const page = await client.audioGallery({ offset: 0, limit: 10 })
      expect(page.total).toBe(1)
      expect(page.items[0]).toMatchObject({ id: clip.id, path: clip.path, recipe: clip.recipe })
      expect(phasesOf(first.id)).toEqual(expect.arrayContaining(['queued', 'generating', 'saving']))
      expect(events.filter((e) => e.name === 'audio:error')).toEqual([])

      // A long job cancelled while the engine generates: audio.cpp cannot interrupt a request, so the
      // server is stopped and the spec kept.
      const long = await client.generateAudio(MODE, ask(LONG[MODE], 8))
      const generating = await untilJob(long.id, ['generating', ...TERMINAL], 10 * 60_000, 50)
      expect(generating.state, failure(generating)).toBe('generating')
      await sleep(500)
      const cancelAt = Date.now()
      const cancelled = await client.cancelAudioJob(long.id)
      const cancelMs = Date.now() - cancelAt
      expect(cancelled).toEqual({ cancelled: true, serverStopped: true })
      expect((await client.audioJob(long.id))?.state).toBe('cancelled')
      expect(isProcessAlive(loaded.pid)).toBe(false)
      expect((await client.audioStatus()).model.state).toBe('unloaded')

      // The next job brings the server back from the kept spec.
      const again = await client.generateAudio(MODE, ask(SHORT[MODE], 9))
      const respawned = await untilJob(again.id, TERMINAL, 30 * 60_000)
      expect(respawned.state, failure(respawned)).toBe('completed')
      expect(phasesOf(again.id)).toContain('loading')
      const status = await client.audioStatus()
      expect(status.model.state).toBe('loaded')
      const pid = status.model.loaded?.pid as number
      expect(pid).not.toBe(loaded.pid)
      expect(isProcessAlive(pid)).toBe(true)
      expect((await client.audioGallery({ offset: 0, limit: 10 })).total).toBe(2)
      expect(events.filter((e) => e.name === 'audio:error')).toEqual([])

      started = Date.now()
      await client.unloadAudioModel()
      const unloadMs = Date.now() - started
      expect(isProcessAlive(pid)).toBe(false)
      expect((await client.audioStatus()).model.state).toBe('unloaded')

      const again2 = respawned.output as NonNullable<AudioJob['output']>
      console.log(
        'live audio run',
        JSON.stringify({
          family: FAMILY,
          mode: MODE,
          backend,
          tag,
          backendId,
          loadMs,
          first: {
            jobMs: (done.finishedAtMs ?? 0) - done.createdAtMs,
            engineMs: clip.recipe.durationMs,
            audioMs: clip.audioMs,
            sampleRate: clip.sampleRate,
            channels: clip.channels,
          },
          cancel: { afterGeneratingMs: cancelAt - (generating.startedAtMs ?? cancelAt), cancelMs },
          respawn: {
            jobMs: (respawned.finishedAtMs ?? 0) - respawned.createdAtMs,
            engineMs: again2.recipe.durationMs,
            audioMs: again2.audioMs,
          },
          unloadMs,
        })
      )
    },
    45 * 60_000
  )
})
