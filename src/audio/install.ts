/**
 * audio.cpp builds under `<data>/audio/backends/<tag>/<backendId>/`: the install record and its
 * marker, the probe that a tree is audio.cpp and can reach its backend's device, and the listing a
 * load picks its build from. The download, the extraction and the removal of a build are the
 * engine-builds module's, as for sd.cpp (`src/diffusion/install.ts`).
 */

import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AUDIO_BACKENDS } from '../contracts/index.js'
import type { AtomicCoreError, AudioBackend, AudioBackendInstallRecord } from '../contracts/index.js'
import { INSTALL_RECORD, OWNER_MARKER, PROBE_TIMEOUT_MS, runHelpProbe } from '../diffusion/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import { audioError, audioIoError } from './errors.js'

/** What audio.cpp's `--version` prints first, and the line naming the backends the build carries. */
const VERSION_MARKER = 'audio.cpp '
const BACKENDS_LINE = /^backends:\s*(.+)$/m
/** A `--list-devices` line: `MTL:0 "Apple M4 Pro" [GPU]`. */
const DEVICE_LINE = /^\s*([A-Za-z0-9_]+):(\d+)\s+"([^"]*)"\s+\[([A-Z]+)\]\s*$/gm
/** What glibc's `ld.so` and macOS `dyld` print when a library is missing, lowercase. */
const LOADER_MARKERS = ['error while loading shared libraries', 'library not loaded']
/** NTSTATUS codes of a Windows process the loader gave up on before `main`. */
const WINDOWS_LOADER_FAILURES = new Set([0xc000_0135, 0xc000_0138, 0xc000_0139, 0xc000_007b, 0xc000_0142])

export function audioServerBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'audiocpp_server.exe' : 'audiocpp_server'
}

export interface AudioInstallDeps {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  probeTimeoutMs?: number
  spawnRetryDelayMs?: number
  log?: (level: 'info' | 'warn', msg: string) => void
}

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isFile(),
    () => false
  )
const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (s) => s.isDirectory(),
    () => false
  )

/** `install.json` holds the record minus `dir`, which is where the file lives. */
export async function writeAudioInstallRecord(dir: string, record: AudioBackendInstallRecord): Promise<void> {
  const file = {
    tag: record.tag,
    backendId: record.backendId,
    backend: record.backend,
    engine: record.engine,
    sha256: record.sha256,
    installedAtMs: record.installedAtMs,
  }
  await writeFile(join(dir, OWNER_MARKER), 'atomic-chat\n').catch((error: unknown) => {
    throw audioIoError('Could not write the ownership marker.', error)
  })
  await writeFile(join(dir, INSTALL_RECORD), JSON.stringify(file, null, 2)).catch((error: unknown) => {
    throw audioIoError('Could not write the install record.', error)
  })
}

export async function readAudioInstallRecord(dir: string): Promise<AudioBackendInstallRecord | undefined> {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(join(dir, INSTALL_RECORD), 'utf8'))
  } catch {
    return undefined
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const file = raw as Record<string, unknown>
  const sha256 = file['sha256'] ?? null
  const { tag, backendId, backend, engine, installedAtMs } = file
  if (
    typeof tag !== 'string' ||
    typeof backendId !== 'string' ||
    typeof backend !== 'string' ||
    !(AUDIO_BACKENDS as readonly string[]).includes(backend) ||
    engine !== 'audio-cpp' ||
    (sha256 !== null && typeof sha256 !== 'string') ||
    typeof installedAtMs !== 'number' ||
    !Number.isInteger(installedAtMs) ||
    installedAtMs < 0
  )
    return undefined
  return { tag, backendId, backend: backend as AudioBackend, engine, sha256, installedAtMs, dir }
}

/** Every `<root>/<tag>/<backendId>/install.json` with its marker and its server binary, newest install first. */
export async function listInstalledAudioBuilds(
  backendsRoot: string,
  platform: NodeJS.Platform = process.platform
): Promise<AudioBackendInstallRecord[]> {
  const out: AudioBackendInstallRecord[] = []
  for (const tag of await readdir(backendsRoot).catch(() => [] as string[])) {
    const tagPath = join(backendsRoot, tag)
    if (!(await isDirectory(tagPath))) continue
    for (const backend of await readdir(tagPath).catch(() => [] as string[])) {
      const dir = join(tagPath, backend)
      if (!(await isDirectory(dir)) || !(await isFile(join(dir, OWNER_MARKER)))) continue
      const record = await readAudioInstallRecord(dir)
      if (record && (await isFile(join(dir, audioServerBinaryName(platform))))) out.push(record)
    }
  }
  return out.sort((a, b) => b.installedAtMs - a.installedAtMs)
}

/** What `audiocpp_server --version` says about itself; `null` when the output is not audio.cpp's. */
export interface AudioVersionInfo {
  version: string
  backends: string[]
}

export function parseAudioVersion(text: string): AudioVersionInfo | null {
  const first = text.split(/\r?\n/).find((line) => line.startsWith(VERSION_MARKER))
  if (!first) return null
  const backends = BACKENDS_LINE.exec(text)?.[1]
  return {
    version: first.slice(VERSION_MARKER.length).trim(),
    backends: backends
      ? backends
          .split(',')
          .map((name) => name.trim().toLowerCase())
          .filter(Boolean)
      : [],
  }
}

export interface AudioDevice {
  /** `MTL`, `Vulkan`, `CUDA`, `BLAS`, `CPU`, …: ggml's backend registry name. */
  registry: string
  index: number
  name: string
  /** `GPU`, `CPU`, `ACCEL`, `IGPU`. */
  type: string
}

