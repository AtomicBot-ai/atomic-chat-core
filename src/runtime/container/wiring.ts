/**
 * Core startup's half of the Docker executor (task 2.12; task 2.10 review carry-forward): on Linux,
 * with a docker CLI in a system directory, build the one `DockerExec` this core uses — the absolute
 * binary, the core-owned empty `DOCKER_CONFIG` — open this scope's execution journal, and reconcile
 * it before the first load can be served (spec `tensorrt-llm-runtime`, "Восстановление контейнеров
 * после перезапуска core"). `core/create.ts` calls this; the managed-text provider (task 2.14) keeps
 * the returned executor and journal for its lifecycle.
 */
import type { DataLayout } from '../../config/index.js'
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
  /** Deadline of each docker call the startup reconcile makes. Default `RECONCILE_CALL_TIMEOUT_MS`. */
  reconcileCallTimeoutMs?: number
  /** Past this, reconcile starts no further record. Default `RECONCILE_BUDGET_MS`. */
  reconcileBudgetMs?: number
}

/**
 * Startup must not wait on a hung daemon (task 2.12 review round 1, item 5): every reconcile call gets
 * this short deadline instead of the executor's usual 30 s, and `docker stop --time` is shortened to
 * match (`stopContainer` allows `--time` plus 5 s for its own call).
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
    return { exec, journal, dockerPath, reconciled }
  } finally {
    clearTimeout(timer)
  }
}
