/**
 * The watchdog entrypoint script, run for real under `/bin/sh` (POSIX only): staleness and TERM
 * leading to the TERM→KILL escalation, the grace period, and whose exit status wins.
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
  selfExitingEngine,
  TERM_AWARE_ENGINE,
  TERM_IGNORING_ENGINE,
  useTmpDir,
  waitFor,
} from '../../../test/helpers/watchdog-harness.js'

describe.skipIf(!posix)('the watchdog entrypoint script', () => {
  const tmpDir = useTmpDir()

  it('kills the engine and exits with the stale-heartbeat code once the heartbeat stops changing', async () => {
    const dir = tmpDir()
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
    const dir = tmpDir()
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

  it('forwards TERM to the engine and exits once the engine has reacted to it', async () => {
    const dir = tmpDir()
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
    const dir = tmpDir()
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
    const dir = tmpDir()
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

  // Item 6 (findings-2.9-r3): if the engine happens to exit on its own during the very poll that also
  // turns out stale, its own exit status must win over 97 — hiding a real crash/OOM behind the
  // generic stale-heartbeat code would make that failure unreadable from the exit code alone.
  // staleLimitSecs=2, pollIntervalSecs=2 => THRESHOLD=2, so staleness is declared at the end of the
  // second poll (~t=4s); the fake engine self-exits at t=3s, squarely inside that second poll's sleep
  // with a whole second either side (final review M-10: was t=1.5s against polls at 1s and 2s), so by
  // the time the watchdog re-checks liveness it is already gone.
  it("reports the engine's own exit status when it exits on its own during a poll that is also stale", async () => {
    const dir = tmpDir()
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
