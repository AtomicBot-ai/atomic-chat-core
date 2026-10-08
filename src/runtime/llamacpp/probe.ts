/**
 * Capability probe: does the installed `llama-server` advertise a speculative type in its `-h`
 * output? Port of `check_spec_type_support` in the plugin's `commands.rs` (5 s budget, substring
 * match over stdout+stderr). `runHelp` is the run itself, for a caller that judges the output and
 * the exit on its own (the decision engine gate, which takes only a finished help screen as proof).
 */

import { AtomicCoreError } from '../../contracts/index.js'
import { spawnManaged } from '../shared/index.js'
import type { ManagedProcess, SpawnSpec } from '../shared/index.js'
import type { ExitInfo } from './errors.js'

export const DFLASH_SPEC_TYPE = 'draft-dflash'
export const PROBE_TIMEOUT_MS = 5000
/** How much of a probe's output a failure's details keep: the end, where an error is. */
export const PROBE_OUTPUT_TAIL_CHARS = 600

export interface ProbeDeps {
  spawn?: (spec: SpawnSpec) => ManagedProcess
  timeoutMs?: number
  now?: () => number
}

/** What `llama-server -h` printed, how it exited and how long it took. */
export interface HelpRun {
  /** stdout, then stderr. */
  output: string
  exit: ExitInfo
  elapsedMs: number
}

/** The last `chars` characters of `text` on one line, for a failure's details; `''` for no output. */
export function probeOutputTail(text: string, chars = PROBE_OUTPUT_TAIL_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > chars ? `…${flat.slice(-chars)}` : flat
}

/**
 * Run `exePath -h` and collect its output. Rejects with `MODEL_LOAD_FAILED` when the process could
 * not be started and with `MODEL_LOAD_TIMED_OUT` when it did not finish within the budget: neither
 * says anything about what the build supports.
 */
export async function runHelp(
  exePath: string,
  env: Record<string, string>,
  cwd: string | undefined,
  deps: ProbeDeps = {}
): Promise<HelpRun> {
  const spawn = deps.spawn ?? spawnManaged
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS
  const now = deps.now ?? Date.now
  const started = now()
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
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((r) => {
    timer = setTimeout(() => r('timeout'), timeoutMs)
    timer.unref()
  })
  const outcome = await Promise.race([proc.exited, timeout])
  clearTimeout(timer)
  if (outcome === 'timeout') {
    const { stdout, stderr } = proc.output()
    const tail = probeOutputTail(`${stdout}\n${stderr}`)
    await proc.terminate(500)
    throw new AtomicCoreError(
      'MODEL_LOAD_TIMED_OUT',
      'Timed out while probing llama.cpp backend capabilities.',
      `llama-server -h did not finish within ${Math.round(timeoutMs / 1000)}s for ${exePath}` +
        (tail ? `; output so far: ${tail}` : '; no output')
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
  return { output: `${stdout}\n${stderr}`, exit: outcome, elapsedMs: now() - started }
}

export async function checkSpecTypeSupport(
  exePath: string,
  specType: string,
  env: Record<string, string>,
  cwd: string | undefined,
  deps: ProbeDeps = {}
): Promise<boolean> {
  return (await runHelp(exePath, env, cwd, deps)).output.includes(specType)
}
