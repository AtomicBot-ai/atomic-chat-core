/**
 * Three layers: a unit test of `writeWatchdogScript` against a fake filesystem, a unit test of
 * `watchdogEnv`, and — POSIX-only, since it spawns `/bin/sh` for real — a process-level test of the
 * script text itself, against tiny Node "fake server" fixtures instead of a real `trtllm-serve` (the
 * container/Docker wiring that would run it for real is task 2.8/2.12's job, not this one's).
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  DEFAULT_WATCHDOG_KILL_GRACE_SECS,
  DEFAULT_WATCHDOG_POLL_INTERVAL_SECS,
  DEFAULT_WATCHDOG_STALE_LIMIT_SECS,
  WATCHDOG_ENV_VARS,
  WATCHDOG_EXIT_CODE_CONFIG_ERROR,
  WATCHDOG_EXIT_CODE_STALE_HEARTBEAT,
  WATCHDOG_SCRIPT,
  WATCHDOG_SCRIPT_MODE,
  watchdogEnv,
  writeWatchdogScript,
} from './watchdog.js'
import type { WatchdogScriptFs } from './watchdog.js'
import { skipOnWindows } from '../../../test/helpers/platform.js'

// ── watchdogEnv ──────────────────────────────────────────────────────────────────────────────────

describe('watchdogEnv', () => {
  it('fills in the timing constants for anything not overridden', () => {
    expect(watchdogEnv({ heartbeatFile: '/data/heartbeat' })).toEqual({
      [WATCHDOG_ENV_VARS.heartbeatFile]: '/data/heartbeat',
      [WATCHDOG_ENV_VARS.staleLimitSecs]: String(DEFAULT_WATCHDOG_STALE_LIMIT_SECS),
      [WATCHDOG_ENV_VARS.pollIntervalSecs]: String(DEFAULT_WATCHDOG_POLL_INTERVAL_SECS),
      [WATCHDOG_ENV_VARS.killGraceSecs]: String(DEFAULT_WATCHDOG_KILL_GRACE_SECS),
    })
  })

  it('uses each override in place of its default, independently', () => {
    expect(
      watchdogEnv({
        heartbeatFile: '/data/heartbeat',
        staleLimitSecs: 2,
        pollIntervalSecs: 1,
        killGraceSecs: 1,
      })
    ).toEqual({
      [WATCHDOG_ENV_VARS.heartbeatFile]: '/data/heartbeat',
      [WATCHDOG_ENV_VARS.staleLimitSecs]: '2',
      [WATCHDOG_ENV_VARS.pollIntervalSecs]: '1',
      [WATCHDOG_ENV_VARS.killGraceSecs]: '1',
    })
  })
})

// ── writeWatchdogScript (fs injected) ────────────────────────────────────────────────────────────

interface FakeEntry {
  content: string
  mode: number
  /** A symlink's `readFile`/mode would read through to whatever it points at in a real filesystem;
   *  the fake instead just flags it, since what matters for these tests is that `isFile()` is false. */
  isSymlink?: boolean
}

function fakeFs(initial: Record<string, FakeEntry> = {}): WatchdogScriptFs & {
  mkdirCalls: Array<{ path: string; options: { recursive: boolean } }>
  entries: Record<string, FakeEntry>
  chmodCalls: Array<{ path: string; mode: number }>
  renameCalls: Array<{ from: string; to: string }>
  writeFileCalls: Array<{ path: string; options?: { flag?: string; mode?: number } }>
  rmCalls: string[]
} {
  const mkdirCalls: Array<{ path: string; options: { recursive: boolean } }> = []
  const entries: Record<string, FakeEntry> = { ...initial }
  const chmodCalls: Array<{ path: string; mode: number }> = []
  const renameCalls: Array<{ from: string; to: string }> = []
  const writeFileCalls: Array<{ path: string; options?: { flag?: string; mode?: number } }> = []
  const rmCalls: string[] = []
  return {
    mkdirCalls,
    entries,
    chmodCalls,
    renameCalls,
    writeFileCalls,
    rmCalls,
    async mkdir(path, options) {
      mkdirCalls.push({ path, options })
      return undefined
    },
    async writeFile(path, data, options) {
      writeFileCalls.push(options === undefined ? { path } : { path, options })
      entries[path] = { content: data, mode: options?.mode ?? 0o666 }
    },
    async chmod(path, mode) {
      chmodCalls.push({ path, mode })
      const entry = entries[path]
      if (entry !== undefined) entry.mode = mode
    },
    async rename(from, to) {
      renameCalls.push({ from, to })
      const entry = entries[from]
      delete entries[from]
      if (entry !== undefined) entries[to] = entry
    },
    async rm(path) {
      rmCalls.push(path)
      delete entries[path]
    },
    async lstat(path) {
      const entry = entries[path]
      if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return { isFile: () => !entry.isSymlink, mode: entry.mode }
    },
    async readFile(path) {
      const entry = entries[path]
      if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return entry.content
    },
  }
}

