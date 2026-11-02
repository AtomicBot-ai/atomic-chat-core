/**
 * Spawning and supervising `audiocpp_server` for one model.
 *
 * Readiness is real: with `lazy_load: false` audio.cpp loads the model before it binds the port, so a
 * 200 from `GET /health` means the model is loaded, and a load failure exits the process before it
 * listens (`audiocpp_server failed: …`). `/health` is a route other servers answer too, so the model
 * listing is read next: it must name our model with the family and task the load asked for, loaded —
 * otherwise the port belongs to someone else, or the engine serves something else.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import { OutputRecords } from '../diffusion/index.js'
import { diagnosticTail } from '../diffusion/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import {
  backendOutputReporter,
  buildProcessEnv,
  discoverCudaPaths,
  nodeCudaProbeEnv,
  randomFreePort,
  retryOnTakenPort,
  spawnManaged,
} from '../runtime/shared/index.js'
import type { BackendOutputSink, ManagedProcess } from '../runtime/shared/index.js'
import { audioChildEnv, buildAudioServerArgs } from './args.js'
import { buildCapabilities, parseServedModels, parseVoiceList } from './capabilities.js'
import { buildServerConfig } from './config.js'
import { audioError, audioIoError } from './errors.js'
import type { AudioHttpClient } from './http.js'
import { audioServerBinaryName } from './install.js'
import { audioEarlyExitError, describeAudioExit, exitedOnTakenAudioPort, readModelFact } from './output.js'
import type { AudioModelFacts } from './output.js'
import type { AudioServerHandle, AudioServerSpec } from './types.js'

export const HEALTH_PATH = '/health'
export const MODELS_PATH = '/v1/models?include_params=true'
export const VOICES_PATH = '/v1/audio/voices'
export const READY_POLL_INTERVAL_MS = 300
export const READY_REQUEST_TIMEOUT_MS = 2_000
export const PROBE_TIMEOUT_MS = 10_000
/** SIGTERM → this long → SIGKILL. */
export const TERMINATE_GRACE_MS = 5_000
/** How many output lines a server keeps for its own post-mortem. */
export const TAIL_CAPACITY = 200
/** The file the core writes the server's config to, under `<data>/audio/run`. */
export const SERVER_CONFIG_FILE = 'server.json'

