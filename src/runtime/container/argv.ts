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
 * separately strips `DOCKER_HOST`/`DOCKER_CONTEXT` and points `DOCKER_CONFIG` at an empty,
 * core-owned directory, so between the two, no user Docker context is ever consulted (spec
 * `tensorrt-llm-runtime`, "the model container is isolated"). `buildCreateModelContainerArgv`/
 * `buildRunOnceArgv` also add `--pull=never` (review round 1, item 5 ruling): the only thing in this
 * module that fetches image bytes is `pull.ts`'s `pullImage`, over the Engine API — `docker
 * create`/`docker run` must never trigger an implicit pull of their own, which would otherwise use
 * whatever registry auth `DOCKER_CONFIG`'s directory happens to hold.
 */
import path from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'
import type {
  ContainerUser,
  ImageRef,
  ModelContainerCreateSpec,
  ModelContainerLabels,
  OneShotRunSpec,
} from './types.js'

/**
 * The one path to the Docker daemon's system socket, in its two textual forms `argv.ts` and
 * `pull.ts` each need. `pull.ts` derives its `node:http` `socketPath` from `DOCKER_SOCKET_PATH`
 * rather than declaring its own literal (review round 1, item 15), so there is exactly one socket
 * path constant in this module.
 */
export const DOCKER_SOCKET_PATH = '/var/run/docker.sock'
/** Forced with every docker CLI call; no user Docker context (`DOCKER_HOST`/context/config) is ever used. */
export const DOCKER_SYSTEM_SOCKET = `unix://${DOCKER_SOCKET_PATH}`

/** Docker socket paths (and their parent directories) that must never be used as a mount source — bind-mounting one of these into the container would hand it the socket even though no `-v` flag ever names it directly. */
const FORBIDDEN_MOUNT_SOURCES = new Set(['/var/run/docker.sock', '/run/docker.sock', '/var/run', '/run'])

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

/** The largest `--shm-size` this module will build, regardless of what a caller passes in `shmSize`. */
export const MODEL_CONTAINER_SHM_SIZE_CEILING_GB = 16

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/
const NEWLINE_CHARS = /[\n\r]/
/** An env or label key: `KEY=value`/`atomic.key=value` always starts with this, so the leading
 *  character can never be misread as a docker flag regardless of what the value contains. */
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/
/** `nvidia-smi -L`'s two UUID spellings: `GPU-<uuid>` and, for a MIG slice, `MIG-<uuid>`. */
const GPU_UUID_PATTERN = /^(GPU|MIG)-[0-9A-Fa-f-]+$/
/** An integer byte count with a Docker size suffix, e.g. `2g`, `512m`, `65536k`. */
const SHM_SIZE_PATTERN = /^([0-9]+)(k|m|g)$/
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

/** Shared by env and label keys: both are the `KEY` half of a `KEY=value` argv token. */
function assertIdentifier(value: string, what: string): string {
  if (!IDENTIFIER_PATTERN.test(value)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `${what} is not a valid identifier.`, value)
  }
  return value
}

/**
 * An env *value* embedded in `-e KEY=value`: the key half is already validated as an identifier that
 * cannot start with `-`, so the whole argv token can never be misread as a flag regardless of what
 * the value contains — unlike a standalone value, this one only needs the control-character guard
 * (review round 1, item 16: rejecting a leading `-` here wrongly refused an ordinary value like
 * `TEMPERATURE=-0.5`). Empty is allowed: `FOO=` is a legitimate way to set an empty env var.
 */
function assertEnvValue(value: string, what: string): string {
  if (hasControlChars(value)) invalidArgument(what, value)
  return value
}

function assertGpuUuid(value: string): string {
  if (!GPU_UUID_PATTERN.test(value)) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'gpu id is not a GPU-<uuid>/MIG-<uuid> value.', value)
  }
  return value
}

/** `--shm-size=<value>`: an integer with a `k`/`m`/`g` suffix, capped at `MODEL_CONTAINER_SHM_SIZE_CEILING_GB`. */
function assertShmSize(value: string): string {
  const match = SHM_SIZE_PATTERN.exec(value)
  if (!match) {
    throw new AtomicCoreError('INVALID_ARGUMENT', 'shm size is not an integer with a k/m/g suffix.', value)
  }
  const [, digits, unit] = match as unknown as [string, string, 'k' | 'm' | 'g']
  const amount = Number(digits)
  const gib = unit === 'g' ? amount : unit === 'm' ? amount / 1024 : amount / (1024 * 1024)
  if (gib > MODEL_CONTAINER_SHM_SIZE_CEILING_GB) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `shm size must not exceed ${MODEL_CONTAINER_SHM_SIZE_CEILING_GB}g.`,
      value
    )
  }
  return value
}

/** A uid or gid: a non-negative safe integer, so `--user` only ever carries `<digits>:<digits>`. */
function assertUserId(value: number, what: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `${what} is not a non-negative integer id.`, String(value))
  }
  return String(value)
}

