/**
 * Startup reconciliation of the execution journal (task 2.10): stop and remove the model containers
 * a previous core instance left running, before the first load of this instance can be served (spec
 * `tensorrt-llm-runtime`, "Восстановление контейнеров после перезапуска core"). Mirrors
 * `core/reap-orphans.ts`'s shape for the native-process journal, one level down in this module so
 * `core/create.ts` only ever calls an exported function, never touches Docker argv itself.
 *
 * Only a container whose id is recorded in the execution journal is ever inspected, stopped or
 * removed here. A container the host happens to be running — even one carrying this core's own
 * discovery labels (`ModelContainerLabels`, `types.ts`) — is left alone if it has no journal record:
 * labels are informational only, never an authority to act (spec: "Метки контейнера MUST NOT служить
 * единственным основанием для остановки"). "Belongs to a previous instance" is a plain instance-id
 * comparison, not a liveness probe of that other instance: `InstanceLock` (`src/lock/`) guarantees at
 * most one core owns a data folder at a time, so if *this* instance now holds the lock and journal, a
 * record stamped with any other instance id can only be a *former* owner's — there is no live
 * instance to disprove liveness against, unlike the native-process journal's `scanOrphans`, which
 * must disprove liveness of another *process* that might still be running unrelated to lock
 * ownership. This is documented rather than a call to `verifyProcessIdentity` because there is no
 * "other core process" identity to check here at all.
 */
import { inspectContainer, removeContainer, stopContainer } from './operations.js'
import type { ExecutionJournal, ExecutionRecord } from './execution-journal.js'
import type { DockerExec } from './types.js'

/** Structurally compatible with `core/types.ts`'s `CoreLogger`; kept local so this module never imports `core/`. */
export type ReconcileLogger = (level: 'info' | 'warn' | 'error', message: string) => void

/** `docker stop --time` for a reconciled orphan: generous, since nothing is waiting on this container. */
export const RECONCILE_STOP_TIMEOUT_SECONDS = 10

export interface ExecutionReconcileResult {
  /** Found (running or already exited) and successfully stopped, removed, and dropped from the journal. */
  stopped: ExecutionRecord[]
  /** Already gone by the time reconcile looked: the record was dropped, nothing to stop or remove. */
  absent: ExecutionRecord[]
  /** The stop could not be confirmed: the record — and the container — are left alone, and reported. */
  unconfirmed: ExecutionRecord[]
  /**
   * `inspectContainer`, `stopContainer` or `removeContainer` threw for this record (an `IO_ERROR` the
   * executor could not classify as "absent" or "unconfirmed"): the record — and the container — are
   * left alone, exactly like `unconfirmed`, so one bad record can never stop reconcile from reaching
   * the rest of the journal.
   */
  failed: ExecutionRecord[]
}

/**
 * Reconciles every record in `journal` that does not belong to `currentInstanceId` against the host
 * through `exec`. Safe to call with an empty journal (a no-op) or before the journal's directory
 * exists (`ExecutionJournal.open` already handles that).
 */
export async function reconcileExecutions(
  journal: ExecutionJournal,
  currentInstanceId: string,
  exec: DockerExec,
  log: ReconcileLogger,
  stopTimeoutSeconds = RECONCILE_STOP_TIMEOUT_SECONDS
): Promise<ExecutionReconcileResult> {
  const result: ExecutionReconcileResult = { stopped: [], absent: [], unconfirmed: [], failed: [] }
  for (const record of journal.list()) {
    if (record.instance_id === currentInstanceId) continue // this instance's own container, not an orphan

    try {
      const inspected = await inspectContainer(exec, record.container_id)
      if (!inspected.found) {
        await journal.remove(record.container_id)
        result.absent.push(record)
        continue
      }

      const outcome = await stopContainer(exec, record.container_id, stopTimeoutSeconds)
      if (!outcome.confirmed) {
        log(
          'warn',
          `execution journal: could not confirm container ${record.container_id} (engine ${record.engine_id}, ` +
            `scope ${record.scope}) stopped — leaving it and its journal record alone (${outcome.reason})`
        )
        result.unconfirmed.push(record)
        continue
      }

      await removeContainer(exec, record.container_id)
      await journal.remove(record.container_id)
      result.stopped.push(record)
      log(
        'info',
        `stopped and removed orphaned managed-runtime container ${record.container_id} ` +
          `(engine ${record.engine_id}, scope ${record.scope}) left by a previous core instance`
      )
    } catch (error) {
      // inspectContainer/stopContainer/removeContainer threw (an IO_ERROR neither "absent" nor
      // "unconfirmed" already covers): one bad record must never stop reconcile from reaching the rest.
      const detail = error instanceof Error ? error.message : String(error)
      log(
        'error',
        `execution journal: reconcile failed for container ${record.container_id} (engine ${record.engine_id}, ` +
          `scope ${record.scope}) — leaving it and its journal record alone (${detail})`
      )
      result.failed.push(record)
    }
  }
  return result
}