describe('writeWatchdogScript', () => {
  skipOnWindows('POSIX modes and symlinks: on Windows the script is written into the WSL guest')
  it('writes the script to a temp file in the same directory, chmods it, then renames it over the target', async () => {
    const fs = fakeFs()
    const path = '/data/atomic-core/managed-runtimes/watchdog/atomic-watchdog-entrypoint.sh'

    const result = await writeWatchdogScript(path, fs)

    expect(result).toBe(path)
    expect(fs.mkdirCalls).toEqual([
      { path: '/data/atomic-core/managed-runtimes/watchdog', options: { recursive: true } },
    ])
    expect(fs.writeFileCalls).toHaveLength(1)
    const tempPath = fs.writeFileCalls[0]?.path as string
    expect(tempPath).not.toBe(path)
    expect(tempPath.startsWith('/data/atomic-core/managed-runtimes/watchdog/')).toBe(true)
    expect(fs.writeFileCalls[0]?.options).toEqual({ flag: 'wx' })
    expect(fs.chmodCalls).toEqual([{ path: tempPath, mode: WATCHDOG_SCRIPT_MODE }])
    expect(fs.renameCalls).toEqual([{ from: tempPath, to: path }])
    expect(fs.entries[path]?.content).toBe(WATCHDOG_SCRIPT)
  })

  it('is a no-op when the target already holds the current script verbatim at mode 0555', async () => {
    const path = '/data/x/entrypoint.sh'
    const fs = fakeFs({ [path]: { content: WATCHDOG_SCRIPT, mode: WATCHDOG_SCRIPT_MODE } })

    const result = await writeWatchdogScript(path, fs)

    expect(result).toBe(path)
    expect(fs.mkdirCalls).toEqual([])
    expect(fs.writeFileCalls).toEqual([])
    expect(fs.chmodCalls).toEqual([])
    expect(fs.renameCalls).toEqual([])
  })

  it('replaces a target holding stale content, rather than skipping it', async () => {
    const path = '/data/x/entrypoint.sh'
    const fs = fakeFs({ [path]: { content: '#!/bin/sh\necho old\n', mode: WATCHDOG_SCRIPT_MODE } })

    await writeWatchdogScript(path, fs)

    expect(fs.entries[path]?.content).toBe(WATCHDOG_SCRIPT)
    expect(fs.renameCalls).toHaveLength(1)
  })

  // Item 6 (findings-2.9-r2): the round-1 no-op check compared content only, so a regular file with
  // the right content but the wrong mode was left exactly as wrong as it started.
  it('re-secures a target with the current content but the wrong mode, rather than treating it as current', async () => {
    const path = '/data/x/entrypoint.sh'
    const fs = fakeFs({ [path]: { content: WATCHDOG_SCRIPT, mode: 0o644 } })

    await writeWatchdogScript(path, fs)

    expect(fs.renameCalls).toHaveLength(1)
    expect(fs.entries[path]?.mode).toBe(WATCHDOG_SCRIPT_MODE)
  })

  // Item 6 (findings-2.9-r2): `readFile` follows a symlink to its target's content, so a symlink
  // pointing at a file with identical content used to read as "already current" and get left in
  // place — leaving a symlink (to who knows what, or to nothing, next time) mounted read-only into a
  // container instead of the independent regular file the executor asked for.
  it('replaces a symlink pointing at identical content, rather than treating it as current', async () => {
    const path = '/data/x/entrypoint.sh'
    const fs = fakeFs({ [path]: { content: WATCHDOG_SCRIPT, mode: WATCHDOG_SCRIPT_MODE, isSymlink: true } })

    await writeWatchdogScript(path, fs)

    expect(fs.renameCalls).toHaveLength(1)
    expect(fs.entries[path]?.content).toBe(WATCHDOG_SCRIPT)
  })

  it('wraps a filesystem failure as an IO_ERROR AtomicCoreError instead of leaking the raw error', async () => {
    const fs = fakeFs()
    fs.writeFile = async () => {
      throw new Error('EACCES: permission denied')
    }

    const error = await writeWatchdogScript('/data/x/entrypoint.sh', fs).then(
      () => undefined,
      (e: unknown) => e
    )

    expect(error).toBeInstanceOf(AtomicCoreError)
    expect((error as AtomicCoreError).code).toBe('IO_ERROR')
    expect((error as AtomicCoreError).details).toContain('permission denied')
  })

  // Item 6 (findings-2.9-r2): a failed chmod/rename used to leave the temp file behind for good.
  it('cleans up the temp file when chmod fails partway through', async () => {
    const fs = fakeFs()
    fs.chmod = async () => {
      throw new Error('EPERM: operation not permitted')
    }

    await expect(writeWatchdogScript('/data/x/entrypoint.sh', fs)).rejects.toBeInstanceOf(AtomicCoreError)

    expect(fs.rmCalls).toHaveLength(1)
    expect(fs.entries[fs.rmCalls[0] as string]).toBeUndefined()
  })

  it('cleans up the temp file when rename fails partway through', async () => {
    const fs = fakeFs()
    fs.rename = async () => {
      throw new Error('ENOSPC: no space left on device')
    }

    await expect(writeWatchdogScript('/data/x/entrypoint.sh', fs)).rejects.toBeInstanceOf(AtomicCoreError)

    expect(fs.rmCalls).toHaveLength(1)
  })

  // Item 1 (findings-2.9-r1): the script is 0555, so a second call that used to write straight at
  // the same path used to fail EACCES; on a real filesystem this is the actual failure mode.
  it('can be called twice in a row on the same real path without EACCES', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-core-watchdog-write-'))
    try {
      const path = join(dir, 'atomic-watchdog-entrypoint.sh')

      await writeWatchdogScript(path)
      await expect(writeWatchdogScript(path)).resolves.toBe(path)

      expect(await readFile(path, 'utf8')).toBe(WATCHDOG_SCRIPT)
      expect((await stat(path)).mode & 0o777).toBe(WATCHDOG_SCRIPT_MODE)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Item 6 (findings-2.9-r2), on a real filesystem: a symlink to a file with identical content must
  // be replaced with a real regular file, not left as a symlink.
  it('replaces a real symlink pointing at identical content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-core-watchdog-symlink-'))
    try {
      const target = join(dir, 'real.sh')
      await fsWriteFile(target, WATCHDOG_SCRIPT)
      // Item 5 (findings-2.9-r3): also give the target itself mode 0555 — content alone left the
      // mode check able to "accidentally" pass this test even if the code regressed to `stat` (which
      // follows the symlink) instead of `lstat`, since the target's default mode wouldn't match
      // WATCHDOG_SCRIPT_MODE either way. Matching the target's mode too means only the `lstat`
      // (symlink-vs-regular-file) check itself can be what makes this test replace the link.
      await chmod(target, WATCHDOG_SCRIPT_MODE)
      const link = join(dir, 'link.sh')
      await symlink(target, link)

      await writeWatchdogScript(link)

      expect((await lstat(link)).isSymbolicLink()).toBe(false)
      expect(await readFile(link, 'utf8')).toBe(WATCHDOG_SCRIPT)
      expect((await stat(link)).mode & 0o777).toBe(WATCHDOG_SCRIPT_MODE)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ── The script itself, run for real under /bin/sh ───────────────────────────────────────────────

const posix = process.platform !== 'win32'
/** `dash`'s specific handling of a trap firing while already inside an interrupted `wait` is what
 *  the reviewer's own reproduction of findings-2.9-r2 item 2 relied on (their harness ran under
 *  `/bin/dash` explicitly); this host's default `/bin/sh` (bash-based on macOS) did not reproduce the
 *  re-entrant-postponement bug reliably even under aggressive bombardment, so the one test that needs
 *  to actually force it runs under `dash` by name, and is skipped where `dash` is not installed. */
const dashAvailable = posix && spawnSync('dash', ['-c', 'exit 0']).status === 0

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-watchdog-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A long-lived "engine" that records its own pid so a test can check whether it got killed. */
const LONG_LIVED_ENGINE =
  'require("fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)'

/** Same, but exits 42 and drops a marker file the moment it receives SIGTERM. */
const TERM_AWARE_ENGINE =
  'const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid)); ' +
  'process.on("SIGTERM", () => { fs.writeFileSync(process.argv[2], "term"); process.exit(42) }); ' +
  'setInterval(() => {}, 1000)'

/** Ignores SIGTERM outright, so the watchdog's TERM→KILL escalation is the only thing that ends it. */
const TERM_IGNORING_ENGINE =
  'require("fs").writeFileSync(process.argv[1], String(process.pid)); ' +
  'process.on("SIGTERM", () => {}); ' +
  'setInterval(() => {}, 1000)'

/** Writes the exact Date.now() it received SIGTERM at, then exits cleanly — for timing the watchdog's
 *  own signal-forwarding latency against real wall-clock time, not against its own process exit. */
const TERM_TIMESTAMP_ENGINE =
  'const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid)); ' +
  'process.on("SIGTERM", () => { fs.writeFileSync(process.argv[2], String(Date.now())); process.exit(0) }); ' +
  'setInterval(() => {}, 1000)'

/** Exits on its own, with a distinctive code, after `delayMs` — used to land inside a poll that is
 *  also about to turn out stale, so a test can check whose exit status wins. */
const selfExitingEngine = (delayMs: number, code: number): string =>
  `require("fs").writeFileSync(process.argv[1], String(process.pid)); setTimeout(() => process.exit(${code}), ${delayMs})`

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

function runWatchdog(
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
 * `Number(text)` on a pid file is never used directly anywhere below — only through this. A pid file
 * read mid-write (Node's `writeFileSync` truncates before it writes, so a reader can catch it exactly
 * between those two steps) reads back as `''`, and `Number('')` is `0`, not `NaN`: an unguarded
 * `Number(text.trim())` therefore silently produces a *valid-looking* pid of 0 for a file that is
 * simply not finished being written yet (findings-2.9-r3 item 1, reproduced by the reviewer). Signal
 * 0 is not "no such process" to `kill()` — POSIX defines pid 0 as "every process in the caller's own
 * process group", so `process.kill(0, 'SIGKILL')` kills the entire vitest process group, not a fake
 * engine. Every pid this file signals goes through this parser and is checked for `> 0` first.
 */
function parseValidPid(text: string): number | undefined {
  const pid = Number(text.trim())
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

async function pidAlive(pid: number): Promise<boolean> {
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
async function killEngineIfKnown(pidFile: string): Promise<void> {
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** Races `done` against a hard deadline instead of leaving the test to vitest's own test timeout,
 *  so a hang produces a clear "did not exit in time" failure instead of a generic timeout. */
async function raceDone(done: Promise<RunResult>, timeoutMs: number): Promise<RunResult> {
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
async function readPidFileTolerant(path: string, timeoutMs: number): Promise<number | undefined> {
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

// Item 1 (findings-2.9-r3, Important): deterministic, not a real writeFileSync-race reproduction —
// forcing the actual truncate→write window is inherently racy, and if the guard genuinely regressed,
// forcing it for real would call `process.kill(0, 'SIGKILL')` against this very test process's own
// process group (exactly the bug being tested for). These pin the parsing/guarding logic directly
// against a pid file holding the exact bogus content that race window produces, with no race needed:
// `Number('')` and `Number('0')` are both `0`, and POSIX defines `kill(0, sig)` as "every process in
// the caller's own process group", not "no such process".
describe('pid-file safety (findings-2.9-r3 item 1)', () => {
  // Reuses the shared `dir` fixture (module-level `beforeEach`/`afterEach` below, in scope by the
  // time this describe block runs) rather than declaring its own — same temp-dir-per-test pattern,
  // no need for a second one.
  it('never calls process.kill with pid 0 or a negative pid, however the pid file reads', async () => {
    const pidFile = join(dir, 'engine.pid')
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
    try {
      for (const bogus of ['', '0', '-1', '   ', 'not-a-pid', '0\n', '-0']) {
        await fsWriteFile(pidFile, bogus)
        await killEngineIfKnown(pidFile)
      }
      expect(await pidAlive(0)).toBe(false)
      expect(await pidAlive(-5)).toBe(false)
      expect(killSpy).not.toHaveBeenCalled()
    } finally {
      killSpy.mockRestore()
    }
  })

  it('readPidFileTolerant retries past an empty pid file instead of returning 0', async () => {
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(pidFile, '')
    setTimeout(() => {
      fsWriteFile(pidFile, '4242').catch(() => {})
    }, 150)

    const pid = await readPidFileTolerant(pidFile, 2_000)

    expect(pid).toBe(4242)
  })

  it('readPidFileTolerant returns undefined, not 0, if only an invalid pid ever appears', async () => {
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(pidFile, '0')

    const pid = await readPidFileTolerant(pidFile, 300)

    expect(pid).toBeUndefined()
  })
})

describe.skipIf(!posix)('the watchdog entrypoint script', () => {
  it('lets the engine keep running while the heartbeat stays fresh', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    // poll=2s (not 1s): `stat`'s mtime has only whole-second resolution, so a 1s poll interval can
    // occasionally alias two consecutive polls onto the same integer second under scheduling jitter
    // (e.g. the full test suite's own CPU contention) even though the file is genuinely being
    // rewritten every 300ms — a false "unchanged" reading with nothing wrong. A 2s gap between polls
    // leaves enough margin that this essentially cannot happen, and threshold=4 ((6+2)/2) means it
    // would have to happen four times in a row to produce a false positive.
    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 6, pollIntervalSecs: 2, killGraceSecs: 1 })
    )

    // A ticker keeping the heartbeat fresh for two whole stale windows (4 polls * 2s = 8s, final review
    // M-10: an 8 s watch was barely one window, so a late kill could still pass unnoticed).
    const tick = setInterval(() => {
      fsWriteFile(heartbeatPath, '').catch(() => {})
    }, 300)
    try {
      await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
      await new Promise((r) => setTimeout(r, 12_000))
      expect(child.exitCode).toBeNull()
      const pid = await readPidFileTolerant(pidFile, 2_000)
      expect(pid).toBeDefined()
      if (pid !== undefined) expect(await pidAlive(pid)).toBe(true)
    } finally {
      clearInterval(tick)
      child.kill('SIGKILL')
      await done.catch(() => undefined)
      await killEngineIfKnown(pidFile)
    }
  }, 20_000)

  it('kills the engine and exits with the stale-heartbeat code once the heartbeat stops changing', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    // limit=2, poll=1 => threshold = (2+1)/1 = 3 polls, so staleness fires ~3s after start.
    const { done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 2, pollIntervalSecs: 1, killGraceSecs: 1 })
    )
    // Heartbeat is never touched again after the script's own initial creation: it goes stale.

    // threshold*poll(3s) + grace(1-2s, irrelevant here since nothing needs killing) + generous slack.
    const result = await raceDone(done, 8_000)

    expect(result.code).toBe(WATCHDOG_EXIT_CODE_STALE_HEARTBEAT)
    // Item 7 (findings-2.9-r2): tolerant, not a bare readFile — the engine writes its own pid file
    // independently of the watchdog exiting, and a slow CI host could still be catching up.
    const pid = await readPidFileTolerant(pidFile, 3_000)
    expect(pid).toBeDefined()
    if (pid !== undefined) await waitFor(async () => !(await pidAlive(pid)), 2_000)
  }, 12_000)

  it('escalates to KILL when the engine ignores TERM after the heartbeat goes stale', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    const { done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', TERM_IGNORING_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 2, pollIntervalSecs: 1, killGraceSecs: 1 })
    )

    // threshold*poll(3s) + grace(1-2s) before KILL + generous slack.
    const result = await raceDone(done, 10_000)

    expect(result.code).toBe(WATCHDOG_EXIT_CODE_STALE_HEARTBEAT)
    const pid = await readPidFileTolerant(pidFile, 3_000)
    expect(pid).toBeDefined()
    if (pid !== undefined) await waitFor(async () => !(await pidAlive(pid)), 2_000)
  }, 14_000)

  it('propagates the engine exit status when the engine exits on its own', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    await fsWriteFile(heartbeatPath, '')

    const { done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', 'process.exit(5)'],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 30, pollIntervalSecs: 1, killGraceSecs: 5 })
    )

    const result = await raceDone(done, 5_000)
    expect(result.code).toBe(5)
  }, 8_000)

  it('forwards TERM to the engine and exits once the engine has reacted to it', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    const markerFile = join(dir, 'term-marker')
    await fsWriteFile(heartbeatPath, '')

    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', TERM_AWARE_ENGINE, pidFile, markerFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 30, pollIntervalSecs: 1, killGraceSecs: 5 })
    )

    await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
    child.kill('SIGTERM')

    const result = await raceDone(done, 5_000)

    expect(result.code).toBe(42)
    expect(await readFile(markerFile, 'utf8')).toBe('term')
  }, 8_000)

  it('escalates a TERM-ignoring engine to KILL after the grace period, on docker-stop-style TERM', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', TERM_IGNORING_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 30, pollIntervalSecs: 1, killGraceSecs: 1 })
    )

    const pid = await readPidFileTolerant(pidFile, 2_000)
    expect(pid).toBeDefined()
    child.kill('SIGTERM')

    const result = await raceDone(done, 6_000)
    expect(result.signal).toBeNull()
    expect(result.code).not.toBe(0)
    if (pid !== undefined) await waitFor(async () => !(await pidAlive(pid)), 2_000)
  }, 10_000)

  // Final review M-10: `date +%s` floors, so a deadline of `now + KILL_GRACE_SECS` taken late in a
  // second let the KILL land up to a second early — anywhere in (G-1, G]. TERM is sent just before a
  // second boundary here, the worst case: the engine must still get its whole grace.
  it('gives a TERM-ignoring engine its whole grace before KILL, even when TERM lands just before a second boundary', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    const termFile = join(dir, 'term-at')
    await fsWriteFile(heartbeatPath, '')
    const killGraceSecs = 1
    const engine =
      'const fs = require("fs"); fs.writeFileSync(process.argv[1], String(process.pid)); ' +
      'process.on("SIGTERM", () => fs.writeFileSync(process.argv[2], String(Date.now()))); ' +
      'setInterval(() => {}, 1000)'
    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', engine, pidFile, termFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 30, pollIntervalSecs: 1, killGraceSecs })
    )
    try {
      const pid = await readPidFileTolerant(pidFile, 3_000)
      expect(pid).toBeDefined()
      // Into the last tenth of a second, then TERM.
      while (Date.now() % 1000 < 880) await new Promise((r) => setTimeout(r, 5))
      child.kill('SIGTERM')
      if (pid !== undefined) await waitFor(async () => !(await pidAlive(pid)), 5_000)
      const diedAt = Date.now()
      const termAt = Number((await readFile(termFile, 'utf8')).trim())
      expect(Number.isFinite(termAt)).toBe(true)
      // Measured to the poll that saw it gone (20 ms), so only scheduling slack is allowed below G.
      expect(diedAt - termAt).toBeGreaterThanOrEqual(killGraceSecs * 1000 - 50)
      await raceDone(done, 3_000)
    } finally {
      child.kill('SIGKILL')
      await killEngineIfKnown(pidFile)
    }
  }, 12_000)

  // Item 3 (findings-2.9-r1): a malformed timing value must fail closed (exit 96, engine never
  // started), not silently disable the watchdog.
  interface MalformedOverride {
    staleLimitSecsRaw?: string
    pollIntervalSecsRaw?: string
    killGraceSecsRaw?: string
  }

  it.each<[string, MalformedOverride]>([
    ['STALE_LIMIT_SECS is not an integer', { staleLimitSecsRaw: '2.5' }],
    ['STALE_LIMIT_SECS is zero', { staleLimitSecsRaw: '0' }],
    ['STALE_LIMIT_SECS is negative', { staleLimitSecsRaw: '-1' }],
    // Item 4 (findings-2.9-r2): a leading zero must be rejected, not tolerated as decimal — "08"/"09"
    // are not valid octal digits and abort the script's own arithmetic outright, and "010" silently
    // means octal 8 (decimal 8), not ten, to `$((...))`.
    ['STALE_LIMIT_SECS has a leading zero and is not valid octal ("08")', { staleLimitSecsRaw: '08' }],
    [
      'STALE_LIMIT_SECS has a leading zero and would silently change value in octal ("010")',
      { staleLimitSecsRaw: '010' },
    ],
    ['POLL_INTERVAL_SECS is not an integer', { pollIntervalSecsRaw: 'x' }],
    ['POLL_INTERVAL_SECS is zero', { pollIntervalSecsRaw: '0' }],
    ['POLL_INTERVAL_SECS has a leading zero ("01")', { pollIntervalSecsRaw: '01' }],
    ['KILL_GRACE_SECS is not an integer', { killGraceSecsRaw: 'x' }],
    ['KILL_GRACE_SECS is zero', { killGraceSecsRaw: '0' }],
    ['KILL_GRACE_SECS has a leading zero ("00")', { killGraceSecsRaw: '00' }],
  ])(
    'refuses to start the engine when %s',
    async (_label, override) => {
      const scriptPath = join(dir, 'entrypoint.sh')
      await writeWatchdogScript(scriptPath)
      const heartbeatPath = join(dir, 'heartbeat')
      const pidFile = join(dir, 'engine.pid')
      await fsWriteFile(heartbeatPath, '')

      const base = watchdogEnv({
        heartbeatFile: heartbeatPath,
        staleLimitSecs: 30,
        pollIntervalSecs: 1,
        killGraceSecs: 5,
      })
      const env = {
        ...base,
        ...(override.staleLimitSecsRaw !== undefined
          ? { [WATCHDOG_ENV_VARS.staleLimitSecs]: override.staleLimitSecsRaw }
          : {}),
        ...(override.pollIntervalSecsRaw !== undefined
          ? { [WATCHDOG_ENV_VARS.pollIntervalSecs]: override.pollIntervalSecsRaw }
          : {}),
        ...(override.killGraceSecsRaw !== undefined
          ? { [WATCHDOG_ENV_VARS.killGraceSecs]: override.killGraceSecsRaw }
          : {}),
      }

      const { done } = runWatchdog(scriptPath, [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile], env)

      const result = await raceDone(done, 3_000)
      expect(result.code).toBe(WATCHDOG_EXIT_CODE_CONFIG_ERROR)
      expect(await stat(pidFile).catch(() => undefined)).toBeUndefined()
    },
    5_000
  )

  // Item 2 (findings-2.9-r1, case A): `: > "$HEARTBEAT_FILE"` is a *special builtin* redirection, so
  // an unguarded failure (an unwritable / nonexistent heartbeat directory) can abort a non-interactive
  // POSIX shell outright, before the engine ever starts. The tolerant `( : > "$F" ) 2>/dev/null ||
  // true` must keep the script going regardless.
  it('starts the engine even when the heartbeat file cannot be created at all', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    // Parent directory does not exist: the tolerant create is guaranteed to fail.
    const heartbeatPath = join(dir, 'no-such-directory', 'heartbeat')
    const pidFile = join(dir, 'engine.pid')

    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 30, pollIntervalSecs: 1, killGraceSecs: 1 })
    )

    try {
      await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
      await done.catch(() => undefined)
      await killEngineIfKnown(pidFile)
    }
  }, 6_000)

  // Item 2 (findings-2.9-r1, controller ruling): the clock-independent staleness rule must also
  // survive a heartbeat file that already existed with an old mtime before the script ever started —
  // the old wall-clock check killed the engine on the very first poll in this situation.
  it('gives a leftover, already-old heartbeat file a full stale window before acting on it', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    // A heartbeat file that already exists, with whatever mtime `writeFile` gives it "now" — old
    // relative to nothing, since there is no clock comparison any more, but this is exactly the
    // shape of the leftover-file bug: present, untouched, never freshened by a ticker in this test.
    await fsWriteFile(heartbeatPath, '')

    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 3, pollIntervalSecs: 1, killGraceSecs: 1 })
    )

    try {
      await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
      // Immediately after start the engine must still be alive: the leftover file's age alone must
      // not trip anything before the poll-count threshold has actually been reached.
      await new Promise((r) => setTimeout(r, 500))
      expect(child.exitCode).toBeNull()
    } finally {
      child.kill('SIGKILL')
      await done.catch(() => undefined)
      await killEngineIfKnown(pidFile)
    }
  }, 8_000)

  // Item 1 "B test" (findings-2.9-r2): a heartbeat file that already exists at script start is left
  // alone by the tolerant create, not truncated — the pre-round-2 script always truncated it
  // unconditionally (`: > "$HEARTBEAT_FILE"` with no existence check), which this would have failed:
  // the readback below would have come back empty.
  it('leaves a pre-existing heartbeat file untouched instead of truncating it at startup', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, 'leftover-content-from-a-previous-run')

    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 30, pollIntervalSecs: 1, killGraceSecs: 1 })
    )

    try {
      await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
      expect(await readFile(heartbeatPath, 'utf8')).toBe('leftover-content-from-a-previous-run')
    } finally {
      child.kill('SIGKILL')
      await done.catch(() => undefined)
      await killEngineIfKnown(pidFile)
    }
  }, 6_000)

  // Item 1 (findings-2.9-r2, Important, controller-described off-by-one): the round-1 script counted
  // the poll that *establishes* the baseline observation as "1 unchanged poll" already, instead of 0.
  // With STALE_LIMIT_SECS < POLL_INTERVAL_SECS (THRESHOLD == 1), that alone satisfied the threshold
  // on literally the first poll, killing the engine immediately regardless of freshness. This test
  // fails against the round-1 script (exits 97 almost immediately instead of surviving).
  it('never kills a continuously-fresh heartbeat when STALE_LIMIT_SECS <= POLL_INTERVAL_SECS', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    // L < P (THRESHOLD = (1+2)/2 = 1): the only case where one observation alone reaches the
    // threshold, which is what the round-1 off-by-one needed (final review M-10: with L == P the
    // threshold is 2 now, so that test no longer exercised it).
    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 1, pollIntervalSecs: 2, killGraceSecs: 1 })
    )

    const tick = setInterval(() => {
      fsWriteFile(heartbeatPath, '').catch(() => {})
    }, 300)
    try {
      await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
      await new Promise((r) => setTimeout(r, 6_000))
      expect(child.exitCode).toBeNull()
      const pid = await readPidFileTolerant(pidFile, 2_000)
      expect(pid).toBeDefined()
      if (pid !== undefined) expect(await pidAlive(pid)).toBe(true)
    } finally {
      clearInterval(tick)
      child.kill('SIGKILL')
      await done.catch(() => undefined)
      await killEngineIfKnown(pidFile)
    }
  }, 12_000)

  // Item 1 (findings-2.9-r2, Important): the same off-by-one made the steady-state kill (heartbeat
  // actively written, then stopped) land one poll interval *before* it was allowed to — the round-1
  // script needed only THRESHOLD-1 more matching polls once it observed the frozen value, instead of
  // THRESHOLD, because that first observation already "counted". This reproduces the reviewer's own
  // dash measurement (STALE_LIMIT_SECS=4, POLL_INTERVAL_SECS=2: measured kill 3.09s after the last
  // write, violating the >= 4s guarantee) and fails against the round-1 script for the same reason.
  // Item 3 (findings-2.9-r3): timestamps TERM receipt at the *engine* (TERM_TIMESTAMP_ENGINE writes
  // its own Date.now() the instant it gets SIGTERM) rather than timing the watchdog process's exit.
  // Measuring at the watchdog's exit conflated "how long staleness detection took" with "however long
  // terminate_engine's own signal-forwarding and reaping then additionally took" — extra, unrelated
  // latency that could pad the measured gap enough to mask a real violation of the >= L guarantee.
  it('never kills sooner than STALE_LIMIT_SECS after the true last heartbeat write', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    const termTimestampFile = join(dir, 'term-timestamp')
    await fsWriteFile(heartbeatPath, '')

    const staleLimitSecs = 4
    const pollIntervalSecs = 2
    const killGraceSecs = 1

    const { done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', TERM_TIMESTAMP_ENGINE, pidFile, termTimestampFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs, pollIntervalSecs, killGraceSecs })
    )

    const enginePid = await readPidFileTolerant(pidFile, 2_000)
    expect(enginePid).toBeDefined()

    let lastWriteAt = 0
    const tick = setInterval(() => {
      fsWriteFile(heartbeatPath, '')
        .then(() => {
          lastWriteAt = Date.now()
        })
        .catch(() => {})
    }, 300)
    // Keep the heartbeat fresh for a few seconds, then stop touching it entirely.
    await new Promise((r) => setTimeout(r, 3_000))
    clearInterval(tick)
    // Let a write already in flight actually land before treating this as "the last write".
    await new Promise((r) => setTimeout(r, 100))

    const budgetMs = (staleLimitSecs + pollIntervalSecs * 2 + 5) * 1000
    const result = await raceDone(done, budgetMs)

    expect(result.code).toBe(WATCHDOG_EXIT_CODE_STALE_HEARTBEAT)
    const termTimestampText = await readFile(termTimestampFile, 'utf8')
    const termReceivedAt = Number(termTimestampText.trim())
    expect(Number.isFinite(termReceivedAt)).toBe(true)

    const elapsedFromLastWriteSecs = (termReceivedAt - lastWriteAt) / 1000
    // Small measurement slack for scheduling/process overhead, not for correctness margin.
    expect(elapsedFromLastWriteSecs).toBeGreaterThanOrEqual(staleLimitSecs - 0.3)
    expect(elapsedFromLastWriteSecs).toBeLessThanOrEqual(staleLimitSecs + pollIntervalSecs * 2 + 1)
  }, 20_000)

  // Item 2 (findings-2.9-r2, new breakage ruled into this round): before the STOPPING guard, a
  // TERM/INT arriving while terminate_engine was already mid-grace-wait re-entered it from the top,
  // resetting the grace clock — a TERM repeating faster than KILL_GRACE_SECS could postpone the KILL
  // indefinitely. Runs under `dash` specifically (skipped where it is not installed): the reviewer's
  // own reproduction relied on dash's particular handling of a trap firing while already inside an
  // interrupted `wait`, and this host's default `/bin/sh` (bash-based on macOS) did not reproduce the
  // postponement reliably even under aggressive bombardment — confirmed by hand against the pre-fix
  // script (`dash`, 40 TERMs 100ms apart starting once stale-triggered: exit landed at ~10.8s against
  // a nominal ~5s, i.e. genuinely postponed, not just slow). This bombards the watchdog with TERM
  // throughout the stale path's own grace period and asserts it still exits (with 97, not whatever the
  // interrupted wait happened to leave behind) within a bounded time, with the engine actually dead.
  it.skipIf(!dashAvailable)(
    'does not let TERM arriving during the stale-heartbeat grace period restart the grace clock',
    async () => {
      const scriptPath = join(dir, 'entrypoint.sh')
      await writeWatchdogScript(scriptPath)
      const heartbeatPath = join(dir, 'heartbeat')
      const pidFile = join(dir, 'engine.pid')
      await fsWriteFile(heartbeatPath, '')

      const staleLimitSecs = 2
      const pollIntervalSecs = 1
      const killGraceSecs = 4

      const { child, done } = runWatchdog(
        scriptPath,
        [process.execPath, '-e', TERM_IGNORING_ENGINE, pidFile],
        watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs, pollIntervalSecs, killGraceSecs }),
        'dash'
      )

      const pid = await readPidFileTolerant(pidFile, 2_000)
      expect(pid).toBeDefined()

      // Let staleness actually trigger (threshold*poll ~= 3s; a whole second of margin, final review
      // M-10 — half a second was not enough under a loaded full suite) before bombarding with TERM, so this
      // targets the stale path's own grace wait specifically, not ordinary TERM-forwarding. Bombard
      // for several seconds at 100ms — the cadence confirmed by hand to reliably interrupt dash's
      // 1-second grace-loop sleep — well past killGraceSecs, then stop and let it finish.
      await new Promise((r) => setTimeout(r, (staleLimitSecs + pollIntervalSecs + 1) * 1000))
      const bombardStart = Date.now()
      const bombardEnd = bombardStart + (killGraceSecs + 3) * 1000
      const bombard = setInterval(() => {
        if (Date.now() >= bombardEnd) {
          clearInterval(bombard)
          return
        }
        child.kill('SIGTERM')
      }, 100)

      // Bound on total time generous enough that either outcome resolves before vitest's own test
      // timeout; the real check is elapsedSinceBombardStart below, not just "resolves eventually" —
      // without the guard this was observed to take ~7.3s from here (dash, identical timing), well
      // past killGraceSecs, because each TERM restarted the grace clock instead of continuing it.
      const result = await raceDone(done, 15_000)
      const elapsedSinceBombardStartSecs = (Date.now() - bombardStart) / 1000
      clearInterval(bombard)

      expect(result.code).toBe(WATCHDOG_EXIT_CODE_STALE_HEARTBEAT)
      // Upper bound: catches the grace clock being restarted (findings-2.9-r2 item 2).
      expect(elapsedSinceBombardStartSecs).toBeLessThanOrEqual(killGraceSecs + 2)
      // Lower bound: catches the *other* failure mode a per-iteration grace counter had
      // (findings-2.9-r3 item 2) — each interrupted "sleep 1 & wait $!" still advanced the counter by
      // a full nominal second regardless of how little real time had elapsed, so a rapid-enough TERM
      // storm could cut a real killGraceSecs-second grace period down to a small fraction of a second
      // (confirmed by hand: as low as ~300ms for killGraceSecs=3 under 100ms-spaced TERMs, since only
      // `killGraceSecs` reentries — not real seconds — were needed). The tolerance here is loose
      // (`- 2`, not a tight measurement slack) because this bound is not measuring the grace duration
      // itself: `bombardStart` is captured after a fixed pre-bombard wait, not at the exact instant
      // `terminate_engine` first set the deadline, and `GRACE_DEADLINE` itself is computed from
      // whole-second `date +%s` plus one (final review M-10), which puts the real elapsed grace anywhere
      // in `(killGraceSecs, killGraceSecs + 1]`; less the ~1 s between staleness and the first TERM,
      // that is well above the fraction of a second a restored per-iteration-counter bug produces.
      // killGraceSecs=4 (was 3) keeps this bound clear of the wider pre-bombard margin above.
      expect(elapsedSinceBombardStartSecs).toBeGreaterThanOrEqual(killGraceSecs - 2)
      if (pid !== undefined) await waitFor(async () => !(await pidAlive(pid)), 2_000)
    },
    25_000
  )

  // Item 3 (findings-2.9-r2, new breakage ruled into this round), deterministic reproduction: the
  // real script's "$@" & / ENGINE_PID=$! gap is two adjacent, non-blocking statements — there is no
  // blocking syscall there for an external signal to interrupt, so no amount of external timing can
  // reliably land a TERM inside it (confirmed: the black-box attempt below did not reproduce this
  // reliably even across many tries). Instead, this derives a script IDENTICAL to WATCHDOG_SCRIPT
  // except for one inserted `sleep 1` between those two statements, artificially widening the exact
  // same gap to something a signal sent 300ms later can hit every time. This exercises the real
  // terminate_engine's real pid-resolution logic — not a hand-written stand-in — under a precondition
  // equivalent to the race, just stretched out enough to test deterministically. Fails against the
  // round-1 script: `[ -n "$ENGINE_PID" ]` sees it still empty, returns early, and the trap exits 0
  // with the engine alive and orphaned.
  it('does not leak the engine when TERM lands in the gap before ENGINE_PID is assigned (widened, deterministic)', async () => {
    // Item 4 (findings-2.9-r3): widened from 1s to 3s, and TERM is now sent right after the pid file
    // is observed to exist rather than after a fixed 300ms guess — a slow/loaded CI host could take
    // longer than 300ms just to fork+exec node and have it write that file, which would send TERM
    // *after* the widened gap had already closed and made the test flaky rather than meaningful.
    // Waiting for the pid file instead ties "when to send TERM" to "the engine has actually started",
    // which holds regardless of host speed, as long as it starts within the 3s window at all.
    const widenedScript = WATCHDOG_SCRIPT.replace('"$@" &\nENGINE_PID=$!', '"$@" &\nsleep 3\nENGINE_PID=$!')
    expect(widenedScript).not.toBe(WATCHDOG_SCRIPT)
    const scriptPath = join(dir, 'entrypoint-widened.sh')
    await fsWriteFile(scriptPath, widenedScript)

    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 30, pollIntervalSecs: 5, killGraceSecs: 1 })
    )

    // Confirms the engine has actually started (and is therefore inside the widened gap, which does
    // not close until the script's own "sleep 3" completes) before sending TERM. In try/finally
    // (final review M-10): a failed assertion must not leave the long-lived engine running.
    try {
      const pid = await readPidFileTolerant(pidFile, 3_000)
      expect(pid).toBeDefined()
      child.kill('SIGTERM')

      const result = await raceDone(done, 6_000)
      expect(result.code).not.toBe(0)

      if (pid !== undefined) await waitFor(async () => !(await pidAlive(pid)), 2_000)
    } finally {
      child.kill('SIGKILL')
      await killEngineIfKnown(pidFile)
    }
  }, 12_000)

  // Item 3 (findings-2.9-r2), end-to-end, best effort: TERM sent as early as this harness can manage
  // after spawn, racing the real (un-widened) script's own boundary directly. This is not a reliable
  // discriminator on its own (see the test above for that) — it did not reproduce the bug across 20
  // tries in manual verification, since Node's own spawn overhead means the shell has almost always
  // already moved past the gap before the signal is sent — but it is a realistic integration check
  // that whatever timing a real `docker stop` might hit, nothing is ever left running.
  it('does not leak the engine when TERM arrives right at startup, before ENGINE_PID could be assigned', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)

    const attempts = 20
    for (let i = 0; i < attempts; i += 1) {
      const heartbeatPath = join(dir, `heartbeat-${i}`)
      const pidFile = join(dir, `engine-${i}.pid`)
      await fsWriteFile(heartbeatPath, '')

      const { child, done } = runWatchdog(
        scriptPath,
        [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
        watchdogEnv({
          heartbeatFile: heartbeatPath,
          staleLimitSecs: 30,
          pollIntervalSecs: 5,
          killGraceSecs: 1,
        })
      )
      child.kill('SIGTERM')

      await raceDone(done, 4_000).catch(() => undefined)

      const pid = await readPidFileTolerant(pidFile, 300)
      if (pid !== undefined) {
        await waitFor(async () => !(await pidAlive(pid)), 2_000)
      }
    }
  }, 90_000)

  // Item 6 (findings-2.9-r3): if the engine happens to exit on its own during the very poll that also
  // turns out stale, its own exit status must win over 97 — hiding a real crash/OOM behind the
  // generic stale-heartbeat code would make that failure unreadable from the exit code alone.
  // staleLimitSecs=2, pollIntervalSecs=2 => THRESHOLD=2, so staleness is declared at the end of the
  // second poll (~t=4s); the fake engine self-exits at t=3s, squarely inside that second poll's sleep
  // with a whole second either side (final review M-10: was t=1.5s against polls at 1s and 2s), so by
  // the time the watchdog re-checks liveness it is already gone.
  it("reports the engine's own exit status when it exits on its own during a poll that is also stale", async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    const { done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', selfExitingEngine(3_000, 9), pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 2, pollIntervalSecs: 2, killGraceSecs: 1 })
    )

    const result = await raceDone(done, 8_000)
    expect(result.code).toBe(9)
  }, 12_000)
})
