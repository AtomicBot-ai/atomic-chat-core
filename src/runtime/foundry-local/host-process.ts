/**
 * The core's side of the `foundry-host` protocol (openspec change `add-foundry-local`, design D1):
 * the host is this very binary in a hidden mode, started with `process.execPath`, so a crash of
 * Microsoft's native library never takes the core down. `probe` loads the library of one build and
 * prints one JSON line: the C API version and the accelerators it finds, prepared or not.
 */

import { spawn } from 'node:child_process'
import { AtomicCoreError } from '../../contracts/index.js'

/** How to start `foundry-host`: `[execPath, script?]` + `foundry-host`, or a test stand-in. */
export interface FoundryHostCommand {
  exe: string
  args: string[]
}

export interface FoundryHostAccelerator {
  name: string
  /** The conf spelling (`cuda`, `openvino`…); `null` for one this core runs no variant on. */
  execution_provider?: string | null
  device: string
  prepared: boolean
}

export interface FoundryHostProbeResult {
  c_api_version: number
  /** The library's own version string. */
  version?: string
  accelerators: FoundryHostAccelerator[]
}

/** What `probe` and `prepare` run against. */
export interface FoundryHostTarget {
  /** The build directory. */
  libDir: string
  /** The library's data, shared by every build (`<data>/foundry-local/runtime`). */
  appDataDir: string
  /** The library's logs (`<data>/foundry-local/logs`); the host refuses to run without them. */
  logsDir: string
  /** The accelerators core recorded as prepared (the library cannot tell, rulings R6). */
  prepared?: readonly string[]
}

/** The first run of a freshly unpacked library is scanned by Gatekeeper / Defender. */
export const FOUNDRY_HOST_PROBE_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 64 * 1024

function parseProbeLine(line: string): FoundryHostProbeResult | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const { c_api_version, version, accelerators } = raw as Record<string, unknown>
  if (typeof c_api_version !== 'number' || !Array.isArray(accelerators)) return null
  const out: FoundryHostAccelerator[] = []
  for (const item of accelerators) {
    if (item === null || typeof item !== 'object') return null
    const { name, device, prepared, execution_provider } = item as Record<string, unknown>
    if (typeof name !== 'string' || typeof device !== 'string' || typeof prepared !== 'boolean') return null
    out.push({
      name,
      ...(typeof execution_provider === 'string' || execution_provider === null
        ? { execution_provider }
        : {}),
      device,
      prepared,
    })
  }
  return { c_api_version, ...(typeof version === 'string' ? { version } : {}), accelerators: out }
}

/**
 * `foundry-host probe --lib <libDir> --app-data <appDataDir>`. Throws `ENGINE_INSTALL_FAILED` with
 * what the host printed when it exits non-zero, prints no answer or does not answer in time.
 */
export function runFoundryHostProbe(
  command: FoundryHostCommand,
  target: FoundryHostTarget,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<FoundryHostProbeResult> {
  const args = [
    ...command.args,
    'probe',
    '--lib',
    target.libDir,
    '--app-data',
    target.appDataDir,
    '--logs',
    target.logsDir,
    ...(target.prepared ?? []).flatMap((name) => ['--prepared', name]),
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(command.exe, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const keep = (buffer: string, chunk: Buffer) => (buffer + chunk.toString('utf8')).slice(-OUTPUT_LIMIT)
    child.stdout.on('data', (chunk: Buffer) => (stdout = keep(stdout, chunk)))
    child.stderr.on('data', (chunk: Buffer) => (stderr = keep(stderr, chunk)))
    const timeoutMs = options.timeoutMs ?? FOUNDRY_HOST_PROBE_TIMEOUT_MS
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(
        new AtomicCoreError(
          'ENGINE_INSTALL_FAILED',
          'The Foundry Local host did not answer.',
          `probe of ${target.libDir} timed out after ${Math.round(timeoutMs / 1000)}s`
        )
      )
    }, timeoutMs)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(
        new AtomicCoreError(
          'ENGINE_INSTALL_FAILED',
          'The Foundry Local host could not be started.',
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
        .map(parseProbeLine)
        .find((parsed) => parsed !== null)
      if (code === 0 && answer) return resolve(answer)
      const status = code !== null ? `exit code ${code}` : `signal ${String(signal)}`
      reject(
        new AtomicCoreError(
          'ENGINE_INSTALL_FAILED',
          'The Foundry Local library does not load on this computer.',
          `${status}\n${[...(stderr || stdout)].slice(-800).join('')}`.trim()
        )
      )
    })
  })
}

