/**
 * The watchdog entrypoint script, run for real under `/bin/sh` (POSIX only): startup, a fresh
 * heartbeat, the engine's own exit, refused timing values, and the heartbeat file at startup.
 * The script's real-time scenarios are split across the `watchdog.script-*.test.ts` files so vitest
 * runs them on separate workers; they share `test/helpers/watchdog-harness.ts`. The unit tests of
 * `watchdogEnv` and `writeWatchdogScript` are in `watchdog.test.ts`.
 */
import { readFile, stat, writeFile as fsWriteFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WATCHDOG_ENV_VARS,
  WATCHDOG_EXIT_CODE_CONFIG_ERROR,
  watchdogEnv,
  writeWatchdogScript,
} from './watchdog.js'
import {
  killEngineIfKnown,
  LONG_LIVED_ENGINE,
  pidAlive,
  posix,
  raceDone,
  readPidFileTolerant,
  runWatchdog,
  useTmpDir,
  waitFor,
} from '../../../test/helpers/watchdog-harness.js'

describe.skipIf(!posix)('the watchdog entrypoint script', () => {
  const tmpDir = useTmpDir()

  it('lets the engine keep running while the heartbeat stays fresh', async () => {
    const dir = tmpDir()
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

  it('propagates the engine exit status when the engine exits on its own', async () => {
    const dir = tmpDir()
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
      const dir = tmpDir()
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
    const dir = tmpDir()
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
    const dir = tmpDir()
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
    const dir = tmpDir()
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
})
