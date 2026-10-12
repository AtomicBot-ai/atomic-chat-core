/**
 * Spawning one decision `llama-server` (the fork's `--decision`, or stock llama.cpp for an upstream
 * decision GGUF) and waiting until it is a decision model this core can use.
 *
 * Borrowed from the runtimes, as the image engine does: `spawnManaged`, `randomFreePort`,
 * `buildProcessEnv`, the backend-output sink, and the journal hooks (the caller writes the record
 * right after the spawn under `provider: 'decision'`, so a crashed owner's successor reaps it).
 * Readiness is the chain of `readiness.ts`, polled until the startup deadline; an exit before it is
 * reported with the last lines the process printed. On any failure the child is dead when this
 * rejects.
 */

import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../contracts/index.js'
import type { DecisionCapability, DecisionEngineInfo, DecisionProps } from '../contracts/index.js'
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
import {
  buildDecisionArgs,
  buildUpstreamDecisionArgs,
  commandSummary,
  decisionEnv,
  DECISION_HOST,
  withoutDecisionEnv,
} from './args.js'
import type { DecisionLaunchSpec, UpstreamDecisionLaunch } from './args.js'
import type { DecisionHttp } from './http.js'
import { UPSTREAM_DECISION_DEFAULT_CTX } from './model-facts.js'
import { checkReadiness, READINESS_REQUEST_TIMEOUT_MS } from './readiness.js'

/** SIGTERM → this long → SIGKILL. The engine cancels its queue on SIGTERM, so this is rarely used. */
export const DECISION_TERMINATE_GRACE_MS = 5_000
export const READY_POLL_INTERVAL_MS = 200
/** Lines of output kept for a post-mortem. */
export const DECISION_TAIL_CAPACITY = 100

export interface DecisionServerSpec extends Omit<DecisionLaunchSpec, 'port'> {
  engine: DecisionEngineInfo
  startupTimeoutMs: number
  /** How an upstream engine (`engine.dialect === 'upstream'`) runs the model; ignored by the fork. */
  upstream?: UpstreamDecisionLaunch
}

/** The argv for `spec` on `port`: the fork's `--decision`, or stock llama.cpp for an upstream GGUF. */
export function decisionArgsFor(spec: DecisionServerSpec, port: number): string[] {
  if (spec.engine.dialect !== 'upstream') return buildDecisionArgs({ ...spec, port })
  return buildUpstreamDecisionArgs(
    { ...spec, port },
    spec.upstream ?? { ctxSize: UPSTREAM_DECISION_DEFAULT_CTX, wholePromptUbatch: false }
  )
}

/** A running decision process that passed the readiness chain. */
export interface DecisionProcessHandle {
  pid: number
  port: number
  apiKey: string
  exe: string
  baseUrl: string
  props: DecisionProps
  capabilities: DecisionCapability[]
  tail(): string[]
  exitStatus(): ExitInfo | undefined
  exited: Promise<ExitInfo>
  terminate(graceMs?: number): Promise<ExitInfo>
}

