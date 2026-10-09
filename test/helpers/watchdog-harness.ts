/**
 * The process-level harness for the container watchdog's entrypoint script
 * (`src/runtime/container/watchdog.ts`): tiny Node "fake engine" fixtures instead of a real
 * `trtllm-serve`, a runner that executes the script for real under `/bin/sh` (or `dash`), and
 * pid-safe liveness helpers. The script's real-time scenarios are split across the
 * `watchdog.script-*.test.ts` files so vitest runs them on separate workers; this module is what
 * they share.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

export const posix = process.platform !== 'win32'

/** `dash`'s specific handling of a trap firing while already inside an interrupted `wait` is what
 *  the reviewer's own reproduction of findings-2.9-r2 item 2 relied on (their harness ran under
 *  `/bin/dash` explicitly); this host's default `/bin/sh` (bash-based on macOS) did not reproduce the
 *  re-entrant-postponement bug reliably even under aggressive bombardment, so the one test that needs
 *  to actually force it runs under `dash` by name, and is skipped where `dash` is not installed. */
export const dashAvailable = posix && spawnSync('dash', ['-c', 'exit 0']).status === 0

/**
 * A fresh temp directory per test of the enclosing describe (or file, when called at the top
 * level), removed after it. Returns a getter, since the directory only exists inside a test.
 */
export function useTmpDir(prefix = 'atomic-core-watchdog-'): () => string {
  let dir: string | undefined
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), prefix))
  })
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })
  return () => {
    if (dir === undefined) throw new Error('useTmpDir: the temp dir exists only inside a test')
    return dir
  }
}

/** A long-lived "engine" that records its own pid so a test can check whether it got killed. */
export const LONG_LIVED_ENGINE =
  'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)'

/** Same, but exits 42 and drops a marker file the moment it receives SIGTERM. */
export const TERM_AWARE_ENGINE =
  'const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid)); ' +
  'process.on("SIGTERM", () => { fs.writeFileSync(process.argv[2], "term"); process.exit(42) }); ' +
  'setInterval(() => {}, 1000)'

/** Ignores SIGTERM outright, so the watchdog's TERM→KILL escalation is the only thing that ends it. */
export const TERM_IGNORING_ENGINE =
  'require("fs").writeFileSync(process.argv[1], String(process.pid)); ' +
  'process.on("SIGTERM", () => {}); ' +
  'setInterval(() => {}, 1000)'

/** Writes the exact Date.now() it received SIGTERM at, then exits cleanly — for timing the watchdog's
 *  own signal-forwarding latency against real wall-clock time, not against its own process exit. */
export const TERM_TIMESTAMP_ENGINE =
  'const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid)); ' +
  'process.on("SIGTERM", () => { fs.writeFileSync(process.argv[2], String(Date.now())); process.exit(0) }); ' +
  'setInterval(() => {}, 1000)'

/** Exits on its own, with a distinctive code, after `delayMs` — used to land inside a poll that is
 *  also about to turn out stale, so a test can check whose exit status wins. */
export const selfExitingEngine = (delayMs: number, code: number): string =>
  `require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(${code}), ${delayMs})`

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

export function runWatchdog(
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  shell = '/bin/sh'
): {
  child: ReturnType<typeof spawn>
  done: Promise<RunResult>
} {
  const child = spawn(shell, [scriptPath, '--', ...args], {
    env: { PATH: process.env.PATH ?? '', ...env },
  })
  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const done = new Promise<RunResult>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal, stderr }))
  })
  return { child, done }
}

/**
 * `Number(text)` on a pid file is never used directly anywhere in these tests — only through this. A
 * pid file read mid-write (Node's `writeFileSync` truncates before it writes, so a reader can catch it
 * exactly between those two steps) reads back as `''`, and `Number('')` is `0`, not `NaN`: an
 * unguarded `Number(text.trim())` therefore silently produces a *valid-looking* pid of 0 for a file
 * that is simply not finished being written yet (findings-2.9-r3 item 1, reproduced by the reviewer).
 * Signal 0 is not "no such process" to `kill()` — POSIX defines pid 0 as "every process in the
 * caller's own process group", so `process.kill(0, 'SIGKILL')` kills the entire vitest process group,
 * not a fake engine. Every pid these tests signal goes through this parser and is checked for `> 0`
 * first.
 */
function parseValidPid(text: string): number | undefined {
  const pid = Number(text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

export async function pidAlive(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Kills the fake engine directly by its own pid, if the pid file exists and holds a valid pid yet.
 * `child.kill()` alone only kills the spawned watchdog *shell*; SIGKILL never propagates to a shell's
 * own background children (there is no chance for it to clean up after itself), so a test that
 * deliberately leaves the engine running (to assert it survives) and then SIGKILLs the watchdog for
 * cleanup orphans that engine process. Best-effort and silent otherwise: the pid file may not exist
 * yet, may not be fully written yet (see `parseValidPid`), or the process may already be dead.
 */
export async function killEngineIfKnown(pidFile: string): Promise<void> {
  const text = await readFile(pidFile, 'utf8').catch(() => undefined)
  if (text === undefined) return
  const pid = parseValidPid(text)
  if (pid === undefined) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already dead
  }
}

export async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Races `done` against a hard deadline instead of leaving the test to vitest's own test timeout,
 *  so a hang produces a clear "did not exit in time" failure instead of a generic timeout. */
export async function raceDone(done: Promise<RunResult>, timeoutMs: number): Promise<RunResult> {
  return Promise.race([
    done,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`watchdog did not exit within ${timeoutMs}ms`)), timeoutMs)
    ),
  ])
}

/**
 * Reads an engine's pid file, retrying for up to `timeoutMs` instead of throwing on the first ENOENT
 * — or on the truncate/write race `parseValidPid` guards against (findings-2.9-r3 item 1: the file
 * existing is not the same as it holding a complete pid yet, and a mid-write empty read used to parse
 * as pid 0). Item 7 (findings-2.9-r2): a plain `readFile` right after the watchdog exits assumed the
 * engine (a separate, independently-scheduled Node process) had already gotten around to writing its
 * own pid file by then — true almost always, but not guaranteed under a slow/loaded CI host, and a
 * bare ENOENT there threw out of the test instead of failing it with a clear message. Returns
 * `undefined`, rather than throwing, if a valid pid never appears — the caller decides whether that
 * itself is a failure.
 */
export async function readPidFileTolerant(path: string, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => undefined)
    if (text !== undefined) {
      const pid = parseValidPid(text)
      if (pid !== undefined) return pid
    }
    if (Date.now() > deadline) return undefined
    await new Promise((r) => setTimeout(r, 20))
  }
}
