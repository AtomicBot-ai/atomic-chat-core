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
 *
 * `createContainer` is also where symlinks get resolved (review round 2, item 2): it is the one
 * function in this module that does filesystem I/O of its own, `realpath`-ing every mount source and
 * `selinuxDataRoot` before handing them to `argv.ts`'s pure (and therefore symlink-blind) checks.
 */
import { realpath as fsRealpath } from 'node:fs/promises'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  buildCreateModelContainerArgv,
  buildInspectContainerArgv,
  buildInspectImageArgv,
  buildListContainersByImageArgv,
  buildLogsArgv,
  buildRemoveImageArgv,
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
  Realpath,
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
    let parsed: unknown[]
    try {
      parsed = JSON.parse(result.stdout || '[]') as unknown[]
    } catch (error) {
      // A 0 exit with unparseable stdout is not "the thing is absent" — it is docker (or a fake in
      // tests) answering in a shape this module does not understand; surface it as our own error
      // rather than letting a raw SyntaxError escape (review round 1, item 12).
      throw new AtomicCoreError(
        'IO_ERROR',
        `docker ${operation} produced output that is not valid JSON.`,
        `${(error as Error).message}\n${result.stdout}`
      )
    }
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

export interface CreateContainerDeps {
  /** Defaults to `node:fs/promises`'s `realpath`; tests inject a fake or a real symlinked tmpdir. */
  realpath?: Realpath
}

async function resolveOrThrow(realpath: Realpath, path: string, what: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `${what} could not be resolved to a real path.`,
      `${path}: ${(error as Error).message}`
    )
  }
}

/**
 * Resolves every mount source and `selinuxDataRoot` to their canonical, symlink-free real path
 * before argv is built (review round 2, item 2, controller ruling). `argv.ts`'s
 * `assertMountSource`/`assertWithinDataRoot` are pure lexical string checks — a mount source that is
 * a symlink *inside* an allowed SELinux data root but that points *outside* it would pass those
 * checks unresolved, while Docker's actual bind mount (and its `:z` relabel) act on the resolved
 * target, not the symlink's own path. Running every source through `realpath` here, before it ever
 * reaches the pure argv layer, means the checks there always see what Docker will actually mount.
 */
async function canonicalizeCreateSpec(
  spec: ModelContainerCreateSpec,
  realpath: Realpath
): Promise<ModelContainerCreateSpec> {
  const [model, engineCache, entrypoint, heartbeat, selinuxDataRoot] = await Promise.all([
    resolveOrThrow(realpath, spec.mounts.model.source, 'model mount source'),
    resolveOrThrow(realpath, spec.mounts.engineCache.source, 'engine cache mount source'),
    resolveOrThrow(realpath, spec.mounts.entrypoint.source, 'entrypoint mount source'),
    resolveOrThrow(realpath, spec.mounts.heartbeat.source, 'heartbeat mount source'),
    spec.selinuxDataRoot === undefined
      ? Promise.resolve(undefined)
      : resolveOrThrow(realpath, spec.selinuxDataRoot, 'selinuxDataRoot'),
  ])
  return {
    ...spec,
    mounts: {
      model: { source: model },
      engineCache: { source: engineCache },
      entrypoint: { source: entrypoint },
      heartbeat: { source: heartbeat },
    },
    // `exactOptionalPropertyTypes`: only set the key at all when there is a value, rather than
    // assigning `selinuxDataRoot: undefined` (a real, if empty, distinct state under that setting).
    ...(selinuxDataRoot === undefined ? {} : { selinuxDataRoot }),
  }
}

