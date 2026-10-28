/**
 * The core's side of the `geniex-host` protocol (openspec change `add-geniex-runtime`, design D1):
 * the host is this very binary in a hidden mode, started with `process.execPath`, so a crash of
 * Qualcomm's native library never takes the core down. `probe` opens the library of one build and
 * prints one JSON line: its version, our ABI number, the plugins and the devices it found;
 * `inspect <path>` prints what a GGUF file or an AI Hub bundle says about itself.
 */

import { spawn } from 'node:child_process'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ErrorCode, GeniexModelMetadata } from '../../contracts/index.js'
import type { EngineProbeFacts } from '../../engine-builds/engines.js'

/** How to start `geniex-host`: `[execPath, script?]` + `geniex-host`, or a test stand-in. */
export interface GeniexHostCommand {
  exe: string
  args: string[]
}

/** A program that speaks `geniex-host` in place of this binary: the e2e tests' stand-in. */
export const GENIEX_HOST_TEST_COMMAND_ENV = 'ATOMIC_GENIEX_HOST_TEST_COMMAND'

export function geniexHostCommand(
  env: Record<string, string | undefined>,
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath
): GeniexHostCommand {
  const stand = env[GENIEX_HOST_TEST_COMMAND_ENV]?.trim()
  if (stand) return { exe: stand, args: [] }
  const script = argv[1]
  const viaRuntime = script !== undefined && /\.(c|m)?[jt]s$/.test(script)
  return { exe: execPath, args: [...(viaRuntime ? [script] : []), 'geniex-host'] }
}

export interface GeniexHostProbeResult {
  /** `geniex_version()`; `null` where the host cannot read it. */
  version: string | null
  /** The ABI number of this host's binding. */
  abi: number
  /** `geniex_get_plugin_list`: `llama_cpp`, `qairt`. */
  plugins: string[]
  /** `geniex_get_device_list` of the `llama_cpp` plugin: `HTP0`, `GPUOpenCL`, `CPU`, … */
  devices: string[]
}

/** The first run of a freshly unpacked library is scanned by Defender; QAIRT loads on first use. */
export const GENIEX_HOST_PROBE_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : null

function parseProbe(raw: unknown): GeniexHostProbeResult | null {
  if (!isRecord(raw)) return null
  const { version, abi } = raw
  const plugins = strings(raw['plugins'])
  const devices = strings(raw['devices'])
  if (typeof abi !== 'number' || !plugins || !devices) return null
  return { version: typeof version === 'string' ? version : null, abi, plugins, devices }
}

export interface GeniexHostRunOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Run one short `geniex-host` mode and read the last JSON line it prints that `parse` accepts.
 * Throws `code` with what the host printed when it exits non-zero, prints no answer or does not
 * answer in time.
 */
export function runGeniexHostJson<T>(
  command: GeniexHostCommand,
  args: string[],
  parse: (raw: unknown) => T | null,
  failure: { code: ErrorCode; what: string },
  options: GeniexHostRunOptions = {}
): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(command.exe, [...command.args, ...args], {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const keep = (buffer: string, chunk: Buffer) => (buffer + chunk.toString('utf8')).slice(-OUTPUT_LIMIT)
    child.stdout.on('data', (chunk: Buffer) => (stdout = keep(stdout, chunk)))
    child.stderr.on('data', (chunk: Buffer) => (stderr = keep(stderr, chunk)))
    const timeoutMs = options.timeoutMs ?? GENIEX_HOST_PROBE_TIMEOUT_MS
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new AtomicCoreError(
          failure.code,
          `${failure.what}: the GenieX host did not answer.`,
          `${args.join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s`
        )
      )
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(
        new AtomicCoreError(
          failure.code,
          `${failure.what}: the GenieX host could not be started.`,
          String(error)
        )
      )
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const answer = stdout
        .split(/\r?\n/)
        .reverse()
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return parse(JSON.parse(line))
          } catch {
            return null
          }
        })
        .find((parsed) => parsed !== null)
      if (code === 0 && answer != null) return resolve(answer)
      const status = code !== null ? `exit code ${code}` : `signal ${String(signal)}`
      reject(
        new AtomicCoreError(
          failure.code,
          `${failure.what}: the GenieX host failed (${status}).`,
          (stderr.trim() || stdout.trim() || status).slice(-4096)
        )
      )
    })
  })
}

/** `geniex-host probe --lib <buildDir>`: the build's library loads in this core's host, and what it sees. */
export function runGeniexHostProbe(
  command: GeniexHostCommand,
  buildDir: string,
  options: GeniexHostRunOptions = {}
): Promise<GeniexHostProbeResult> {
  return runGeniexHostJson(
    command,
    ['probe', '--lib', buildDir],
    parseProbe,
    { code: 'ENGINE_INSTALL_FAILED', what: 'The GenieX build does not load' },
    options
  )
}

function parseInspect(raw: unknown): GeniexModelMetadata | null {
  if (!isRecord(raw) || (raw['kind'] !== 'gguf' && raw['kind'] !== 'qairt')) return null
  return raw as unknown as GeniexModelMetadata
}

/** `geniex-host inspect <path>`: a GGUF file's or a bundle's metadata, read without a model. */
export function runGeniexHostInspect(
  command: GeniexHostCommand,
  path: string,
  options: GeniexHostRunOptions = {}
): Promise<GeniexModelMetadata> {
  return runGeniexHostJson(
    command,
    ['inspect', path],
    parseInspect,
    { code: 'GENIEX_HOST_ERROR', what: 'The GenieX model cannot be read' },
    options
  )
}

/** The engine-builds probe of a GenieX build: `geniex-host probe`, its devices and version kept. */
export function geniexHostProber(
  command: GeniexHostCommand,
  env: NodeJS.ProcessEnv
): (buildDir: string) => Promise<EngineProbeFacts> {
  return async (buildDir) => {
    const answer = await runGeniexHostProbe(command, buildDir, { env })
    return { libraryVersion: answer.version, devices: answer.devices }
  }
}
