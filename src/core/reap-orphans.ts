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
  for (const record of scan.confirmed) {
    log('warn', `stopping orphaned backend pid ${record.pid} (${record.model_id}) from a previous core`)
    await terminate(record)
  }
  await journal.forget([...scan.confirmed, ...scan.gone])
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
  if (isProcessAlive(record.pid)) {
    try {
      process.kill(record.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
}