/** Creates (but does not start) the model container; returns the id docker printed to stdout. */
export async function createContainer(
  exec: DockerExec,
  spec: ModelContainerCreateSpec,
  deps: CreateContainerDeps = {}
): Promise<{ containerId: string }> {
  const realpath = deps.realpath ?? fsRealpath
  const canonicalSpec = await canonicalizeCreateSpec(spec, realpath)
  const result = await exec(buildCreateModelContainerArgv(canonicalSpec))
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
 * Extra time given to the *exec call itself* beyond `docker stop`'s own `--time <timeoutSeconds>`
 * (review round 1, item 3). `exec.ts`'s default exec deadline is 30 s; without this, any
 * `timeoutSeconds` beyond ~30 would have our own exec call killed and reported unconfirmed before
 * Docker's own `--time` even elapsed, which is not "unconfirmed" — it is this module cutting the
 * call short before Docker had a chance to answer.
 */
const STOP_EXEC_MARGIN_MS = 5_000

/**
 * Stops the container and waits for Docker to confirm it exited (or was already absent) — never
 * treats "our own exec call did not get an answer" as a stop (spec `tensorrt-llm-runtime`,
 * requirement "unloading waits for a confirmed stop"). `confirmed: false` is what a caller maps to
 * `MANAGED_STOP_UNCONFIRMED` and a held GPU reservation.
 */
export async function stopContainer(
  exec: DockerExec,
  containerId: string,
  timeoutSeconds: number
): Promise<StopOutcome> {
  // Built outside the try: an INVALID_ARGUMENT from a bad timeout is a programming error this
  // caller should see directly, not a report that the stop went unconfirmed (review round 1, item 9).
  const argv = buildStopArgv(containerId, timeoutSeconds)
  let result: DockerCommandResult
  try {
    result = await exec(argv, { timeoutMs: timeoutSeconds * 1000 + STOP_EXEC_MARGIN_MS })
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

/** Ids of every container, running or stopped, created from `image`. Fails when docker cannot answer. */
export async function containersUsingImage(exec: DockerExec, image: ImageRef): Promise<string[]> {
  const result = await exec(buildListContainersByImageArgv(image))
  if (result.code !== 0) ioError('ps', result)
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
}

/** Removes the digest reference; an image already gone is `absent`, anything else docker refuses throws. */
export async function removeImage(exec: DockerExec, image: ImageRef): Promise<'removed' | 'absent'> {
  const result = await exec(buildRemoveImageArgv(image))
  if (result.code === 0) return 'removed'
  if (ABSENT_PATTERN.test(result.stderr)) return 'absent'
  ioError('image rm', result)
}

/**
 * Docker writes a container's stdout and stderr to two separate file descriptors; `buildLogsArgv`
 * asks for `--timestamps` on both so they can be merged back into one chronologically ordered log
 * (review round 1, item 2 — the lifecycle needs a combined tail to classify an OOM exit, which
 * `trtllm-serve` can report on either stream). Each line is expected to start with Docker's
 * RFC3339Nano timestamp followed by a space; timestamps in that spelling sort correctly as plain
 * strings, so this is a stable two-way merge, not a `Date` parse. A line with no recognizable
 * timestamp (should not happen with `--timestamps`, but this must not crash on one) sorts using its
 * own text, which only affects placement relative to other such lines.
 */
function timestampOf(line: string): string {
  const spaceIndex = line.indexOf(' ')
  return spaceIndex === -1 ? line : line.slice(0, spaceIndex)
}

function mergeTimestampedLogs(stdout: string, stderr: string): string {
  const stdoutLines = stdout.split('\n').filter((line) => line !== '')
  const stderrLines = stderr.split('\n').filter((line) => line !== '')
  const merged: string[] = []
  let i = 0
  let j = 0
  while (i < stdoutLines.length && j < stderrLines.length) {
    if (timestampOf(stdoutLines[i]!) <= timestampOf(stderrLines[j]!)) merged.push(stdoutLines[i++]!)
    else merged.push(stderrLines[j++]!)
  }
  while (i < stdoutLines.length) merged.push(stdoutLines[i++]!)
  while (j < stderrLines.length) merged.push(stderrLines[j++]!)
  return merged.length === 0 ? '' : merged.join('\n') + '\n'
}

/** The last `tailLines` lines of the container's combined, chronologically merged stdout+stderr log. */
export async function containerLogs(
  exec: DockerExec,
  containerId: string,
  tailLines: number
): Promise<string> {
  const result = await exec(buildLogsArgv(containerId, tailLines))
  if (result.code !== 0) ioError('logs', result)
  return mergeTimestampedLogs(result.stdout, result.stderr)
}

/** A one-shot `docker run --rm` probe (task 2.x's GPU check): the raw result, never thrown — the caller classifies it. */
export function runOnce(exec: DockerExec, spec: OneShotRunSpec): Promise<DockerCommandResult> {
  return exec(buildRunOnceArgv(spec))
}
