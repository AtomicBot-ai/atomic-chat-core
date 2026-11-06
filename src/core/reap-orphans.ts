import { isProcessAlive, verifyProcessIdentity } from '../lock/index.js'
import type { ChildProcessRecord, ProcessJournal } from '../lock/index.js'
import type { CoreLogger } from './types.js'

/**
 * Terminate backend processes a previous owner left running. Only processes whose recorded start
 * identity still matches are touched; anything unprovable is left alone and logged.
 */
export async function reapOrphans(
  journal: ProcessJournal,
  instanceId: string,
  log: CoreLogger
): Promise<void> {
  const scan = await journal.scanOrphans(instanceId, new Set())
  const finished = [...scan.gone]
  for (const record of scan.confirmed) {
    log('warn', `stopping orphaned backend pid ${record.pid} (${record.model_id}) from a previous core`)
    await terminate(record)
    const remaining = await verifyProcessIdentity(record.pid, record.process_start_id)
    if (remaining === 'dead' || remaining === 'mismatch') finished.push(record)
    else log('warn', 'Keeping the process journal entry until exit can be confirmed for PID ' + record.pid)
  }
  await journal.forget(finished)
  for (const skipped of scan.skipped) {
    if (skipped.reason === 'identity-unproven')
      log('warn', `leaving pid ${skipped.record.pid} alone: cannot prove it is still our backend`)
  }
}

async function terminate(record: ChildProcessRecord): Promise<void> {
  const verdict = await verifyProcessIdentity(record.pid, record.process_start_id)
  if (verdict !== 'match') return
  try {
    process.kill(record.pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + 5000
  while (isProcessAlive(record.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  if ((await verifyProcessIdentity(record.pid, record.process_start_id)) === 'match') {
    try {
      process.kill(record.pid, 'SIGKILL')
      const killedAt = Date.now()
      while (isProcessAlive(record.pid) && Date.now() - killedAt < 1000)
        await new Promise((r) => setTimeout(r, 25))
    } catch {
      /* already gone */
    }
  }
}
