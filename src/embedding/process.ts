/**
 * Spawning one embedding `llama-server` and waiting until it answers vectors.
 *
 * The same process mechanics the decision module borrows from the runtimes: `spawnManaged`,
 * `randomFreePort`, `buildProcessEnv`, the backend-output sink, and the journal hooks (the caller
 * writes the record right after the spawn under `provider: 'embedding'`, so a crashed owner's
 * successor reaps it). Readiness is `readiness.ts`, polled until the startup deadline; an exit before
 * it is reported with the last lines the process printed. On any failure the child is dead when this
 * rejects.
 */

import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { EmbeddingEngineInfo, EmbeddingModality } from '../contracts/index.js'
import { commandSummary } from '../decision/index.js'
import type { DecisionHttp } from '../decision/index.js'
import type { ExitInfo } from '../runtime/llamacpp/index.js'
import {
  backendOutputReporter,
  buildProcessEnv,
  discoverCudaPaths,
  exitedOnTakenPort,
  nodeCudaProbeEnv,
  randomFreePort,
  retryOnTakenPort,
  spawnManaged,
} from '../runtime/shared/index.js'
import type { BackendOutputSink, ManagedProcess, SpawnSpec } from '../runtime/shared/index.js'
import { buildEmbeddingArgs, embeddingEnv, EMBEDDING_HOST } from './args.js'
import { findFfmpegDir, withPathDir } from './ffmpeg.js'
import type { EmbeddingLaunchSpec } from './args.js'
import { checkEmbeddingReadiness, READINESS_REQUEST_TIMEOUT_MS } from './readiness.js'

/** SIGTERM → this long → SIGKILL. */
export const EMBEDDING_TERMINATE_GRACE_MS = 5_000
export const READY_POLL_INTERVAL_MS = 200
/** Lines of output kept for a post-mortem. */
export const EMBEDDING_TAIL_CAPACITY = 100

export interface EmbeddingServerSpec extends Omit<EmbeddingLaunchSpec, 'port'> {
  engine: EmbeddingEngineInfo
  startupTimeoutMs: number
}

/** A running embedding process that answered a vector. */
export interface EmbeddingProcessHandle {
  pid: number
  port: number
  apiKey: string
  exe: string
  baseUrl: string
  /** The `-a` the process answers with. */
  modelId: string
  dims: number
  modalities: EmbeddingModality[]
  tail(): string[]
  exitStatus(): ExitInfo | undefined
  exited: Promise<ExitInfo>
  terminate(graceMs?: number): Promise<ExitInfo>
}

