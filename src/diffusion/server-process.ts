/**
 * Spawning and supervising the `sd-server` process. Port of `process.rs` in
 * `tauri-plugin-atomic-diffusion` (app commit `767ff6350`).
 *
 * Readiness is real: upstream loads the model *before* it binds the port, so a 200 from
 * `GET /v1/models` means the model is loaded, and a load failure exits the process before it
 * listens. `/v1/models` is a stock route that llama-server answers too, so the richer
 * `/sdcpp/v1/capabilities` is probed afterwards: a 404 there means the port belongs to someone else.
 */

import { constants } from 'node:os'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import {
  buildProcessEnv,
  discoverCudaPaths,
  nodeCudaProbeEnv,
  randomFreePort,
  spawnManaged,
} from '../runtime/shared/index.js'
import type { ManagedProcess } from '../runtime/shared/index.js'
import { buildServerArgs, commandSummaryForLog } from './args.js'
import { diffusionError, ioError } from './errors.js'
import type { SdHttpClient } from './http.js'
import { serverBinaryName } from './install.js'
import { classifyExit, diagnosticTail, OutputRecords } from './progress.js'
import type { ServerHandle } from './state.js'
import type { ServerCapabilities, ServerSpec } from './types.js'

export const READY_PATH = '/v1/models'
export const CAPABILITIES_PATH = '/sdcpp/v1/capabilities'
export const READY_POLL_INTERVAL_MS = 300
export const READY_REQUEST_TIMEOUT_MS = 2_000
export const CAPABILITIES_TIMEOUT_MS = 5_000
/** SIGTERM → this long → SIGKILL. */
export const TERMINATE_GRACE_MS = 5_000
/** How many output lines a server keeps for its own post-mortem. */
export const TAIL_CAPACITY = 200

