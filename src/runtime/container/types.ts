/**
 * Types for the Docker executor (task 2.8, openspec change `add-tensorrt-llm-linux`): building the
 * argv for one model container's lifecycle, running it with no shell, and reading back what Docker
 * reports.
 *
 * `ImageRef` reuses the contracts' `PlatformImage` shape (`repository` + a pinned `sha256:` digest)
 * rather than redeclaring it, since a descriptor's `image['linux/amd64']` (task 2.1,
 * `src/contracts/environment.ts`) is exactly what this module pulls, inspects and creates from.
 * `ModelContainerCreateSpec.publication` is `managed-text`'s `HostPublication` (task 2.7): the
 * deployment seam already resolved which host port and container port to publish, so this module
 * only turns that decision into argv, never makes it.
 */
import type { PlatformImage } from '../../contracts/index.js'
import type { HostPublication } from '../managed-text/index.js'

/** A platform's pinned image: a bare repository plus its `sha256:` digest, never a tag. */
export type ImageRef = PlatformImage

/** Where a mount's source lives in the Docker daemon's own filesystem view (`MountSourceResolver`, task 2.7). */
export interface DockerMountSource {
  source: string
}

/** The four directories `tensorrt-llm-runtime`'s isolation and SELinux requirements name by role. */
export interface ModelContainerMounts {
  /** Read-only: the model's weight files. */
  model: DockerMountSource
  /** Read-write: the engine's build cache, keyed by descriptor + model, kept across loads. */
  engineCache: DockerMountSource
  /** Read-only: the watchdog entrypoint script core embeds and writes to disk (task 2.9). */
  entrypoint: DockerMountSource
  /** Read-only: the heartbeat file core refreshes from the host side (task 2.9/2.12). */
  heartbeat: DockerMountSource
}

/** Discovery-only labels (never an authority for "is this ours"; the execution journal, task 2.10, is). */
export interface ModelContainerLabels {
  engine_id: string
  scope: string
  instance_id: string
}

/**
 * The numeric user and group a model container runs as (`--user <uid>:<gid>`): the core's own, so
 * everything the engine writes into the read-write engine cache stays owned by — and removable by —
 * the user who owns the data folder (final review I-1). Numeric only: the image has no passwd entry
 * for this user, which is why the lifecycle also sets `HOME`/`USER`/`LOGNAME` for it.
 */
export interface ContainerUser {
  uid: number
  gid: number
}

/** Everything `buildCreateModelContainerArgv` needs to build one model container's `docker create` argv. */
export interface ModelContainerCreateSpec {
  image: ImageRef
  /** The NVIDIA GPU UUID this container is pinned to (`--gpus device=<uuid>`); never more than one card. */
  gpuUuid: string
  /** Whether this Docker installation runs with SELinux enforcing (`docker info` `SecurityOptions`, design D15). */
  selinux: boolean
  /**
   * The one directory this executor owns and may `:z`-relabel. Required when `selinux` is true: every
   * mount source must be it, or under it (spec "mounts work under SELinux" — never relabel outside
   * this executor's own data, review round 1 item 1). Ignored when `selinux` is false.
   */
  selinuxDataRoot?: string
  mounts: ModelContainerMounts
  publication: HostPublication
  labels: ModelContainerLabels
  /** Defaults to `MODEL_CONTAINER_SHM_SIZE`; overridable for tests and for the eventual live-measured value. */
  shmSize?: string
  /** `--user <uid>:<gid>`; absent, the image's own user (root for the NGC TensorRT-LLM release image). */
  user?: ContainerUser
  env?: Record<string, string>
  command?: string[]
}

/** A one-shot `docker run --rm` probe: no mounts, no port publication (task 2.x's GPU check). */
export interface OneShotRunSpec {
  image: ImageRef
  gpuUuid?: string
  env?: Record<string, string>
  command?: string[]
}

/**
 * Resolves symlinks/`.`/`..` to a canonical absolute path (`node:fs/promises`'s `realpath` in
 * production; a test injects a fake). `operations.ts`'s `createContainer` runs every mount source and
 * `selinuxDataRoot` through one of these before building argv (review round 2, item 2 — controller
 * ruling): `argv.ts`'s `assertMountSource`/`assertWithinDataRoot` are lexical string checks, so a
 * symlink *inside* an allowed data root that points *outside* it would pass them unresolved, while
 * Docker's `:z` (and the bind mount itself) act on the resolved target, not the symlink's own path.
 */
export type Realpath = (path: string) => Promise<string>

/** What one docker CLI invocation answered. `code: null` means it never got as far as an exit code. */
export interface DockerCommandResult {
  code: number | null
  stdout: string
  stderr: string
}

/** Per-call overrides a caller may pass to one `DockerExec` invocation (review round 1, item 3). */
export interface DockerExecCallOptions {
  /** Overrides the exec's own default deadline for just this call — `stopContainer` extends it past
   *  `--time <timeoutSeconds>` so a legitimately slow stop is not mistaken for an unconfirmed one. */
  timeoutMs?: number
}

/**
 * Runs one already-built argv against the real `docker`, or a fake, and reports what happened. The
 * second parameter is additive (review round 1, item 3): an existing fake typed
 * `(args: string[]) => Promise<DockerCommandResult>` — ignoring a second argument — remains a valid
 * `DockerExec` with no change.
 */
export type DockerExec = (args: string[], options?: DockerExecCallOptions) => Promise<DockerCommandResult>

/**
 * Whether a stop is safe to treat as done. `confirmed: false` covers both "docker answered with an
 * error we don't recognize" and "we never got an answer at all" (our own exec call's timeout is not
 * evidence the container stopped) — later tasks map an unconfirmed stop to `MANAGED_STOP_UNCONFIRMED`
 * and keep holding the GPU reservation.
 */
export type StopOutcome =
  { confirmed: true; status: 'exited' | 'absent' } | { confirmed: false; reason: string }

/** Bytes pulled so far, summed across every image layer that has reported a size. */
export interface PullProgress {
  current: number
  total: number
}

export type PullProgressCallback = (progress: PullProgress) => void