/** The device lines of `audiocpp_server --list-devices` (text; v0.9.3 ignores `--json`). */
export function parseAudioDevices(text: string): AudioDevice[] {
  return [...text.matchAll(DEVICE_LINE)].map((match) => ({
    registry: match[1] ?? '',
    index: Number(match[2]),
    name: match[3] ?? '',
    type: match[4] ?? '',
  }))
}

function loaderFailed(text: string, exit: ExitInfo, platform: NodeJS.Platform): boolean {
  const lower = text.toLowerCase()
  return (
    (platform === 'win32' && exit.code !== null && WINDOWS_LOADER_FAILURES.has(exit.code >>> 0)) ||
    LOADER_MARKERS.some((marker) => lower.includes(marker))
  )
}

const statusOf = (binary: string, exit: ExitInfo): string =>
  exit.code === null
    ? `${binary}: ${exit.signal === null ? 'unknown status' : `signal ${String(exit.signal)}`}`
    : `${binary}: exit code ${exit.code}`

/**
 * The verdict on a finished `--version` run: nothing when the binary is audio.cpp, otherwise the error
 * to raise. A binary the OS loader could not start is a missing runtime, not the wrong program, so the
 * loader's words are read before the output is. The `backends:` line is not checked: a build that
 * loads its GPU backend at run time (the fork's Windows arm64 CUDA build) lists only `cpu` there, so
 * whether a GPU build reaches its device is `--list-devices`' question.
 */
export function audioVersionVerdict(
  binary: string,
  text: string,
  exit: ExitInfo,
  platform: NodeJS.Platform
): AtomicCoreError | undefined {
  const output = [...text].slice(0, 800).join('')
  const status = statusOf(binary, exit)
  if (loaderFailed(text, exit, platform))
    return audioError(
      'ENGINE_INSTALL_FAILED',
      'The audio engine could not load a library it needs.',
      output.trim() === '' ? status : `${status}\n${output}`
    )
  if (parseAudioVersion(text)) return undefined
  if (text.trim() === '')
    return audioError('ENGINE_INSTALL_FAILED', 'The audio engine exited without printing anything.', status)
  return audioError('ENGINE_INSTALL_FAILED', 'The downloaded binary is not audio.cpp.', output)
}

/**
 * The verdict on `--list-devices` for a GPU build: nothing when the engine sees a GPU, otherwise the
 * error that sends the install to the next build of the ladder (a Vulkan build on a machine without
 * a Vulkan driver lists only the CPU). A CPU build always passes.
 */
export function audioDevicesVerdict(
  binary: string,
  text: string,
  exit: ExitInfo,
  platform: NodeJS.Platform,
  backend: AudioBackend
): AtomicCoreError | undefined {
  if (backend === 'cpu') return undefined
  if (loaderFailed(text, exit, platform))
    return audioError(
      'ENGINE_INSTALL_FAILED',
      'The audio engine could not load a library it needs.',
      statusOf(binary, exit)
    )
  const gpus = parseAudioDevices(text).filter((device) => device.type === 'GPU' || device.type === 'IGPU')
  if (gpus.length > 0) return undefined
  return audioError(
    'ENGINE_INSTALL_FAILED',
    `The audio engine found no ${backend} device on this computer.`,
    [...text].slice(-800).join('')
  )
}

async function setExecutable(path: string, deps: AudioInstallDeps): Promise<void> {
  if ((deps.platform ?? process.platform) === 'win32' || !(await isFile(path))) return
  await chmod(path, 0o755).catch((error: unknown) => {
    deps.log?.('warn', `chmod ${path} failed: ${error instanceof Error ? error.message : String(error)}`)
  })
}

/**
 * An unpacked tree made runnable and checked: `audiocpp_server` present and executable, answering
 * `--version` as audio.cpp, and — for a GPU build — listing a GPU.
 * Throws `ENGINE_INSTALL_FAILED` otherwise, which moves the install to the next build of the ladder.
 */
export async function prepareAudiocppTree(
  dir: string,
  backend: AudioBackend,
  deps: AudioInstallDeps = {}
): Promise<void> {
  const platform = deps.platform ?? process.platform
  const server = join(dir, audioServerBinaryName(platform))
  if (!(await isFile(server)))
    throw audioError('ENGINE_INSTALL_FAILED', 'The archive did not contain audiocpp_server.', server)
  await setExecutable(server, deps)
  await setExecutable(join(dir, platform === 'win32' ? 'audiocpp_cli.exe' : 'audiocpp_cli'), deps)
  const started = Date.now()
  const probe = (args: readonly string[]) =>
    runHelpProbe(server, {
      platform,
      timeoutMs: deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS,
      args,
      deps,
      noResponse: `The audio engine did not respond to ${args.join(' ')}.`,
      couldNotStart: 'The audio engine could not be started.',
    })
  try {
    const version = await probe(['--version'])
    const versionFailure = audioVersionVerdict(server, version.text, version.exit, platform)
    if (versionFailure) throw versionFailure
    const devices = backend === 'cpu' ? null : await probe(['--list-devices'])
    const devicesFailure =
      devices && audioDevicesVerdict(server, devices.text, devices.exit, platform, backend)
    if (devicesFailure) throw devicesFailure
    deps.log?.('info', `audio engine probe passed in ${((Date.now() - started) / 1000).toFixed(1)}s`)
  } catch (error) {
    const { message, details } = error as { message: string; details?: string }
    deps.log?.('warn', `audio engine probe failed: ${message} (${details ?? 'no details'})`)
    throw error
  }
}
