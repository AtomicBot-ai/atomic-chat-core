/**
 * The watchdog entrypoint script, run for real under `/bin/sh` (POSIX only): the timing window of
 * the stale-heartbeat rule — never too early, and never on a heartbeat that stays fresh.
 * The script's real-time scenarios are split across the `watchdog.script-*.test.ts` files so vitest
 * runs them on separate workers; they share `test/helpers/watchdog-harness.ts`. The unit tests of
 * `watchdogEnv` and `writeWatchdogScript` are in `watchdog.test.ts`.
 */
import { readFile, stat, writeFile as fsWriteFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WATCHDOG_EXIT_CODE_STALE_HEARTBEAT, watchdogEnv, writeWatchdogScript } from './watchdog.js'
import {
  killEngineIfKnown,
  LONG_LIVED_ENGINE,
  pidAlive,
  posix,
  raceDone,
  readPidFileTolerant,
  runWatchdog,
  TERM_TIMESTAMP_ENGINE,
  useTmpDir,
  waitFor,
} from '../../../test/helpers/watchdog-harness.js'

describe.skipIf(!posix)('the watchdog entrypoint script', () => {
  const tmpDir = useTmpDir()

  // Item 1 (findings-2.9-r2, Important, controller-described off-by-one): the round-1 script counted
  // the poll that *establishes* the baseline observation as "1 unchanged poll" already, instead of 0.
  // With STALE_LIMIT_SECS < POLL_INTERVAL_SECS (THRESHOLD == 1), that alone satisfied the threshold
  // on literally the first poll, killing the engine immediately regardless of freshness. This test
  // fails against the round-1 script (exits 97 almost immediately instead of surviving).
  it('never kills a continuously-fresh heartbeat when STALE_LIMIT_SECS <= POLL_INTERVAL_SECS', async () => {
    const dir = tmpDir()
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
    const dir = tmpDir()
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
})