export interface SpawnAudioServerDeps {
  http: AudioHttpClient
  /** `<data>/audio/run`: where `server.json` is written. */
  runDir: string
  /** `<data>/audio/tmp`: the child's `TMPDIR`. */
  tmpDir: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  log?: (level: 'info' | 'warn' | 'debug', msg: string) => void
  /** Every stdout/stderr line the server prints, for the life of the session. */
  backendOutput?: BackendOutputSink
  /** Called with the child right after it started, before readiness: the journal entry goes here. */
  onSpawned?: (pid: number, port: number, exe: string) => Promise<void>
  /** Called when a child that `onSpawned` saw is dead and will never become a session. */
  onGone?: (pid: number) => Promise<void>
  /** Stops a load still waiting for the model (an unload or a shutdown); the child is killed. */
  signal?: AbortSignal
  freePort?: () => Promise<number>
  readyPollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Spawn `audiocpp_server` for `spec`, wait until it serves the model, and read what it declares. On
 * any failure the child is dead when this rejects. A start that died because its port was taken
 * before the engine could bind it goes again on another port.
 */
export async function spawnAudioServer(
  spec: AudioServerSpec,
  deps: SpawnAudioServerDeps
): Promise<AudioServerHandle> {
  return retryOnTakenPort(
    () => spawnOnce(spec, deps),
    (error) =>
      error instanceof AtomicCoreError &&
      error.code === 'MODEL_LOAD_FAILED' &&
      exitedOnTakenAudioPort(error.details),
    (attempt) =>
      deps.log?.('warn', `audiocpp_server's port was taken while it started; retrying (${attempt})`)
  )
}

async function spawnOnce(spec: AudioServerSpec, deps: SpawnAudioServerDeps): Promise<AudioServerHandle> {
  const platform = deps.platform ?? process.platform
  const baseEnv = deps.env ?? process.env
  const log = deps.log ?? (() => {})
  const exe = join(spec.binaryDir, audioServerBinaryName(platform))
  const isFile = await stat(exe).then(
    (s) => s.isFile(),
    () => false
  )
  if (!isFile)
    throw audioError('ENGINE_MISSING', 'The audio engine is not installed.', `missing binary: ${exe}`)
  for (const dir of [deps.runDir, deps.tmpDir])
    await mkdir(dir, { recursive: true }).catch((error: unknown) => {
      throw audioIoError('Could not create the audio folders.', error)
    })
  const port = await (deps.freePort ?? (() => randomFreePort([])))().catch((error: unknown) => {
    throw audioError(
      'INTERNAL',
      'No free port for audiocpp_server.',
      error instanceof Error ? error.message : String(error)
    )
  })
  const configFile = join(deps.runDir, SERVER_CONFIG_FILE)
  await writeFile(configFile, JSON.stringify(buildServerConfig(spec, port), null, 2)).catch(
    (error: unknown) => {
      throw audioIoError('Could not write the audio server config.', error)
    }
  )
  const args = buildAudioServerArgs(configFile, port, spec.backend, spec.threads)
  log('info', `starting audiocpp_server: ${args.join(' ')}`)
  log('debug', `launch tag=${spec.tag} backend=${spec.backendId} binary=${exe} model=${spec.modelPath}`)

  const { env } = buildProcessEnv({
    platform,
    baseEnv,
    exeDir: spec.binaryDir,
    cuda: discoverCudaPaths(nodeCudaProbeEnv(platform, baseEnv)),
    userEnv: audioChildEnv(platform, deps.tmpDir),
  })

  const tail: string[] = []
  const facts: AudioModelFacts = {}
  const records = { stdout: new OutputRecords(), stderr: new OutputRecords() }
  const reportOutput = backendOutputReporter(deps.backendOutput, deps.log)
  const deliver = (stream: 'stdout' | 'stderr', lines: string[]) => {
    for (const line of lines) {
      reportOutput({ provider: 'audio-cpp', model: spec.modelId, stream, line })
      if (tail.length >= TAIL_CAPACITY) tail.shift()
      tail.push(line)
      readModelFact(facts, line)
    }
  }
  // The build's own folder is the working directory on every platform: its runtime DLLs sit there.
  const proc = spawnManaged({ exe, args, env, cwd: spec.binaryDir, platform }, undefined, {
    captureOutput: false,
    onData: (stream, chunk) => deliver(stream, records[stream].push(chunk)),
  })
  const flushed = proc.exited.then((exit) => {
    for (const stream of ['stdout', 'stderr'] as const) deliver(stream, records[stream].finish())
    return exit
  })
  let exit: ExitInfo | undefined
  void flushed.then((e) => (exit = e))

  const handle: AudioServerHandle = {
    pid: proc.pid,
    port,
    exe,
    capabilities: {
      modelId: spec.modelId,
      mode: spec.mode,
      family: spec.family,
      task: spec.task,
      params: [],
      voices: [],
      supportsVoiceRef: false,
      requiresVoiceRef: false,
    },
    tail: () => [...tail],
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
    await awaitReady(spec, handle, proc, tail, facts, deps, exe)
  } catch (error) {
    await deps.onGone?.(proc.pid)
    throw error
  }
  return handle
}

async function awaitReady(
  spec: AudioServerSpec,
  handle: AudioServerHandle,
  proc: ManagedProcess,
  tail: readonly string[],
  facts: AudioModelFacts,
  deps: SpawnAudioServerDeps,
  exe: string
): Promise<void> {
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? defaultSleep
  const abandon = async (graceMs: number, error: AtomicCoreError): Promise<never> => {
    await handle.terminate(graceMs)
    throw error
  }
  const url = `http://127.0.0.1:${handle.port}`
  const deadline = Date.now() + spec.startupTimeoutMs
  for (;;) {
    if (deps.signal?.aborted) await abandon(0, audioError('CANCELLED', 'The audio model load was stopped.'))
    const spawnFailure = proc.spawnFailure()
    if (spawnFailure)
      throw audioError(
        'MODEL_LOAD_FAILED',
        'audiocpp_server could not be started.',
        `${exe}: ${spawnFailure.message}`
      )
    const exit = handle.exitStatus()
    if (exit !== undefined) {
      // Give the pipes a moment to flush the final lines.
      await sleep(100)
      const error = audioEarlyExitError(exit, tail)
      log('warn', `audiocpp_server exited early (${describeAudioExit(exit)}):\n${error.details ?? ''}`)
      throw error
    }
    if (Date.now() >= deadline)
      await abandon(
        TERMINATE_GRACE_MS,
        audioError(
          'MODEL_LOAD_FAILED',
          `The audio model did not finish loading within ${Math.round(spec.startupTimeoutMs / 1000)} seconds.`,
          diagnosticTail(tail)
        )
      )
    const ready = await deps.http.get(`${url}${HEALTH_PATH}`, { timeoutMs: READY_REQUEST_TIMEOUT_MS }).then(
      (response) => response.status === 200,
      () => false
    )
    if (ready) break
    await sleep(deps.readyPollIntervalMs ?? READY_POLL_INTERVAL_MS)
  }

  const foreign = (why: string) =>
    abandon(
      TERMINATE_GRACE_MS,
      audioError('MODEL_LOAD_FAILED', "Another process answered on the audio server's port.", why)
    )
  const listing = await deps.http
    .get(`${url}${MODELS_PATH}`, { timeoutMs: PROBE_TIMEOUT_MS })
    .catch((error: unknown) =>
      foreign(`${MODELS_PATH}: ${error instanceof Error ? error.message : String(error)}`)
    )
  let body: unknown
  try {
    body = JSON.parse(listing.body.toString('utf8'))
  } catch {
    body = undefined
  }
  if (listing.status !== 200 || body === undefined)
    await foreign(`${MODELS_PATH} answered ${listing.status}: the listener is not audio.cpp`)
  const served = parseServedModels(body).find((model) => model.id === spec.modelId)
  if (!served)
    return foreign(`${MODELS_PATH} does not list ${spec.modelId}: the listener is not our audio.cpp`)
  if (served.family !== spec.family || served.task !== spec.task)
    await abandon(
      TERMINATE_GRACE_MS,
      audioError(
        'MODEL_INCOMPATIBLE',
        'The audio engine serves this model as something else.',
        `family=${served.family} task=${served.task}; wanted family=${spec.family} task=${spec.task}`
      )
    )
  if (!served.loaded)
    await abandon(
      TERMINATE_GRACE_MS,
      audioError('MODEL_LOAD_FAILED', 'The audio engine listed the model without loading it.', spec.modelId)
    )

  // A voice list beyond what `voice_id` declares: read only when the declaration has none.
  let listedVoices: string[] = []
  const voiceParam = served.params.find((param) => param.name === 'voice_id')
  if (spec.mode === 'speech' && !(voiceParam?.values && voiceParam.values.length > 0)) {
    const voices = await deps.http
      .get(`${url}${VOICES_PATH}?model=${encodeURIComponent(spec.modelId)}`, { timeoutMs: PROBE_TIMEOUT_MS })
      .catch(() => undefined)
    if (voices?.status === 200) {
      try {
        listedVoices = parseVoiceList(JSON.parse(voices.body.toString('utf8')))
      } catch {
        log('warn', 'the voice list was not JSON')
      }
    }
  }
  handle.capabilities = buildCapabilities(spec, served, facts, listedVoices)
}
