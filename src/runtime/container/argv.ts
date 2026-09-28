/**
 * Pure Docker CLI argv construction. Nothing in this file touches the filesystem or a process; every
 * function here takes data and returns a `string[]` a caller passes straight to `spawn`/`execFile`
 * with no shell (`exec.ts`), so nothing a descriptor or a probe produced is ever interpreted as a
 * flag or a shell word.
 *
 * `assertSafeArgvValue` is the one guard every descriptor- or probe-derived value goes through
 * before it becomes an argv token: no leading `-` (which Docker would read as a flag) and no NUL,
 * `\n` or `\r` (which would smuggle a second argv-like word past a naive splitter, or corrupt a
 * `-v`/`-l`/`-e` value that gets joined with `:`/`=`). This is a carry-forward from the task 2.1
 * review: conf's `imageRepository` pattern (`schema.json#/definitions/imageRepository`) permits a
 * leading `-`, so a descriptor field like `repository: "-foo/bar"` passes descriptor validation and
 * must still be caught here, one layer closer to the actual `spawn` call. Every option in
 * `buildCreateModelContainerArgv`/`buildRunOnceArgv` is placed before the image reference and any
 * command words, so a positional value can never be mistaken for the start of a new flag either.
 *
 * `--host unix:///var/run/docker.sock` is prepended to every argv by `withSystemSocket`; `env.ts`
 * separately strips `DOCKER_HOST`/`DOCKER_CONTEXT`/`DOCKER_CONFIG` from the child's environment, so
 * between the two, no user Docker context is ever consulted (spec `tensorrt-llm-runtime`, "Контейнер
 * модели изолирован").
 */
import { AtomicCoreError } from '../../contracts/index.js'
import type { ImageRef, ModelContainerCreateSpec, ModelContainerLabels, OneShotRunSpec } from './types.js'

/** Forced with every docker CLI call; no user Docker context (`DOCKER_HOST`/context/config) is ever used. */
export const DOCKER_SYSTEM_SOCKET = 'unix:///var/run/docker.sock'

/** Container-side mount targets. Fixed by this module; callers only choose the host-side source. */
export const CONTAINER_MODEL_PATH = '/atomic/model'
export const CONTAINER_ENGINE_CACHE_PATH = '/atomic/engine-cache'
export const CONTAINER_ENTRYPOINT_PATH = '/atomic/entrypoint.sh'
export const CONTAINER_HEARTBEAT_PATH = '/atomic/heartbeat'

/**
 * `--shm-size` for the model container. A named placeholder, not a measurement: the real value is
 * measured against a live `trtllm-serve` load in live test 2.19. Bounded rather than left at
 * Docker's 64 MB default, which a multi-worker CUDA server exhausts immediately, and rather than
 * unbounded (`--shm-size` with no limit maps to host memory, defeating the point of a limit).
 */
export const MODEL_CONTAINER_SHM_SIZE = '2g'

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const NEWLINE_CHARS = /[\n\r]/
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const DESKTOP_LOOPBACK_HOST = '127.0.0.1'

function invalidArgument(what: string, value: string): never {
  throw new AtomicCoreError('INVALID_ARGUMENT', `${what} is not safe to pass to docker.`, value)
}

/** A NUL byte or a `\n`/`\r`: anything that could smuggle a second argv-like word past a naive splitter. */
function hasControlChars(value: string): boolean {
  return value.includes('\u0000') || NEWLINE_CHARS.test(value)
}

/**
 * Refuses an empty value, a leading `-` (would be read as a flag), or an embedded NUL/`\n`/`\r`.
 * Every image reference, GPU id, mount source, label value, env value and command word passes
 * through this before becoming an argv token.
 */
export function assertSafeArgvValue(value: string, what: string): string {
  if (value === '') invalidArgument(what, value)
  if (value.startsWith('-')) invalidArgument(what, value)
  if (hasControlChars(value)) invalidArgument(what, value)
  return value
}

