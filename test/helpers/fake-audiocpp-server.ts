/**
 * Wiring for `fake-audiocpp-server.mjs`: an audio.cpp build tree under
 * `<data>/audio/backends/<tag>/<backendId>/` whose `audiocpp_server` is a launcher of the fake, so a
 * core that lists and spawns a build the ordinary way gets the fake one. The engine-builds install is
 * not involved: the tree is written with the marker and record names the core reads.
 *
 * Nothing here imports from `src/`, so the compiled-binary e2e can use it too. POSIX only: the
 * launchers are `#!/bin/sh` scripts.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FAKE_AUDIO_SCRIPT = fileURLToPath(new URL('./fake-audiocpp-server.mjs', import.meta.url))
export const CAN_INSTALL_FAKE_AUDIO = process.platform !== 'win32'
/** The rebuild tag the fake builds are installed under by default. */
export const FAKE_AUDIO_TAG = 'v0.9.3-a1b2c3d4'
export const FAKE_AUDIO_BACKEND_ID = 'fake-cpu'

export type FakeAudioMode =
  'ok' | 'slow' | 'crash-mid-job' | 'load-fail' | 'oom' | 'reject' | 'foreign-listener'

export interface FakeAudioOptions {
  mode?: FakeAudioMode
  /** The mode applies only to the first process that creates this file; later ones run `ok`. */
  onceMarker?: string
  /** Milliseconds before the port is bound. */
  loadMs?: number
  /** Milliseconds a generation takes. */
  genMs?: number
  /** Milliseconds a generation takes in `slow`. */
  slowMs?: number
  rejectMessage?: string
  variant?: string
  pidFile?: string
  argvFile?: string
  envFile?: string
  bodyFile?: string
}

export function fakeAudioEnv(options: FakeAudioOptions): Record<string, string> {
  const env: Record<string, string> = { FAKE_AUDIO_MODE: options.mode ?? 'ok' }
  if (options.onceMarker) env['FAKE_AUDIO_ONCE_MARKER'] = options.onceMarker
  if (options.loadMs !== undefined) env['FAKE_AUDIO_LOAD_MS'] = String(options.loadMs)
  if (options.genMs !== undefined) env['FAKE_AUDIO_GEN_MS'] = String(options.genMs)
  if (options.slowMs !== undefined) env['FAKE_AUDIO_SLOW_MS'] = String(options.slowMs)
  if (options.rejectMessage !== undefined) env['FAKE_AUDIO_REJECT_MESSAGE'] = options.rejectMessage
  if (options.variant !== undefined) env['FAKE_AUDIO_VARIANT'] = options.variant
  if (options.pidFile) env['FAKE_AUDIO_PID_FILE'] = options.pidFile
  if (options.argvFile) env['FAKE_AUDIO_ARGV_FILE'] = options.argvFile
  if (options.envFile) env['FAKE_AUDIO_ENV_FILE'] = options.envFile
  if (options.bodyFile) env['FAKE_AUDIO_BODY_FILE'] = options.bodyFile
  return env
}

/**
 * Write the `audiocpp_server` launcher into `dir` (created), with the fake's options baked into its
 * environment. Rewriting it changes what the next spawn runs, so one core can play several modes.
 */
export async function writeFakeAudioLaunchers(dir: string, options: FakeAudioOptions = {}): Promise<void> {
  await mkdir(dir, { recursive: true })
  const exports = Object.entries(fakeAudioEnv(options))
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  const path = join(dir, 'audiocpp_server')
  await writeFile(
    path,
    `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_AUDIO_SCRIPT)} "$@"\n`
  )
  await chmod(path, 0o755)
}

export interface FakeAudioEngine {
  dir: string
  tag: string
  backendId: string
}

/** An installed, owned build tree (marker and record included) under `dataFolder` whose server is the fake. */
export async function installFakeAudioEngine(
  dataFolder: string,
  options: FakeAudioOptions & {
    tag?: string
    backendId?: string
    backend?: string
    installedAtMs?: number
  } = {}
): Promise<FakeAudioEngine> {
  const tag = options.tag ?? FAKE_AUDIO_TAG
  const backendId = options.backendId ?? FAKE_AUDIO_BACKEND_ID
  const dir = join(dataFolder, 'audio', 'backends', tag, backendId)
  await writeFakeAudioLaunchers(dir, options)
  await writeFile(join(dir, '.atomic-owned'), 'atomic-chat\n')
  await writeFile(
    join(dir, 'install.json'),
    JSON.stringify(
      {
        tag,
        backendId,
        backend: options.backend ?? 'cpu',
        engine: 'audio-cpp',
        sha256: null,
        installedAtMs: options.installedAtMs ?? Date.now(),
      },
      null,
      2
    )
  )
  return { dir, tag, backendId }
}

/** A model file under `<data>/audio/models` the load can name; the fake never reads it. */
export async function writeFakeAudioModel(
  dataFolder: string,
  relative = 'kokoro/kokoro-82m-q8_0.gguf'
): Promise<string> {
  const path = join(dataFolder, 'audio', 'models', ...relative.split('/'))
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, 'GGUF fake')
  return path
}
