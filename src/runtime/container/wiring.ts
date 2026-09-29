/**
 * Core startup's half of the Docker executor (task 2.12; task 2.10 review carry-forward): on Linux,
 * with a docker CLI in a system directory, build the one `DockerExec` this core uses — the absolute
 * binary, the core-owned empty `DOCKER_CONFIG` — open this scope's execution journal, and reconcile
 * it before the first load can be served (spec `tensorrt-llm-runtime`, "Восстановление контейнеров
 * после перезапуска core"). `core/create.ts` calls this; the managed-text provider (task 2.14) keeps
 * the returned executor and journal for its lifecycle.
 */
import type { DataLayout } from '../../config/index.js'
import { DOCKER_SOCKET_PATH } from './argv.js'
import { resolveDockerBinary } from './docker-binary.js'
import { createDockerExec } from './exec.js'
import { ExecutionJournal } from './execution-journal.js'
import { reconcileExecutions } from './reconcile.js'
import type { ExecutionReconcileResult, ReconcileLogger } from './reconcile.js'
import type { DockerExec } from './types.js'

export interface WireManagedContainersOptions {
  /** Injected, never `process.platform` read here. */
  platform: NodeJS.Platform
  layout: DataLayout
  instanceId: string
  log: ReconcileLogger
  /** The docker CLI to run; `undefined` resolves it from the system directories, `null` means none. */
  dockerPath?: string | null
  /** The Docker Engine API socket image pulls stream from. Default `DOCKER_SOCKET_PATH`; a test seam. */
  dockerSocketPath?: string
  /**
   * Deadline of each `docker inspect`/`docker rm` the startup reconcile makes. Default
   * `RECONCILE_CALL_TIMEOUT_MS`. Not the stop's: `stopContainer` gives its own call `--time` plus 5 s.
   */
  reconcileCallTimeoutMs?: number
  /** Past this, reconcile starts no further record. Default `RECONCILE_BUDGET_MS`. */
  reconcileBudgetMs?: number
}

/**
 * Startup must not wait on a hung daemon (task 2.12 review round 1, item 5): each `docker inspect` and
 * `docker rm` of the reconcile gets this short deadline instead of the executor's usual 30 s. The stop
 * is bounded separately: `docker stop --time RECONCILE_STARTUP_STOP_TIMEOUT_SECONDS`, whose own call
 * deadline `stopContainer` sets to that plus 5 s. That shorter `--time` also halves the grace a
 * leftover engine gets between SIGTERM and SIGKILL (5 s instead of an unload's 10 s).
 */
export const RECONCILE_CALL_TIMEOUT_MS = 10_000
export const RECONCILE_STARTUP_STOP_TIMEOUT_SECONDS = 5
/**
 * No record is started after this. Worst case, startup waits this long plus one record's three calls
 * (inspect, stop, rm) at `RECONCILE_CALL_TIMEOUT_MS` each; anything left is reconciled next startup.
 */
export const RECONCILE_BUDGET_MS = 20_000

export interface ManagedContainers {
  exec: DockerExec
  journal: ExecutionJournal
  dockerPath: string
  /** Where `pullImage` reaches the Engine API (the system socket outside tests). */
  socketPath: string
  reconciled: ExecutionReconcileResult
}

/** `null` off Linux, or when no docker CLI is installed: there is nothing to run a container with. */
export async function wireManagedContainers(
  options: WireManagedContainersOptions
): Promise<ManagedContainers | null> {
  if (options.platform !== 'linux') return null
  const dockerPath = options.dockerPath === undefined ? await resolveDockerBinary() : options.dockerPath
  if (dockerPath === null) return null
  const exec = createDockerExec({ dockerPath, dockerConfigDir: options.layout.managed.dockerConfigDir })
  const journal = await ExecutionJournal.open(options.layout)
  const reconcileExec = createDockerExec({
    dockerPath,
    dockerConfigDir: options.layout.managed.dockerConfigDir,
    timeoutMs: options.reconcileCallTimeoutMs ?? RECONCILE_CALL_TIMEOUT_MS,
  })
  const budget = new AbortController()
  const timer = setTimeout(() => budget.abort(), options.reconcileBudgetMs ?? RECONCILE_BUDGET_MS)
  timer.unref?.()
  try {
    const reconciled = await reconcileExecutions(
      journal,
      options.instanceId,
      reconcileExec,
      options.log,
      RECONCILE_STARTUP_STOP_TIMEOUT_SECONDS,
      budget.signal
    )
    return {
      exec,
      journal,
      dockerPath,
      socketPath: options.dockerSocketPath ?? DOCKER_SOCKET_PATH,
      reconciled,
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The one Docker executor of this core, wired lazily (task 2.6; carry-forward from 2.8/2.12: keep
 * the startup handle, never construct a second). Core startup resolves it once, which reconciles
 * the execution journal as before. On a machine with no docker CLI at startup it stays null — until
 * the setup's privileged step installs Docker, when the next caller wires it then. Every caller —
 * the environment setup, and the managed-text provider (task 2.14) — goes through the same handle,
 * so there is only ever one executor and one journal per core.
 */
export interface ManagedContainersHandle {
  /** What has been wired so far, without trying again. */
  current(): ManagedContainers | null
  /** The executor, wiring it on first use and retrying after a start that found no docker CLI. */
  resolve(): Promise<ManagedContainers | null>
}

export function createManagedContainersHandle(
  options: WireManagedContainersOptions,
  wire: (options: WireManagedContainersOptions) => Promise<ManagedContainers | null> = wireManagedContainers
): ManagedContainersHandle {
  let wired: ManagedContainers | null = null
  let inFlight: Promise<ManagedContainers | null> | null = null
  return {
    current: () => wired,
    resolve: () => {
      if (wired !== null) return Promise.resolve(wired)
      // Two callers at once share one attempt: two attempts would open the journal twice.
      inFlight ??= wire(options)
        .then((result) => {
          wired = result
          return result
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
  }
}
