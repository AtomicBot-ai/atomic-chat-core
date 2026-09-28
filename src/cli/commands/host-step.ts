/**
 * `host-step exec <request-file>` — the privileged helper (design D3). The app copies this binary
 * to a private folder and runs it under `pkexec`; a person without a polkit agent runs the same
 * command with `sudo`. It reads the request, runs the recipe, writes `<step>.result.json` beside
 * the request and exits. It never talks to a core.
 *
 * Exit codes:
 * - 0 — the recipe completed; the result file says `completed`.
 * - 1 — a result file was written and says `failed` (a refused request or a failed step).
 * - 2 — no result file was written: a usage error, a path not named `<step_id>.request.json`, a
 *   folder the executor does not trust (not a real directory, writable by others, or not owned by
 *   the invoking user — or, run as root with neither `PKEXEC_UID` nor `SUDO_UID`, not owned by
 *   root), or a result write that failed for any other reason (full disk, read-only file system,
 *   the folder gone). The reason is printed on stderr; the client must treat a missing result file
 *   as failed.
 *
 * Deliberately not in `USAGE`: nobody runs it by choice, and `atc host-step` is hidden the same way.
 */

import { parseArgs } from 'node:util'
import { AtomicCoreError } from '../../contracts/index.js'
import { executeHostStep, nodeHostStepDeps } from '../../host/recipes/index.js'
import type { HostStepExecutorDeps } from '../../host/recipes/index.js'
import type { CliIo } from '../io.js'

const HOST_STEP_USAGE =
  'Usage: atomic-chat-core host-step exec <step_id.request.json> [--json]\n' +
  'Exit: 0 completed, 1 failed (see the result file), 2 no result file was written (see stderr).\n'

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
    // `executeHostStep` throws only when it could not write a result file: a refused path or folder
    // (`MANAGED_HOST_STEP_INVALID`) or a failed write (ENOSPC, EROFS, ENOENT, ...). Either way the
    // caller finds no result, and exit 2 is what tells it so.
    const why = error instanceof AtomicCoreError ? error.message : (error as Error).message
    io.stderr(`host-step: no result file was written: ${why}\n`)
    return 2
  }
  if (values.json) io.stdout(`${JSON.stringify(result, null, 2)}\n`)
  else io.stdout(`${result.step_id || '(unknown step)'}: ${result.outcome} — ${result.log_tail}\n`)
  return result.outcome === 'completed' ? 0 : 1
}
