/**
 * Video input needs `ffmpeg`: llama.cpp's mtmd helper decodes a clip by starting `ffmpeg` from PATH
 * (`mtmd_helper_video_init`). Nothing bundles it, so the embedding process gets it only when the
 * user has one. An app started from the Finder inherits a bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`)
 * that misses Homebrew's, so the usual install folders are searched as well and the one holding
 * `ffmpeg` is put on the process's PATH. Without it the module does not offer video at all
 * (`EmbeddingStatus.modalities`), and a clip is refused with a 400 that says why.
 */

import { stat } from 'node:fs/promises'
import { posix, win32 } from 'node:path'

/** Where installers put `ffmpeg` outside a login shell's PATH, per platform. */
export const FFMPEG_EXTRA_DIRS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'],
  linux: ['/usr/local/bin', '/usr/bin', '/snap/bin'],
}

/**
 * The key of `env`'s PATH: `PATH` itself when there is one (as `buildProcessEnv` reads it on
 * Windows too), else the first spelling of it (Windows keeps `Path`).
 */
function pathKey(env: NodeJS.ProcessEnv): string | undefined {
  if (env['PATH'] !== undefined) return 'PATH'
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH')
}

/** The PATH variable of `env`, whatever its case (Windows spells it `Path`). */
export function pathOf(env: NodeJS.ProcessEnv): string {
  const key = pathKey(env)
  return (key !== undefined ? env[key] : undefined) ?? ''
}

/** The folders to look for `ffmpeg` in: PATH first, then the platform's usual ones, once each. Pure. */
export function ffmpegSearchDirs(platform: NodeJS.Platform, pathValue: string): string[] {
  const separator = platform === 'win32' ? ';' : ':'
  const dirs = [...pathValue.split(separator), ...(FFMPEG_EXTRA_DIRS[platform] ?? [])]
  const seen = new Set<string>()
  return dirs.filter((dir) => {
    const key = platform === 'win32' ? dir.toLowerCase() : dir
    if (dir.trim() === '' || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** `env` with `dir` in front of its PATH (in the key the environment already uses). Pure. */
export function withPathDir(
  env: NodeJS.ProcessEnv,
  dir: string,
  platform: NodeJS.Platform
): NodeJS.ProcessEnv {
  const separator = platform === 'win32' ? ';' : ':'
  const key = pathKey(env) ?? 'PATH'
  const current = env[key] ?? ''
  if (current.split(separator).includes(dir)) return env
  return { ...env, [key]: current === '' ? dir : `${dir}${separator}${current}` }
}

const defaultIsFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )

/** The folder holding `ffmpeg`, or `undefined` when there is none to be found. */
export async function findFfmpegDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => Promise<boolean> = defaultIsFile
): Promise<string | undefined> {
  const exe = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  // The platform's own separator, not the host's: a Linux path checked on a Windows host stays `/`.
  const joinIn = platform === 'win32' ? win32.join : posix.join
  for (const dir of ffmpegSearchDirs(platform, pathOf(env))) if (await isFile(joinIn(dir, exe))) return dir
  return undefined
}
