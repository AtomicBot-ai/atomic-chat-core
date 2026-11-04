/**
 * The core's side of the `litert-host` protocol (openspec change `add-litert-lm-runtime`, design D1):
 * the host is this very binary in a hidden mode, started with `process.execPath`, so a crash of
 * Google's native library never takes the core down. `probe` opens the library of one build and
 * prints one JSON line: its version, our ABI number and the backends it was built with.
 */

import { spawn } from 'node:child_process'
import { AtomicCoreError } from '../../contracts/index.js'
import type { ErrorCode } from '../../contracts/index.js'
import type { LiteRtFileInfo } from './host/library.js'

/** How to start `litert-host`: `[execPath, script?]` + `litert-host`, or a test stand-in. */
export interface LiteRtHostCommand {
  exe: string
  args: string[]
}

/** A program that speaks `litert-host` in place of this binary: the e2e tests' stand-in. */
export const LITERT_HOST_TEST_COMMAND_ENV = 'ATOMIC_LITERT_HOST_TEST_COMMAND'

export function liteRtHostCommand(
  env: Record<string, string | undefined>,
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath
): LiteRtHostCommand {
  const stand = env[LITERT_HOST_TEST_COMMAND_ENV]?.trim()
  if (stand) return { exe: stand, args: [] }
  const script = argv[1]
  const viaRuntime = script !== undefined && /\.(c|m)?[jt]s$/.test(script)
  return { exe: execPath, args: [...(viaRuntime ? [script] : []), 'litert-host'] }
}

export interface LiteRtHostProbeResult {
  /** The library's version, `X.Y.Z`; `null` where the host cannot read it. */
  version: string | null
  /** The ABI number of this host's binding. */
  abi: number
  backends: string[]
}

/** The first run of a freshly unpacked library is scanned by Gatekeeper / Defender. */
export const LITERT_HOST_PROBE_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 64 * 1024

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function parseProbe(raw: unknown): LiteRtHostProbeResult | null {
  if (!isRecord(raw)) return null
  const { version, abi, backends } = raw
  if (typeof abi !== 'number' || !Array.isArray(backends) || !backends.every((b) => typeof b === 'string'))
    return null
  return { version: typeof version === 'string' ? version : null, abi, backends: backends as string[] }
}

export interface HostRunOptions {
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
}

/**
 * Run one short `litert-host` mode and read the last JSON line it prints that `parse` accepts.
 * Throws `code` with what the host printed when it exits non-zero, prints no answer or does not
 * answer in time.
 */
export function runLiteRtHostJson<T>(
  command: LiteRtHostCommand,
  args: string[],
  parse: (raw: unknown) => T | null,
  failure: { code: ErrorCode; what: string },
  options: HostRunOptions = {}
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
    const timeoutMs = options.timeoutMs ?? LITERT_HOST_PROBE_TIMEOUT_MS
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new AtomicCoreError(
          failure.code,
          `${failure.what}: the LiteRT-LM host did not answer.`,
          `${args.join(' ')} timed out after ${Math.round(timeoutMs / 1000)}s`
        )
      )
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(
        new AtomicCoreError(
          failure.code,
          `${failure.what}: the LiteRT-LM host could not be started.`,
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
          `${failure.what}: the LiteRT-LM host failed (${status}).`,
          (stderr.trim() || stdout.trim() || status).slice(-4096)
        )
      )
    })
  })
}

/** `litert-host probe --lib <buildDir>`: the build's library loads in this core's host. */
export function runLiteRtHostProbe(
  command: LiteRtHostCommand,
  buildDir: string,
  options: HostRunOptions = {}
): Promise<LiteRtHostProbeResult> {
  return runLiteRtHostJson(
    command,
    ['probe', '--lib', buildDir],
    parseProbe,
    { code: 'ENGINE_INSTALL_FAILED', what: 'The LiteRT-LM build does not load' },
    options
  )
}

function parseInspect(raw: unknown): LiteRtFileInfo | null {
  if (!isRecord(raw) || typeof raw['model_type'] !== 'string' || !Array.isArray(raw['backends'])) return null
  return raw as unknown as LiteRtFileInfo
}

/** `litert-host inspect --lib <buildDir> <file>`: the file's metadata, read without an engine. */
export function runLiteRtHostInspect(
  command: LiteRtHostCommand,
  buildDir: string,
  file: string,
  options: HostRunOptions = {}
): Promise<LiteRtFileInfo> {
  return runLiteRtHostJson(
    command,
    ['inspect', '--lib', buildDir, file],
    parseInspect,
    { code: 'LITERT_LM_HOST_ERROR', what: 'The LiteRT-LM model file cannot be read' },
    options
  )
}

/** The engine-builds probe of a LiteRT-LM build: `litert-host probe`, its answer dropped. */
export function liteRtHostProber(
  command: LiteRtHostCommand,
  env: NodeJS.ProcessEnv
): (buildDir: string) => Promise<void> {
  return async (buildDir) => {
    await runLiteRtHostProbe(command, buildDir, { env })
  }
}