/**
 * Test hook only, the same kind as `ATOMIC_MANAGED_TEST_HOST`: an executable that stands in for
 * `atomic-chat-core foundry-host` in the e2e suite, where no real Foundry Local library exists.
 * Production never sets it.
 */
export const FOUNDRY_HOST_TEST_COMMAND_ENV = 'ATOMIC_FOUNDRY_HOST_TEST_COMMAND'

/**
 * This binary in its `foundry-host` mode: `process.execPath` (inside a compiled Bun binary that is
 * the binary; under a runtime, the runtime plus the entry script, as `selfCommand` in the CLI does).
 */
export function foundryHostCommand(
  env: Record<string, string | undefined>,
  argv: readonly string[] = process.argv,
  execPath: string = process.execPath
): FoundryHostCommand {
  const stand = env[FOUNDRY_HOST_TEST_COMMAND_ENV]?.trim()
  if (stand) return { exe: stand, args: [] }
  const script = argv[1]
  const viaRuntime = script !== undefined && /\.(c|m)?[jt]s$/.test(script)
  return { exe: execPath, args: [...(viaRuntime ? [script] : []), 'foundry-host'] }
}

/** One accelerator's step, as `foundry-host prepare` prints it (task 5.2). */
export interface FoundryHostPrepareStep {
  accelerator: string
  stage: 'started' | 'downloading' | 'done' | 'failed'
  fraction: number | null
  reason?: string
}

export interface FoundryHostPrepareSummary {
  accelerators: Array<{ name: string; prepared: boolean; reason?: string }>
}

function parseStep(raw: Record<string, unknown>): FoundryHostPrepareStep | null {
  const { accelerator, stage, fraction, reason } = raw
  if (typeof accelerator !== 'string') return null
  if (stage !== 'started' && stage !== 'downloading' && stage !== 'done' && stage !== 'failed') return null
  if (fraction !== null && typeof fraction !== 'number') return null
  return { accelerator, stage, fraction, ...(typeof reason === 'string' ? { reason } : {}) }
}

/**
 * `foundry-host prepare --lib --app-data --logs [names…]`: each step to `onStep` as it happens, the
 * summary as the result. No timeout: a CUDA plugin is 2 GB (rulings S2). A host that exits non-zero
 * or prints no summary is `FOUNDRY_LOCAL_HOST_ERROR` with what it said.
 */
export function runFoundryHostPrepare(
  command: FoundryHostCommand,
  target: Omit<FoundryHostTarget, 'prepared'>,
  names: readonly string[],
  onStep: (step: FoundryHostPrepareStep) => void,
  options: { env?: NodeJS.ProcessEnv } = {}
): Promise<FoundryHostPrepareSummary> {
  const args = [
    ...command.args,
    'prepare',
    '--lib',
    target.libDir,
    '--app-data',
    target.appDataDir,
    '--logs',
    target.logsDir,
    ...names,
  ]
  return new Promise((resolve, reject) => {
    const child = spawn(command.exe, args, {
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let summary: FoundryHostPrepareSummary | null = null
    let stderr = ''
    child.stderr.on(
      'data',
      (chunk: Buffer) => (stderr = (stderr + chunk.toString('utf8')).slice(-OUTPUT_LIMIT))
    )
    let pending = ''
    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const lines = pending.split(/\r?\n/)
      pending = lines.pop() ?? ''
      for (const line of lines) {
        let raw: unknown
        try {
          raw = JSON.parse(line)
        } catch {
          continue
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
        const record = raw as Record<string, unknown>
        if (record['done'] === true && Array.isArray(record['accelerators'])) {
          summary = { accelerators: record['accelerators'] as FoundryHostPrepareSummary['accelerators'] }
          continue
        }
        const step = parseStep(record)
        if (step) onStep(step)
      }
    })
    child.on('error', (error) =>
      reject(
        new AtomicCoreError(
          'FOUNDRY_LOCAL_HOST_ERROR',
          'The Foundry Local host could not be started.',
          String(error)
        )
      )
    )
    child.on('close', (code) => {
      if (code === 0 && summary) return resolve(summary)
      reject(
        new AtomicCoreError(
          'FOUNDRY_LOCAL_HOST_ERROR',
          'The Foundry Local host could not prepare the accelerators.',
          `exit code ${String(code)}\n${[...stderr].slice(-800).join('')}`.trim()
        )
      )
    })
  })
}
