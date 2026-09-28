/**
 * The docker operations the core needs to run a model container: pull-adjacent inspection, create,
 * start, a confirmed stop, rm, a log tail, and a one-shot `run` probe. Each one builds its argv
 * through `argv.ts` and runs it through an injected `DockerExec` (`exec.ts`'s `createDockerExec` in
 * production, a fake in tests) — this file never spawns anything itself.
 *
 * `docker ... inspect` and `docker rm` both treat "the thing is already gone" as a normal outcome,
 * not a failure: an inspect reports `found: false` and an `rm` of an already-removed container
 * resolves. Every other non-zero exit becomes `AtomicCoreError('IO_ERROR', ...)` with docker's own
 * stderr as the detail.
 */
import { AtomicCoreError } from '../../contracts/index.js'
import {
  buildCreateModelContainerArgv,
  buildInspectContainerArgv,
  buildInspectImageArgv,
  buildLogsArgv,
  buildRmArgv,
  buildRunOnceArgv,
  buildStartArgv,
  buildStopArgv,
} from './argv.js'
import type {
  DockerCommandResult,
  DockerExec,
  ImageRef,
  ModelContainerCreateSpec,
  OneShotRunSpec,
  StopOutcome,
} from './types.js'

/** `docker image/container inspect`'s answer: `value` is the first (only) element of docker's JSON array. */
export interface InspectResult {
  found: boolean
  value: unknown
}

const ABSENT_PATTERN = /no such (image|container)/i

function ioError(operation: string, result: DockerCommandResult): never {
  throw new AtomicCoreError('IO_ERROR', `docker ${operation} failed.`, result.stderr || result.stdout)
}

async function inspect(exec: DockerExec, argv: string[], operation: string): Promise<InspectResult> {
  const result = await exec(argv)
  if (result.code === 0) {
    const parsed = JSON.parse(result.stdout || '[]') as unknown[]
    return { found: parsed.length > 0, value: parsed[0] ?? null }
  }
  if (ABSENT_PATTERN.test(result.stderr)) return { found: false, value: null }
  ioError(operation, result)
}

export function inspectImage(exec: DockerExec, image: ImageRef): Promise<InspectResult> {
  return inspect(exec, buildInspectImageArgv(image), 'image inspect')
}

export function inspectContainer(exec: DockerExec, containerId: string): Promise<InspectResult> {
  return inspect(exec, buildInspectContainerArgv(containerId), 'container inspect')
}

/** Creates (but does not start) the model container; returns the id docker printed to stdout. */
export async function createContainer(
  exec: DockerExec,
  spec: ModelContainerCreateSpec
): Promise<{ containerId: string }> {
  const result = await exec(buildCreateModelContainerArgv(spec))
  if (result.code !== 0) ioError('create', result)
  const containerId = result.stdout.trim().split('\n').pop()?.trim() ?? ''
  if (containerId === '') {
    throw new AtomicCoreError('IO_ERROR', 'docker create produced no container id.', result.stdout)
  }
  return { containerId }
}

export async function startContainer(exec: DockerExec, containerId: string): Promise<void> {
  const result = await exec(buildStartArgv(containerId))
  if (result.code !== 0) ioError('start', result)
}

/**
 * Stops the container and waits for Docker to confirm it exited (or was already absent) — never
 * treats "our own exec call did not get an answer" as a stop (spec `tensorrt-llm-runtime`,
 * requirement "Выгрузка ждёт подтверждённой остановки"). `confirmed: false` is what a caller maps to
 * `MANAGED_STOP_UNCONFIRMED` and a held GPU reservation.
 */
export async function stopContainer(
  exec: DockerExec,
  containerId: string,
  timeoutSeconds: number
): Promise<StopOutcome> {
  let result: DockerCommandResult
  try {
    result = await exec(buildStopArgv(containerId, timeoutSeconds))
  } catch (error) {
    return { confirmed: false, reason: (error as Error).message }
  }
  if (result.code === 0) return { confirmed: true, status: 'exited' }
  if (ABSENT_PATTERN.test(result.stderr)) return { confirmed: true, status: 'absent' }
  return {
    confirmed: false,
    reason: result.stderr || result.stdout || `docker stop exited with code ${String(result.code)}`,
  }
}

/** Idempotent: a container already removed (or never created) is success, not an error. */
export async function removeContainer(exec: DockerExec, containerId: string): Promise<void> {
  const result = await exec(buildRmArgv(containerId))
  if (result.code === 0) return
  if (ABSENT_PATTERN.test(result.stderr)) return
  ioError('rm', result)
}

/**
 * The last `tailLines` lines of the container's log (spec `tensorrt-llm-runtime`, "Логи контейнера
 * доступны"). Returns only `stdout`: Docker writes a container's stdout and stderr to two separate
 * file descriptors with no combined chronological order available without deeper work (a demuxed
 * read plus manual interleaving); `trtllm-serve`'s own logging is expected on stdout.
 */
export async function containerLogs(
  exec: DockerExec,
  containerId: string,
  tailLines: number
): Promise<string> {
  const result = await exec(buildLogsArgv(containerId, tailLines))
  if (result.code !== 0) ioError('logs', result)
  return result.stdout
}

/** A one-shot `docker run --rm` probe (task 2.x's GPU check): the raw result, never thrown — the caller classifies it. */
export function runOnce(exec: DockerExec, spec: OneShotRunSpec): Promise<DockerCommandResult> {
  return exec(buildRunOnceArgv(spec))
}