export interface SpawnDecisionDeps {
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
export function earlyExitError(exit: ExitInfo, tail: readonly string[]): AtomicCoreError {
  return new AtomicCoreError(
    'MODEL_LOAD_FAILED',
    `The decision model exited with ${describeExit(exit)} while loading.`,
    tail.slice(-20).join('\n') || undefined
  )
}

/**
 * Start the decision model, on another port when the one picked was taken before the engine could
 * bind it (`retryOnTakenPort`): an exit while loading that says so is that race, not the model.
 */
export async function spawnDecisionServer(
  spec: DecisionServerSpec,
  deps: SpawnDecisionDeps
): Promise<DecisionProcessHandle> {
  return retryOnTakenPort(
    () => spawnDecisionServerOnce(spec, deps),
    (error) =>
      error instanceof AtomicCoreError &&
      error.code === 'MODEL_LOAD_FAILED' &&
      exitedOnTakenPort(error.details),
    (attempt) =>
      deps.log?.('warn', `the decision model's port was taken while it started; retrying (${attempt})`)
  )
}

async function spawnDecisionServerOnce(
  spec: DecisionServerSpec,
  deps: SpawnDecisionDeps
): Promise<DecisionProcessHandle> {
  const platform = deps.platform ?? process.platform
  const baseEnv = withoutDecisionEnv(deps.env ?? process.env)
  const log = deps.log ?? (() => {})
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const exe = spec.engine.path

  const port = await (deps.freePort ?? (() => randomFreePort([])))().catch((error: unknown) => {
    throw new AtomicCoreError(
      'MODEL_LOAD_FAILED',
      'No free port for the decision model.',
      error instanceof Error ? error.message : String(error)
    )
  })
  const apiKey = (deps.apiKey ?? (() => randomBytes(24).toString('base64url')))()
  const args = decisionArgsFor(spec, port)
  log('info', `starting the decision model: ${commandSummary(exe, args)}`)
  const { env, cwd } = buildProcessEnv({
    platform,
    baseEnv,
    exeDir: dirname(exe),
    cuda: discoverCudaPaths(nodeCudaProbeEnv(platform, baseEnv)),
    userEnv: decisionEnv(apiKey),
  })

  const tail: string[] = []
  const reportOutput = backendOutputReporter(deps.backendOutput, deps.log)
  const modelLabel = spec.modelId || 'decision'
  const onLine = (stream: 'stdout' | 'stderr', line: string) => {
    reportOutput({ provider: 'decision', model: modelLabel, stream, line })
    if (tail.length >= DECISION_TAIL_CAPACITY) tail.shift()
    tail.push(line)
  }
  const proc = (deps.spawn ?? ((s, cb) => spawnManaged(s, cb, { captureOutput: false })))(
    { exe, args, env, cwd },
    onLine
  )
  let exit: ExitInfo | undefined
  void proc.exited.then((e) => (exit = e))
  const baseUrl = `http://${DECISION_HOST}:${port}`
  const terminate = (graceMs = DECISION_TERMINATE_GRACE_MS) => proc.terminate(graceMs)

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
      return fail(0, new AtomicCoreError('DECISION_UNAVAILABLE', 'The decision model start was stopped.'))
    const spawnFailure = proc.spawnFailure()
    if (spawnFailure) {
      await deps.onGone?.(proc.pid)
      throw new AtomicCoreError(
        'MODEL_LOAD_FAILED',
        'The decision engine could not be started.',
        `${exe}: ${spawnFailure.message}`
      )
    }
    if (exit !== undefined) {
      // Give the pipes a moment to deliver the final lines.
      await sleep(50)
      await deps.onGone?.(proc.pid)
      const error = earlyExitError(exit, tail)
      log('warn', `the decision model exited while loading (${describeExit(exit)})`)
      throw error
    }
    if (now() >= deadline)
      return fail(
        DECISION_TERMINATE_GRACE_MS,
        new AtomicCoreError(
          'MODEL_LOAD_TIMED_OUT',
          `The decision model did not become ready within ${Math.round(spec.startupTimeoutMs / 1000)} seconds.`,
          [lastDetail, ...tail.slice(-10)].filter(Boolean).join('\n') || undefined
        )
      )
    const result = await checkReadiness(
      deps.http,
      baseUrl,
      apiKey,
      READINESS_REQUEST_TIMEOUT_MS,
      spec.engine.dialect
    )
    if (result.kind === 'ready') {
      log(
        'info',
        `the decision model is ready on port ${port} (${result.props.layout ?? 'unknown layout'}, ${result.props.model_id ?? 'unnamed'})`
      )
      return {
        pid: proc.pid,
        port,
        apiKey,
        exe,
        baseUrl,
        props: result.props,
        capabilities: result.capabilities,
        tail: () => [...tail],
        exitStatus: () => exit,
        exited: proc.exited,
        terminate,
      }
    }
    if (result.kind === 'unsupported')
      return fail(
        DECISION_TERMINATE_GRACE_MS,
        new AtomicCoreError(
          'DECISION_ENGINE_UNSUPPORTED',
          spec.engine.dialect === 'upstream'
            ? 'The engine started but does not serve the model as a decision model.'
            : 'The engine started but does not serve decision API version 1.',
          `${exe}: ${result.detail}`
        )
      )
    lastDetail = result.detail
    await sleep(deps.pollIntervalMs ?? READY_POLL_INTERVAL_MS)
  }
}
