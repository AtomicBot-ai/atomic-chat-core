/** `shutdown` — ask the owner of a data folder to stop. */

import { parseArgs } from 'node:util'
import type { AtomicCoreError } from '../../contracts/index.js'
import { withAttachedOwner } from '../owner.js'
import type { CliIo } from '../io.js'
import { layoutFor } from './shared.js'

/** `shutdown` — stop the core that owns this folder. */
export async function shutdownCommand(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { 'data-folder': { type: 'string' }, 'force': { type: 'boolean' } },
    strict: true,
    allowPositionals: false,
  })
  const layout = layoutFor(values, io)
  let stopped = false
  try {
    await withAttachedOwner(
      { layout, clientName: 'atomic-chat-core shutdown' },
      async ({ client }, clientId) => {
        await client.shutdown({ force: values.force === true, client_id: clientId })
        stopped = true
      }
    )
  } catch (e) {
    if ((e as AtomicCoreError).code === 'CORE_NOT_RUNNING') {
      io.stdout('No core is running for this data folder.\n')
      return 0
    }
    throw e
  }
  if (stopped) io.stdout('Core is stopping.\n')
  return 0
}
