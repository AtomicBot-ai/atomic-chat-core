/**
 * Shared shapes for the audio module's unit tests: a spec, a WAV, a server handle that is not a
 * process.
 */
import type { AudioCapabilities } from '../../src/contracts/index.js'
import type { AudioServerHandle, AudioServerSpec } from '../../src/audio/index.js'
import type { ExitInfo } from '../../src/runtime/llamacpp/index.js'

export function sampleAudioSpec(over: Partial<AudioServerSpec> = {}): AudioServerSpec {
  return {
    binaryDir: '/data/audio/backends/v0.9.3-a1b2c3d4/macos-arm64',
    backend: 'metal',
    buildBackend: 'metal',
    backendId: 'macos-arm64',
    tag: 'v0.9.3-a1b2c3d4',
    modelId: 'kokoro-82m:q8_0',
    displayName: 'Kokoro 82M',
    mode: 'speech',
    family: 'kokoro_tts',
    task: 'tts',
    modelPath: '/data/audio/models/kokoro/kokoro-82m-q8_0.gguf',
    startupTimeoutMs: 10_000,
    ...over,
  }
}

/** A 16-bit PCM WAV of `seconds` of silence. */
export function sampleWav(sampleRate = 24000, channels = 1, seconds = 0.5): Buffer {
  const data = Buffer.alloc(Math.round(sampleRate * seconds) * channels * 2)
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'latin1')
  head.writeUInt32LE(36 + data.length, 4)
  head.write('WAVE', 8, 'latin1')
  head.write('fmt ', 12, 'latin1')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(channels, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * channels * 2, 28)
  head.writeUInt16LE(channels * 2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'latin1')
  head.writeUInt32LE(data.length, 40)
  return Buffer.concat([head, data])
}

export function sampleCapabilities(
  spec: AudioServerSpec,
  over: Partial<AudioCapabilities> = {}
): AudioCapabilities {
  return {
    modelId: spec.modelId,
    mode: spec.mode,
    family: spec.family,
    task: spec.task,
    params: [{ name: 'seed', type: 'int', required: false }],
    voices: [],
    supportsVoiceRef: false,
    requiresVoiceRef: false,
    ...over,
  }
}

/** A server handle whose process is a promise: `die` ends it, `terminate` ends it with SIGTERM. */
export interface FakeHandle extends AudioServerHandle {
  die(exit?: ExitInfo, lines?: string[]): void
  terminated: number
}

let nextPid = 40_000

export function fakeHandle(spec: AudioServerSpec, over: Partial<AudioServerHandle> = {}): FakeHandle {
  let exit: ExitInfo | undefined
  let resolveExit!: (exit: ExitInfo) => void
  const exited = new Promise<ExitInfo>((resolve) => (resolveExit = resolve))
  const tail: string[] = []
  const handle: FakeHandle = {
    pid: nextPid++,
    port: 3900,
    exe: `${spec.binaryDir}/audiocpp_server`,
    capabilities: sampleCapabilities(spec),
    tail: () => [...tail],
    exitStatus: () => exit,
    exited,
    terminated: 0,
    terminate: async () => {
      handle.terminated += 1
      handle.die({ code: null, signal: 'SIGTERM' })
      return exited
    },
    die: (info = { code: 134, signal: null }, lines = []) => {
      if (exit) return
      tail.push(...lines)
      exit = info
      resolveExit(info)
    },
    ...over,
  }
  return handle
}

/** What a scripted engine answers a generation request with; `undefined` takes the default answer. */
export type AudioReply = (
  url: string,
  body: Record<string, unknown>,
  options: { timeoutMs: number; signal?: AbortSignal }
) => Promise<{ status: number; contentType: string; body: Buffer } | undefined>

/** An engine that answers over no socket: GETs as a ready server, POSTs through `reply`. */
export function scriptedHttp(reply: { current?: AudioReply | undefined } = {}) {
  const posts: Array<{ url: string; body: Record<string, unknown> }> = []
  return {
    posts,
    reply,
    get: async () => ({ status: 200, contentType: 'application/json', body: Buffer.from('{}') }),
    post: async (url: string, json: unknown, options: { timeoutMs: number; signal?: AbortSignal }) => {
      const body = json as Record<string, unknown>
      posts.push({ url, body })
      const custom = await reply.current?.(url, body, options)
      if (custom) return custom
      if (url.endsWith('/v1/audio/speech'))
        return { status: 200, contentType: 'audio/wav', body: sampleWav(24000, 1, 0.25) }
      const audio = sampleWav(44100, 2, 0.5).toString('base64')
      return {
        status: 200,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify({ audio, named_audio_outputs: [{ id: 7, audio }] })),
      }
    },
  }
}

/** A reply that waits until the caller aborts, as audio.cpp does while it generates. */
export const hangUntilAborted: AudioReply = (_url, _body, options) =>
  new Promise((_resolve, reject) => {
    const abort = () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))
    if (options.signal?.aborted) abort()
    options.signal?.addEventListener('abort', abort, { once: true })
  })