/** Shared with `pull.ts`, which needs the repository and digest validated but not joined by `@`. */
export function assertDigest(value: string, what: string): string {
  if (!DIGEST_PATTERN.test(value)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `${what} is not a sha256 digest.`, value)
  }
  return value
}

function assertPort(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `${what} is not a valid TCP port.`, String(value))
  }
  return value
}

/** The model container's port may only ever be published on the literal desktop loopback address. */
function assertLoopbackHost(host: string): string {
  if (host !== DESKTOP_LOOPBACK_HOST) {
    throw new AtomicCoreError(
      'FORBIDDEN_HOST',
      `A model container may only publish its port on ${DESKTOP_LOOPBACK_HOST}.`,
      host
    )
  }
  return host
}

function assertEnvKey(key: string): string {
  if (!ENV_KEY_PATTERN.test(key)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'env variable name is not a valid identifier.', key)
  }
  return key
}

/** `repository@digest`, safe only once both halves — and the joined value itself — are validated. */
export function imageReference(image: ImageRef): string {
  const repository = assertSafeArgvValue(image.repository, 'image repository')
  const digest = assertDigest(image.digest, 'image digest')
  return assertSafeArgvValue(`${repository}@${digest}`, 'image reference')
}

/** Prepend the forced system-socket connection flag to any docker subcommand argv. */
export function withSystemSocket(args: readonly string[]): string[] {
  return ['--host', DOCKER_SYSTEM_SOCKET, ...args]
}

export function buildInspectImageArgv(image: ImageRef): string[] {
  return withSystemSocket(['image', 'inspect', imageReference(image)])
}

export function buildInspectContainerArgv(containerId: string): string[] {
  return withSystemSocket(['container', 'inspect', assertSafeArgvValue(containerId, 'container id')])
}

export function buildStartArgv(containerId: string): string[] {
  return withSystemSocket(['start', assertSafeArgvValue(containerId, 'container id')])
}

/**
 * `docker stop --time <timeoutSeconds> <id>`. The CLI call itself blocks until the daemon confirms
 * the container exited (or force-kills it at the timeout and waits for that kill to land) — what a
 * *caller* of this argv must not assume is that getting an answer at all is guaranteed; `operations.ts`
 * turns "no answer" into `StopOutcome.confirmed: false` rather than treating a silent exec failure as
 * a stop.
 */
export function buildStopArgv(containerId: string, timeoutSeconds: number): string[] {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 0) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'stop timeout is not a non-negative integer number of seconds.',
      String(timeoutSeconds)
    )
  }
  return withSystemSocket([
    'stop',
    '--time',
    String(timeoutSeconds),
    assertSafeArgvValue(containerId, 'container id'),
  ])
}

export function buildRmArgv(containerId: string): string[] {
  return withSystemSocket(['rm', assertSafeArgvValue(containerId, 'container id')])
}

export function buildLogsArgv(containerId: string, tailLines: number): string[] {
  if (!Number.isInteger(tailLines) || tailLines < 1) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'log tail length is not a positive integer.',
      String(tailLines)
    )
  }
  return withSystemSocket([
    'logs',
    '--tail',
    String(tailLines),
    assertSafeArgvValue(containerId, 'container id'),
  ])
}

/** `-v <source>:<target>:<mode>[,z]`; `:z` only when the caller says this Docker runs with SELinux (design D15). */
function mountFlag(
  source: string,
  target: string,
  mode: 'ro' | 'rw',
  selinux: boolean,
  what: string
): string[] {
  assertSafeArgvValue(source, what)
  const options = selinux ? `${mode},z` : mode
  return ['-v', `${source}:${target}:${options}`]
}

function labelFlags(labels: ModelContainerLabels): string[] {
  const flags: string[] = []
  for (const [key, value] of Object.entries(labels)) {
    flags.push('-l', `atomic.${key}=${assertSafeArgvValue(value, `label ${key}`)}`)
  }
  return flags
}

