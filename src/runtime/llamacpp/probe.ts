/**
 * Capability probe: does the installed `llama-server` advertise a speculative type in its `-h`
 * output? Port of `check_spec_type_support` in the plugin's `commands.rs` (5 s budget, substring
 * match over stdout+stderr).
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { spawnManaged } from '../process.js'
import type { ManagedProcess, SpawnSpec } from '../process.js'

export const DFLASH_SPEC_TYPE = 'draft-dflash'
export const PROBE_TIMEOUT_MS = 5000

export interface ProbeDeps {
  spawn?: (spec: SpawnSpec) => ManagedProcess
  timeoutMs?: number
}

export async function checkSpecTypeSupport(
  exePath: string,
  specType: string,
  env: Record<string, string>,
  cwd: string | undefined,
  deps: ProbeDeps = {}
): Promise<boolean> {
  const spawn = deps.spawn ?? spawnManaged
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  let proc: ManagedProcess
  try {
    proc = spawn({ exe: exePath, args: ['-h'], env, cwd })
  } catch (e) {
    throw new AtomicCoreError(
      'MODEL_LOAD_FAILED',
      'Could not probe llama.cpp backend capabilities.',
      (e as Error).message
    )
  }
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs).unref())
  const outcome = await Promise.race([proc.exited.then(() => 'exited' as const), timeout])
  if (outcome === 'timeout') {
    await proc.terminate(500)
    throw new AtomicCoreError(
      'MODEL_LOAD_TIMED_OUT',
      'Timed out while probing llama.cpp backend capabilities.',
      `llama-server -h did not finish within ${Math.round(timeoutMs / 1000)}s for ${exePath}`
    )
  }
  const failure = proc.spawnFailure()
  if (failure) {
    throw new AtomicCoreError(
      'MODEL_LOAD_FAILED',
      'Could not probe llama.cpp backend capabilities.',
      failure.message
    )
  }
  // let the line readers drain
  await new Promise((r) => setTimeout(r, 10))
  const { stdout, stderr } = proc.output()
  return `${stdout}\n${stderr}`.includes(specType)
}