/** `--user <uid>:<gid>`, or nothing: the image's own user. */
function userFlags(user: ContainerUser | undefined): string[] {
  if (user === undefined) return []
  return ['--user', `${assertUserId(user.uid, 'container uid')}:${assertUserId(user.gid, 'container gid')}`]
}

/** Normalizes a POSIX (Docker-daemon-side) path: no trailing slash, `.`/`..` resolved, for exact/prefix comparison. */
function normalizeMountPath(value: string): string {
  const normalized = path.posix.normalize(value)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

/**
 * A mount source must be an absolute path (the Docker daemon's own view, never a relative path it
 * would resolve against some unpredictable cwd), must not contain `:` (the character `-v`'s own
 * `source:target:options` syntax splits on — a `:` inside the source would be read as the start of
 * the target), and must not be the Docker socket file or a directory that contains it (review round
 * 1, item 1): none of the four mounts this module builds names the socket directly, but a source
 * that IS `/var/run` (or its ancestor) would still hand the container the socket as a side effect of
 * mounting its parent.
 */
function assertMountSource(source: string, what: string): string {
  assertSafeArgvValue(source, what)
  if (!source.startsWith('/')) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `${what} must be an absolute path.`, source)
  }
  if (source.includes(':')) {
    throw new AtomicCoreError('INVALID_ARGUMENT', `${what} must not contain ':'.`, source)
  }
  if (FORBIDDEN_MOUNT_SOURCES.has(normalizeMountPath(source))) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `${what} must not be the Docker socket or a directory that contains it.`,
      source
    )
  }
  return source
}

/**
 * SELinux's `:z` relabels a directory for every container that shares it — spec `tensorrt-llm-runtime`
 * ("mounts work under SELinux") requires that this module never relabels anything outside its own
 * data (design D15). `dataRoot` is the one directory this executor owns; every `:z`-relabeled source
 * must be it, or under it.
 */
function assertWithinDataRoot(source: string, dataRoot: string, what: string): void {
  const normalizedRoot = normalizeMountPath(dataRoot)
  const normalizedSource = normalizeMountPath(source)
  const prefix = normalizedRoot === '/' ? '/' : `${normalizedRoot}/`
  if (normalizedSource !== normalizedRoot && !normalizedSource.startsWith(prefix)) {
    // Says what to do (final review M-6): typically a models folder that is a symlink to another
    // disk, which resolves outside the data folder — the only place this core relabels (design D15).
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      `The ${what} is outside the data folder (${normalizedRoot}), and under SELinux this core only ` +
        'relabels its own data folder for containers. A symlink to another disk resolves outside it: ' +
        'move the model folder into the data folder, or bind-mount the other disk at that path ' +
        'instead of linking it (mount --bind), so it resolves inside the data folder.',
      source
    )
  }
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

/**
 * `docker ps --all --filter ancestor=<repo@digest>`: every container, running or stopped, created
 * from this image (or an image built on it) — what removing an engine asks before deleting the
 * image, so an image someone else's container still uses is left in place (task 2.6).
 */
export function buildListContainersByImageArgv(image: ImageRef): string[] {
  return withSystemSocket([
    'ps',
    '--all',
    '--no-trunc',
    '--filter',
    `ancestor=${imageReference(image)}`,
    '--format',
    '{{.ID}}',
  ])
}

/**
 * `docker image rm <repo@digest>`, never `--force`: only the digest reference this core pulled is
 * removed, and Docker itself refuses while any container still uses the image. A tag the user added
 * to the same image keeps the image in place (task 2.6).
 */
export function buildRemoveImageArgv(image: ImageRef): string[] {
  return withSystemSocket(['image', 'rm', imageReference(image)])
}

/**
 * `--timestamps` prefixes every line with its RFC3339Nano time so `operations.ts`'s `containerLogs`
 * can merge stdout and stderr back into one chronological log (review round 1, item 2). `'all'` is
 * docker's own spelling for the whole log.
 */
export function buildLogsArgv(containerId: string, tailLines: number | 'all'): string[] {
  if (tailLines !== 'all' && (!Number.isInteger(tailLines) || tailLines < 1)) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'log tail length is not a positive integer.',
      String(tailLines)
    )
  }
  return withSystemSocket([
    'logs',
    '--timestamps',
    '--tail',
    String(tailLines),
    assertSafeArgvValue(containerId, 'container id'),
  ])
}

/**
 * `-v <source>:<target>:<mode>[,z]`; `:z` only when the caller says this Docker runs with SELinux
 * (design D15), and only once `source` is confirmed to be inside `dataRoot` — the caller
 * (`buildCreateModelContainerArgv`) has already refused to reach here with `selinux: true` and no
 * `dataRoot`.
 */
