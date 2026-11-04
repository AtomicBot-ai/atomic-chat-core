/**
 * `audiocpp_server`'s command line and environment. Pure.
 *
 * `--backend` is always passed (audio.cpp defaults to `cuda`, which a Metal or Vulkan build does not
 * carry) and so is `--no-ui` (the embedded WebUI is on by default once a config is given). `--log` and
 * `--load-progress 1` make the server print the model facts and the load phases the core reads.
 */

import type { AudioBackend } from '../contracts/index.js'

/** `ATOMIC_AUDIO_BACKEND=cpu` runs every build on its CPU backend (a device backend that misbehaves). */
export const AUDIO_BACKEND_ENV = 'ATOMIC_AUDIO_BACKEND'

/** The backend a build runs on: its own, unless the environment forces the CPU. */
export function resolveAudioBackend(buildBackend: AudioBackend, env: NodeJS.ProcessEnv): AudioBackend {
  return env[AUDIO_BACKEND_ENV]?.trim().toLowerCase() === 'cpu' ? 'cpu' : buildBackend
}

export function buildAudioServerArgs(
  configFile: string,
  port: number,
  backend: AudioBackend,
  threads?: number
): string[] {
  return [
    '--config',
    configFile,
    '--no-ui',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--backend',
    backend,
    '--log',
    '--load-progress',
    '1',
    ...(threads !== undefined && threads > 0 ? ['--threads', String(threads)] : []),
  ]
}

/**
 * What the child gets on top of the core's environment: audio.cpp unpacks each GGUF package's configs
 * and tokenizer under `$TMPDIR/audiocpp-gguf/` (~37 MB a model), so its temporary folder is the
 * core's own `<data>/audio/tmp` rather than the system's.
 */
export function audioChildEnv(platform: NodeJS.Platform, tmpDir: string): Record<string, string> {
  return platform === 'win32' ? { TMPDIR: tmpDir, TEMP: tmpDir, TMP: tmpDir } : { TMPDIR: tmpDir }
}