export interface SpawnServerDeps {
  http: SdHttpClient
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  log?: (level: 'info' | 'warn' | 'debug', msg: string) => void
  /** Called with the child right after it started, before readiness: the journal entry goes here. */
  onSpawned?: (pid: number, port: number, exe: string) => Promise<void>
  /** Called when a child that `onSpawned` saw is dead and will never become a session. */
  onGone?: (pid: number) => Promise<void>
  /** Stops a load that is still waiting for the port (an unload or a shutdown); the child is killed. */
  signal?: AbortSignal
  freePort?: () => Promise<number>
  readyPollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** The exit code, or `128 + signal number` for a signal, which is what the classifier reads. */
export function exitCodeOf(exit: ExitInfo): number | undefined {
  if (exit.code !== null) return exit.code
  if (exit.signal === null) return undefined
  const number = (constants.signals as Record<string, number | undefined>)[exit.signal]
  return number === undefined ? undefined : 128 + number
}

/** How an exit reads in a message: `code 6`, `signal SIGKILL`, or nothing. */
export function describeExit(exit: ExitInfo): string {
  if (exit.code !== null) return `code ${exit.code}`
  if (exit.signal !== null) return `signal ${exit.signal}`
  return 'unknown status'
}

/** The error for a server that died before it listened, marked lines first. */
export function earlyExitError(exit: ExitInfo, tail: readonly string[]): ReturnType<typeof diffusionError> {
  const text = diagnosticTail(tail)
  if (classifyExit(text, exitCodeOf(exit)) === 'OUT_OF_MEMORY')
    return diffusionError('OUT_OF_MEMORY', 'The image model ran out of memory while loading.', text)
  const message =
    exit.code !== null
      ? `sd-server exited with code ${exit.code} while loading.`
      : exit.signal !== null
        ? `sd-server was terminated by signal ${exit.signal} while loading.`
        : 'sd-server exited while loading.'
  return diffusionError('MODEL_LOAD_FAILED', message, text)
}

export function parseCapabilities(body: unknown): ServerCapabilities {
  const root = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const byMode = (key: string): Record<string, unknown> | undefined => {
    const section = root[key]
    if (section === null || typeof section !== 'object') return undefined
    const imgGen = (section as Record<string, unknown>)['img_gen']
    return imgGen !== null && typeof imgGen === 'object' ? (imgGen as Record<string, unknown>) : undefined
  }
  const capabilities: ServerCapabilities = {
    cancelGenerating: byMode('features_by_mode')?.['cancel_generating'] === true,
  }
  const defaults = byMode('defaults_by_mode')
  if (defaults !== undefined) capabilities.imgGenDefaults = defaults
  return capabilities
}

/**
 * Spawn `sd-server` for `spec`, wait until it serves the model, and probe its capabilities. On any
 * failure the child is dead when this rejects.
 */
export async function spawnServer(
  spec: ServerSpec,
  scratchDir: string,
  deps: SpawnServerDeps
): Promise<ServerHandle> {
  const platform = deps.platform ?? process.platform
  const baseEnv = deps.env ?? process.env
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? defaultSleep
  const exe = join(spec.binaryDir, serverBinaryName(platform))
  const isFile = await stat(exe).then(
    (s) => s.isFile(),
    () => false
  )
  if (!isFile)
    throw diffusionError('ENGINE_MISSING', 'The image engine is not installed.', `missing binary: ${exe}`)
  await mkdir(scratchDir, { recursive: true }).catch((error: unknown) => {
    throw ioError('Could not create the scratch directory.', error)
  })
  const port = await (deps.freePort ?? (() => randomFreePort([])))().catch((error: unknown) => {
    throw diffusionError(
      'INTERNAL',
      'No free port for sd-server.',
      error instanceof Error ? error.message : String(error)
    )
  })
  const args = buildServerArgs(spec, port, scratchDir, { platform, env: baseEnv })
  log('info', `starting sd-server: ${commandSummaryForLog(args)}`)

  const { env, cwd } = buildProcessEnv({
    platform,
    baseEnv,
    exeDir: spec.binaryDir,
    cuda: discoverCudaPaths(nodeCudaProbeEnv(platform, baseEnv)),
    userEnv: {},
  })

  const tail: string[] = []
  let listener: ((line: string) => void) | undefined
  const records = { stdout: new OutputRecords(), stderr: new OutputRecords() }
  const deliver = (stream: 'stdout' | 'stderr', lines: string[]) => {
    for (const line of lines) {
      log('debug', `[sd-server ${stream}] ${line}`)
      if (tail.length >= TAIL_CAPACITY) tail.shift()
      tail.push(line)
      listener?.(line)
    }
  }
  const proc = spawnManaged({ exe, args, env, cwd }, undefined, {
    captureOutput: false,
    onData: (stream, chunk) => deliver(stream, records[stream].push(chunk)),
  })
  const flushed = proc.exited.then((exit) => {
    for (const stream of ['stdout', 'stderr'] as const) deliver(stream, records[stream].finish())
    return exit
  })
  let exit: ExitInfo | undefined
  void flushed.then((e) => (exit = e))

  const handle: ServerHandle = {
    pid: proc.pid,
    port,
    exe,
    capabilities: { cancelGenerating: false },
    tail: () => [...tail],
    setLineListener: (next) => (listener = next),
    exitStatus: () => exit,
    exited: flushed,
    terminate: (graceMs = TERMINATE_GRACE_MS) => proc.terminate(graceMs).then(() => flushed),
  }

  try {
    await deps.onSpawned?.(proc.pid, port, exe)
  } catch (error) {
    await handle.terminate(0)
    throw error
  }

  try {
    await awaitReadyAndProbe(spec, port, handle, proc, tail, deps, log, sleep, exe)
  } catch (error) {
    await deps.onGone?.(proc.pid)
    throw error
  }
  return handle
}

async function awaitReadyAndProbe(
  spec: ServerSpec,
  port: number,
  handle: ServerHandle,
  proc: ManagedProcess,
  tail: readonly string[],
  deps: SpawnServerDeps,
  log: NonNullable<SpawnServerDeps['log']>,
  sleep: (ms: number) => Promise<void>,
  exe: string
): Promise<void> {
  const abandon = async (graceMs: number, error: ReturnType<typeof diffusionError>) => {
    await handle.terminate(graceMs)
    throw error
  }
  // Readiness: the model is loaded once the stock route answers 200.
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + spec.startupTimeoutMs
  for (;;) {
    if (deps.signal?.aborted)
      await abandon(0, diffusionError('CANCELLED', 'The image model load was stopped.'))
    const spawnFailure = proc.spawnFailure()
    if (spawnFailure)
      throw diffusionError(
        'MODEL_LOAD_FAILED',
        'sd-server could not be started.',
        `${exe}: ${spawnFailure.message}`
      )
    const exit = handle.exitStatus()
    if (exit !== undefined) {
      // Give the pipes a moment to flush the final lines.
      await sleep(100)
      const error = earlyExitError(exit, tail)
      log('warn', `sd-server exited early (${describeExit(exit)}):\n${error.details ?? ''}`)
      throw error
    }
    if (Date.now() >= deadline)
      await abandon(
        TERMINATE_GRACE_MS,
        diffusionError(
          'MODEL_LOAD_FAILED',
          `The image model did not finish loading within ${Math.round(spec.startupTimeoutMs / 1000)} seconds.`,
          diagnosticTail(tail)
        )
      )
    const ready = await deps.http.get(`${url}${READY_PATH}`, READY_REQUEST_TIMEOUT_MS).then(
      (response) => response.status === 200,
      () => false
    )
    if (ready) break
    await sleep(deps.readyPollIntervalMs ?? READY_POLL_INTERVAL_MS)
  }

  const probe = `${url}${CAPABILITIES_PATH}`
  const response = await deps.http.get(probe, CAPABILITIES_TIMEOUT_MS).catch((error: unknown) => {
    // Some builds block in this handler; readiness was already proven.
    log(
      'warn',
      `capabilities probe failed, assuming defaults: ${error instanceof Error ? error.message : String(error)}`
    )
    return undefined
  })
  if (response?.status === 404)
    await abandon(
      TERMINATE_GRACE_MS,
      diffusionError(
        'MODEL_LOAD_FAILED',
        "Another process answered on sd-server's port.",
        `${probe} returned 404: the listener is not stable-diffusion.cpp`
      )
    )
  if (response && response.status >= 200 && response.status < 300) {
    try {
      handle.capabilities = parseCapabilities(JSON.parse(response.text))
    } catch (error) {
      log('warn', `capabilities body was not JSON: ${error instanceof Error ? error.message : String(error)}`)
    }
  } else if (response) log('warn', `capabilities probe returned ${response.status}, assuming defaults`)
}