function mountFlag(
  source: string,
  target: string,
  mode: 'ro' | 'rw',
  selinux: boolean,
  dataRoot: string | undefined,
  what: string
): string[] {
  assertMountSource(source, what)
  if (selinux && dataRoot !== undefined) assertWithinDataRoot(source, dataRoot, what)
  const options = selinux ? `${mode},z` : mode
  return ['-v', `${source}:${target}:${options}`]
}

function labelFlags(labels: ModelContainerLabels): string[] {
  const flags: string[] = []
  for (const [key, value] of Object.entries(labels)) {
    assertIdentifier(key, `label key ${key}`)
    flags.push('-l', `atomic.${key}=${assertSafeArgvValue(value, `label ${key}`)}`)
  }
  return flags
}

function envFlags(env: Record<string, string> | undefined): string[] {
  if (!env) return []
  const flags: string[] = []
  for (const [key, value] of Object.entries(env)) {
    assertIdentifier(key, `env key ${key}`)
    flags.push('-e', `${key}=${assertEnvValue(value, `env ${key}`)}`)
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
 * The model container's `docker create` argv (spec `tensorrt-llm-runtime`, requirement "the model
 * container is isolated"; SELinux per requirement "mounts work under SELinux", design D15). Security
 * posture is not configurable by the spec: no docker socket mount, no `--privileged`, no
 * `--ipc=host`, `--restart=no` always, `--pull=never` always (review round 1, item 5 ruling — only
 * `pull.ts` fetches image bytes), and the port published only on `127.0.0.1`. Every option comes
 * before the positional image reference and command, so nothing derived from a descriptor or a probe
 * can land where Docker would read it as the start of a new flag. `spec.selinuxDataRoot` is required
 * whenever `spec.selinux` is true — see `assertWithinDataRoot`. `spec.user` runs the engine as the
 * core's own uid:gid rather than the image's root (final review I-1, ADR
 * 2026-09-29-the-engine-container-runs-as-the-invoking-user).
 */
export function buildCreateModelContainerArgv(spec: ModelContainerCreateSpec): string[] {
  const ref = imageReference(spec.image)
  const gpuUuid = assertGpuUuid(spec.gpuUuid)
  const host = assertLoopbackHost(spec.publication.host)
  // 0: Docker picks a free port on the loopback of the machine it runs on (the WSL guest, design D7 of
  // change `add-tensorrt-llm-windows`), read back afterwards with `docker port`.
  const hostPort = spec.publication.host_port === 0 ? '' : assertPort(spec.publication.host_port, 'host port')
  const containerPort = assertPort(spec.publication.container_port, 'container port')
  const shmSize = assertShmSize(spec.shmSize ?? MODEL_CONTAINER_SHM_SIZE)
  if (spec.selinux && spec.selinuxDataRoot === undefined) {
    throw new AtomicCoreError(
      'INVALID_ARGUMENT',
      'selinuxDataRoot is required to :z-relabel mounts under SELinux.',
      'selinuxDataRoot'
    )
  }
  const dataRoot = spec.selinux ? spec.selinuxDataRoot : undefined

  const args: string[] = [
    'create',
    '--restart=no',
    '--pull=never',
    `--shm-size=${shmSize}`,
    ...userFlags(spec.user),
    '--gpus',
    `device=${gpuUuid}`,
    ...mountFlag(
      spec.mounts.model.source,
      CONTAINER_MODEL_PATH,
      'ro',
      spec.selinux,
      dataRoot,
      'model mount source'
    ),
    ...mountFlag(
      spec.mounts.engineCache.source,
      CONTAINER_ENGINE_CACHE_PATH,
      'rw',
      spec.selinux,
      dataRoot,
      'engine cache mount source'
    ),
    ...mountFlag(
      spec.mounts.entrypoint.source,
      CONTAINER_ENTRYPOINT_PATH,
      'ro',
      spec.selinux,
      dataRoot,
      'entrypoint mount source'
    ),
    ...mountFlag(
      spec.mounts.heartbeat.source,
      CONTAINER_HEARTBEAT_PATH,
      'ro',
      spec.selinux,
      dataRoot,
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

/** `docker port <id> <port>/tcp`: where a running container's port was published. */
export function buildPortArgv(containerId: string, containerPort: number): string[] {
  return withSystemSocket([
    'port',
    assertSafeArgvValue(containerId, 'container id'),
    `${assertPort(containerPort, 'container port')}/tcp`,
  ])
}

/**
 * A one-shot `docker run --rm` probe (task 2.x's GPU check): no mounts, no port publication, no
 * restart policy, `--pull=never` (same reasoning as `buildCreateModelContainerArgv`).
 */
export function buildRunOnceArgv(spec: OneShotRunSpec): string[] {
  const ref = imageReference(spec.image)
  const args: string[] = ['run', '--rm', '--pull=never']
  if (spec.gpuUuid !== undefined) {
    args.push('--gpus', `device=${assertGpuUuid(spec.gpuUuid)}`)
  }
  args.push(...envFlags(spec.env), ref, ...commandWords(spec.command))
  return withSystemSocket(args)
}