function envFlags(env: Record<string, string> | undefined): string[] {
  if (!env) return []
  const flags: string[] = []
  for (const [key, value] of Object.entries(env)) {
    assertEnvKey(key)
    flags.push('-e', `${key}=${assertSafeArgvValue(value, `env ${key}`)}`)
  }
  return flags
}

/**
 * Command words run *after* the image reference: Docker itself never parses them as its own flags,
 * it hands them straight to the container's entrypoint, so a leading `-` here is ordinary (e.g. a
 * program's own `--port 8000` or `-L`) rather than a flag-injection risk. Only the control-character
 * guard — which protects the argv boundary itself, not "did this look like a docker flag" — still
 * applies.
 */
function commandWords(command: string[] | undefined): string[] {
  if (!command) return []
  return command.map((word, i) => {
    if (word === '' || hasControlChars(word)) invalidArgument(`command[${i}]`, word)
    return word
  })
}

/**
 * The model container's `docker create` argv (spec `tensorrt-llm-runtime`, requirement "Контейнер
 * модели изолирован"; SELinux per requirement "Монтирования работают при SELinux", design D15).
 * Security posture is not configurable by the spec: no docker socket mount, no `--privileged`, no
 * `--ipc=host`, `--restart=no` always, and the port published only on `127.0.0.1`. Every option
 * comes before the positional image reference and command, so nothing derived from a descriptor or
 * a probe can land where Docker would read it as the start of a new flag.
 */
export function buildCreateModelContainerArgv(spec: ModelContainerCreateSpec): string[] {
  const ref = imageReference(spec.image)
  const gpuUuid = assertSafeArgvValue(spec.gpuUuid, 'gpu id')
  const host = assertLoopbackHost(spec.publication.host)
  const hostPort = assertPort(spec.publication.host_port, 'host port')
  const containerPort = assertPort(spec.publication.container_port, 'container port')

  const args: string[] = [
    'create',
    '--restart=no',
    `--shm-size=${spec.shmSize ?? MODEL_CONTAINER_SHM_SIZE}`,
    '--gpus',
    `device=${gpuUuid}`,
    ...mountFlag(spec.mounts.model.source, CONTAINER_MODEL_PATH, 'ro', spec.selinux, 'model mount source'),
    ...mountFlag(
      spec.mounts.engineCache.source,
      CONTAINER_ENGINE_CACHE_PATH,
      'rw',
      spec.selinux,
      'engine cache mount source'
    ),
    ...mountFlag(
      spec.mounts.entrypoint.source,
      CONTAINER_ENTRYPOINT_PATH,
      'ro',
      spec.selinux,
      'entrypoint mount source'
    ),
    ...mountFlag(
      spec.mounts.heartbeat.source,
      CONTAINER_HEARTBEAT_PATH,
      'ro',
      spec.selinux,
      'heartbeat mount source'
    ),
    '--entrypoint',
    CONTAINER_ENTRYPOINT_PATH,
    '-p',
    `${host}:${hostPort}:${containerPort}`,
    ...labelFlags(spec.labels),
    ...envFlags(spec.env),
    ref,
    ...commandWords(spec.command),
  ]
  return withSystemSocket(args)
}

/** A one-shot `docker run --rm` probe (task 2.x's GPU check): no mounts, no port publication, no restart policy. */
export function buildRunOnceArgv(spec: OneShotRunSpec): string[] {
  const ref = imageReference(spec.image)
  const args: string[] = ['run', '--rm']
  if (spec.gpuUuid !== undefined) {
    args.push('--gpus', `device=${assertSafeArgvValue(spec.gpuUuid, 'gpu id')}`)
  }
  args.push(...envFlags(spec.env), ref, ...commandWords(spec.command))
  return withSystemSocket(args)
}
