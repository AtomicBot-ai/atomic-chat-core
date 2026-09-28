/**
 * `host-step exec <request-file>` — the privileged helper (design D3). The app copies this binary
 * to a private folder and runs it under `pkexec`; a person without a polkit agent runs the same
 * command with `sudo`. It reads the request, runs the recipe, writes `<step>.result.json` beside
 * the request and exits: 0 completed, 1 failed or refused, 2 usage. It never talks to a core.
 *
 * Deliberately not in `USAGE`: nobody runs it by choice, and `atc host-step` is hidden the same way.
 */

import { parseArgs } from 'node:util'
import { AtomicCoreError } from '../../contracts/index.js'
import { executeHostStep, nodeHostStepDeps } from '../../host/recipes/index.js'
import type { HostStepExecutorDeps } from '../../host/recipes/index.js'
import type { CliIo } from '../io.js'

const HOST_STEP_USAGE = 'Usage: atomic-chat-core host-step exec <step_id.request.json> [--json]\n'

export async function hostStepCommand(
  argv: string[],
  io: CliIo,
  deps: HostStepExecutorDeps = nodeHostStepDeps(io.env)
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' } },
    allowPositionals: true,
    strict: true,
  })
  const [sub, requestPath] = positionals
  if (sub !== undefined && sub !== 'exec') {
    io.stderr(`Unknown host-step subcommand: ${sub}\n${HOST_STEP_USAGE}`)
    return 2
  }
  if (sub === undefined || requestPath === undefined || positionals.length > 2) {
    io.stderr(HOST_STEP_USAGE)
    return 2
  }
  let result
  try {
    result = await executeHostStep(requestPath, deps)
  } catch (error) {
    if (error instanceof AtomicCoreError && error.code === 'MANAGED_HOST_STEP_INVALID') {
      io.stderr(`${error.message}\n`)
      return 2
    }
    throw error
  }
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`)
  else io.stdout(`${result.step_id || '(unknown step)'}: ${result.outcome} — ${result.log_tail}\n`)
  return result.outcome === 'completed' ? 0 : 1
}