export interface SpawnEmbeddingDeps {
  http: DecisionHttp
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  log?: (level: 'info' | 'warn' | 'debug', msg: string) => void
  backendOutput?: BackendOutputSink
  /** Right after the child started, before readiness: the journal entry goes here. */
  onSpawned?: (pid: number, port: number, exe: string) => Promise<void>
  /** A child `onSpawned` saw is dead and will never be used. */
  onGone?: (pid: number) => Promise<void>
  /** An unload or a shutdown while the process is still starting; the child is killed. */
  signal?: AbortSignal
  freePort?: () => Promise<number>
  apiKey?: () => string
  /** Test seam: start the child (the fake engine in tests). */
  spawn?: (spec: SpawnSpec, onData: (stream: 'stdout' | 'stderr', line: string) => void) => ManagedProcess
  /** The folder holding `ffmpeg` (`findFfmpegDir`); without one the process is offered no video. */
  findFfmpeg?: (platform: NodeJS.Platform, env: NodeJS.ProcessEnv) => Promise<string | undefined>
  pollIntervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function describeExit(exit: ExitInfo): string {
  if (exit.code !== null) return `code ${exit.code}`
  if (exit.signal !== null) return `signal ${exit.signal}`
  return 'an unknown status'
}

/** The error for a process that died before it was ready: the engine's own last lines in the details. */
export function embeddingEarlyExitError(exit: ExitInfo, tail: readonly string[]): AtomicCoreError {
  return new AtomicCoreError(
    'MODEL_LOAD_FAILED',
    `The embedding model exited with ${describeExit(exit)} while loading.`,
    tail.slice(-20).join('\n') || undefined
  )
}

/**
 * Start the embedding model, on another port when the one picked was taken before the engine could
 * bind it (`retryOnTakenPort`): an exit while loading that says so is that race, not the model.
 */
export async function spawnEmbeddingServer(
  spec: EmbeddingServerSpec,
  deps: SpawnEmbeddingDeps
): Promise<EmbeddingProcessHandle> {
  return retryOnTakenPort(
    () => spawnEmbeddingServerOnce(spec, deps),
    (error) =>
      error instanceof AtomicCoreError &&
      error.code === 'MODEL_LOAD_FAILED' &&
      exitedOnTakenPort(error.details),
    (attempt) =>
      deps.log?.('warn', `the embedding model's port was taken while it started; retrying (${attempt})`)
  )
}

async function spawnEmbeddingServerOnce(
  spec: EmbeddingServerSpec,
  deps: SpawnEmbeddingDeps
): Promise<EmbeddingProcessHandle> {
  const platform = deps.platform ?? process.platform
  const inherited = deps.env ?? process.env
  // Video decodes through `ffmpeg` on the process's PATH (see `ffmpeg.ts`).
  const ffmpegDir = await (deps.findFfmpeg ?? findFfmpegDir)(platform, inherited).catch(() => undefined)
  const baseEnv = ffmpegDir !== undefined ? withPathDir(inherited, ffmpegDir, platform) : inherited
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const exe = spec.engine.path

  const port = await (deps.freePort ?? (() => randomFreePort([])))().catch((error: unknown) => {
    throw new AtomicCoreError(
      'MODEL_LOAD_FAILED',
      'No free port for the embedding model.',
      error instanceof Error ? error.message : String(error)
    )
  })
  const apiKey = (deps.apiKey ?? (() => randomBytes(24).toString('base64url')))()
  const args = buildEmbeddingArgs({ ...spec, port })
  log('info', `starting the embedding model: ${commandSummary(exe, args)}`)
  const { env, cwd } = buildProcessEnv({
    platform,
    baseEnv,
    exeDir: dirname(exe),
    cuda: discoverCudaPaths(nodeCudaProbeEnv(platform, baseEnv)),
    userEnv: embeddingEnv(apiKey),
  })

  const tail: string[] = []
  const reportOutput = backendOutputReporter(deps.backendOutput, deps.log)
  const onLine = (stream: 'stdout' | 'stderr', line: string) => {
    reportOutput({ provider: 'embedding', model: spec.modelId, stream, line })
    if (tail.length >= EMBEDDING_TAIL_CAPACITY) tail.shift()
    tail.push(line)
  }
  const proc = (deps.spawn ?? ((s, cb) => spawnManaged(s, cb, { captureOutput: false })))(
    { exe, args, env, cwd },
    onLine
  )
  let exit: ExitInfo | undefined
  void proc.exited.then((e) => (exit = e))
  const baseUrl = `http://${EMBEDDING_HOST}:${port}`
  const terminate = (graceMs = EMBEDDING_TERMINATE_GRACE_MS) => proc.terminate(graceMs)

  try {
    await deps.onSpawned?.(proc.pid, port, exe)
  } catch (error) {
    await terminate(0)
    throw error
  }

  const fail = async (graceMs: number, error: AtomicCoreError): Promise<never> => {
    await terminate(graceMs)
    await deps.onGone?.(proc.pid)
    throw error
  }

  const deadline = now() + spec.startupTimeoutMs
  let lastDetail = ''
  for (;;) {
    if (deps.signal?.aborted)
      return fail(0, new AtomicCoreError('EMBEDDING_UNAVAILABLE', 'The embedding model start was stopped.'))
    const spawnFailure = proc.spawnFailure()
    if (spawnFailure) {
      await deps.onGone?.(proc.pid)
      throw new AtomicCoreError(
        'MODEL_LOAD_FAILED',
        'The embedding engine could not be started.',
        `${exe}: ${spawnFailure.message}`
      )
    }
    if (exit !== undefined) {
      // Give the pipes a moment to deliver the final lines.
      await sleep(50)
      await deps.onGone?.(proc.pid)
      log('warn', `the embedding model exited while loading (${describeExit(exit)})`)
      throw embeddingEarlyExitError(exit, tail)
    }
    if (now() >= deadline)
      return fail(
        EMBEDDING_TERMINATE_GRACE_MS,
        new AtomicCoreError(
          'MODEL_LOAD_TIMED_OUT',
          `The embedding model did not become ready within ${Math.round(spec.startupTimeoutMs / 1000)} seconds.`,
          [lastDetail, ...tail.slice(-10)].filter(Boolean).join('\n') || undefined
        )
      )
    const result = await checkEmbeddingReadiness(
      deps.http,
      baseUrl,
      apiKey,
      spec.modelId,
      READINESS_REQUEST_TIMEOUT_MS
    )
    if (result.kind === 'ready') {
      // The projector may read clips, but without `ffmpeg` the engine cannot decode one.
      const modalities =
        ffmpegDir === undefined ? result.modalities.filter((m) => m !== 'video') : result.modalities
      log(
        'info',
        `the embedding model ${spec.modelId} is ready on port ${port} (${result.dims} dimensions, ${modalities.join(', ')})`
      )
      return {
        pid: proc.pid,
        port,
        apiKey,
        exe,
        baseUrl,
        modelId: spec.modelId,
        dims: result.dims,
        modalities,
        tail: () => [...tail],
        exitStatus: () => exit,
        exited: proc.exited,
        terminate,
      }
    }
    if (result.kind === 'unsupported')
      return fail(
        EMBEDDING_TERMINATE_GRACE_MS,
        new AtomicCoreError(
          'EMBEDDING_ENGINE_UNSUPPORTED',
          'The engine started but does not serve embeddings.',
          `${exe}: ${result.detail}`
        )
      )
    if (result.kind === 'refused')
      return fail(
        EMBEDDING_TERMINATE_GRACE_MS,
        new AtomicCoreError(
          'MODEL_LOAD_FAILED',
          'The embedding model started but refuses to produce vectors.',
          `${exe}: ${result.detail}`
        )
      )
    lastDetail = result.detail
    await sleep(deps.pollIntervalMs ?? READY_POLL_INTERVAL_MS)
  }
}
