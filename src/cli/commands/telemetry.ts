/** `telemetry [status|on|off]` — the user's own say over the core's anonymous error reports. */

import { parseArgs } from 'node:util'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  FIRST_RUN_NOTICE,
  envConsent,
  readTelemetryFile,
  resolveConsent,
  takeFirstRunNotice,
  writeTelemetryFile,
} from '../../telemetry/index.js'
import type { ConsentSource } from '../../telemetry/index.js'
import { CORE_VERSION } from '../../version.js'
import type { CliIo } from '../io.js'
import { layoutFor } from './shared.js'

const WHY: Record<ConsentSource, string> = {
  env: 'set by DO_NOT_TRACK or ATOMIC_CORE_TELEMETRY',
  host: 'set by the program that runs the core',
  stored: 'your choice',
  default: 'the default; turn off with `atomic-chat-core telemetry off`',
}

export async function telemetryCommand(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { 'data-folder': { type: 'string' } },
    allowPositionals: true,
    strict: true,
  })
  const action = positionals[0] ?? 'status'
  if (action !== 'status' && action !== 'on' && action !== 'off') {
    io.stderr(`Unknown telemetry action "${action}": use status, on or off.\n`)
    return 2
  }
  const path = layoutFor(values, io).core.telemetry
  if (action !== 'status') {
    const saved = await writeTelemetryFile(path, {
      ...(await readTelemetryFile(path)),
      enabled: action === 'on',
      notice_shown: true,
    })
    if (!saved) throw new AtomicCoreError('IO_ERROR', 'Could not save the error-report setting.', path)
  }
  const stored = await readTelemetryFile(path)
  const decision = resolveConsent({ env: envConsent(io.env), stored: stored.enabled })
  io.stdout(`Error reports: ${decision.enabled ? 'on' : 'off'} (${WHY[decision.source]})\n`)
  if (action !== 'status') io.stdout('A core that is already running keeps its setting until it restarts.\n')
  return 0
}

/**
 * Print the one-time notice (stderr) when this data folder's core would report only because nobody
 * said no. Commands that start or attach a core call it first.
 */
export async function printFirstRunNotice(io: CliIo, telemetryFile: string): Promise<void> {
  if (await takeFirstRunNotice({ telemetryFile, env: io.env, version: CORE_VERSION }))
    io.stderr(FIRST_RUN_NOTICE)
}
