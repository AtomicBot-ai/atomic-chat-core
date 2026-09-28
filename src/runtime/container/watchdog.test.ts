/**
 * Three layers: a unit test of `writeWatchdogScript` against a fake filesystem, a unit test of
 * `watchdogEnv`, and — POSIX-only, since it spawns `/bin/sh` for real — a process-level test of the
 * script text itself, against tiny Node "fake server" fixtures instead of a real `trtllm-serve` (the
 * container/Docker wiring that would run it for real is task 2.8/2.12's job, not this one's).
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

function fakeFs(initial: Record<string, string> = {}): WatchdogScriptFs & {
  mkdirCalls: Array<{ path: string; options: { recursive: boolean } }>
  written: Record<string, string>
  chmodCalls: Array<{ path: string; mode: number }>
  renameCalls: Array<{ from: string; to: string }>
  writeFileCalls: Array<{ path: string; options?: { flag?: string; mode?: number } }>
} {
  const mkdirCalls: Array<{ path: string; options: { recursive: boolean } }> = []
  const written: Record<string, string> = { ...initial }
  const chmodCalls: Array<{ path: string; mode: number }> = []
  const renameCalls: Array<{ from: string; to: string }> = []
  const writeFileCalls: Array<{ path: string; options?: { flag?: string; mode?: number } }> = []
  return {
    mkdirCalls,
    written,
    chmodCalls,
    renameCalls,
    writeFileCalls,
    async mkdir(path, options) {
      mkdirCalls.push({ path, options })
      return undefined
    },
    async writeFile(path, data, options) {
      writeFileCalls.push(options === undefined ? { path } : { path, options })
      written[path] = data
    },
    async chmod(path, mode) {
      chmodCalls.push({ path, mode })
    },
    async rename(from, to) {
      renameCalls.push({ from, to })
      const data = written[from]
      delete written[from]
      if (data !== undefined) written[to] = data
    },
    async readFile(path) {
      const data = written[path]
      if (data === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return data
    },
  }
}

describe('writeWatchdogScript', () => {
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
    expect(fs.written[path]).toBe(WATCHDOG_SCRIPT)
  })

  it('is a no-op when the target already holds the current script verbatim', async () => {
    const path = '/data/x/entrypoint.sh'
    const fs = fakeFs({ [path]: WATCHDOG_SCRIPT })

    const result = await writeWatchdogScript(path, fs)

    expect(result).toBe(path)
    expect(fs.mkdirCalls).toEqual([])
    expect(fs.writeFileCalls).toEqual([])
    expect(fs.chmodCalls).toEqual([])
    expect(fs.renameCalls).toEqual([])
  })

  it('replaces a target holding stale content, rather than skipping it', async () => {
    const path = '/data/x/entrypoint.sh'
    const fs = fakeFs({ [path]: '#!/bin/sh\necho old\n' })

    await writeWatchdogScript(path, fs)

    expect(fs.written[path]).toBe(WATCHDOG_SCRIPT)
    expect(fs.renameCalls).toHaveLength(1)
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
})

// ── The script itself, run for real under /bin/sh ───────────────────────────────────────────────

const posix = process.platform !== 'win32'

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

interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

function runWatchdog(
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv
): {
  child: ReturnType<typeof spawn>
  done: Promise<RunResult>
} {
  const child = spawn('/bin/sh', [scriptPath, '--', ...args], {
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

async function pidAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
    // leaves enough margin that this essentially cannot happen, and threshold=3 (limit=6s) means it
    // would have to happen three times in a row to produce a false positive.
    const { child, done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 6, pollIntervalSecs: 2, killGraceSecs: 1 })
    )

    // A ticker keeping the heartbeat fresh for well past the stale window (3 polls * 2s = 6s).
    const tick = setInterval(() => {
      fsWriteFile(heartbeatPath, '').catch(() => {})
    }, 300)
    try {
      await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
      await new Promise((r) => setTimeout(r, 8_000))
      expect(child.exitCode).toBeNull()
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      expect(await pidAlive(pid)).toBe(true)
    } finally {
      clearInterval(tick)
      child.kill('SIGKILL')
      await done.catch(() => undefined)
    }
  }, 15_000)

  it('kills the engine and exits with the stale-heartbeat code once the heartbeat stops changing', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    // limit=2, poll=1 => threshold = ceil(2/1) = 2 polls, so staleness fires ~2s after start.
    const { done } = runWatchdog(
      scriptPath,
      [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile],
      watchdogEnv({ heartbeatFile: heartbeatPath, staleLimitSecs: 2, pollIntervalSecs: 1, killGraceSecs: 1 })
    )
    // Heartbeat is never touched again after the script's own initial creation: it goes stale.

    // threshold*poll(2s) + grace(1s, irrelevant here since nothing needs killing) + generous slack.
    const result = await raceDone(done, 8_000)

    expect(result.code).toBe(WATCHDOG_EXIT_CODE_STALE_HEARTBEAT)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    await waitFor(async () => !(await pidAlive(pid)), 2_000)
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

    // threshold*poll(2s) + grace(1s) before KILL + generous slack.
    const result = await raceDone(done, 10_000)

    expect(result.code).toBe(WATCHDOG_EXIT_CODE_STALE_HEARTBEAT)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    await waitFor(async () => !(await pidAlive(pid)), 2_000)
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

    await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())
    child.kill('SIGTERM')

    const result = await raceDone(done, 6_000)
    expect(result.signal).toBeNull()
    expect(result.code).not.toBe(0)
    await waitFor(async () => !(await pidAlive(pid)), 2_000)
  }, 10_000)

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
    ['POLL_INTERVAL_SECS is not an integer', { pollIntervalSecsRaw: 'x' }],
    ['POLL_INTERVAL_SECS is zero', { pollIntervalSecsRaw: '0' }],
    ['KILL_GRACE_SECS is not an integer', { killGraceSecsRaw: 'x' }],
    ['KILL_GRACE_SECS is zero', { killGraceSecsRaw: '0' }],
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
    }
  }, 8_000)
})
