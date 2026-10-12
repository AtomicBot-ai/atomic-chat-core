/**
 * The watchdog entrypoint script, run for real under `/bin/sh` (POSIX only): TERM landing at the
 * edges of startup and of the stale-heartbeat grace period.
 * The script's real-time scenarios are split across the `watchdog.script-*.test.ts` files so vitest
 * runs them on separate workers; they share `test/helpers/watchdog-harness.ts`. The unit tests of
 * `watchdogEnv` and `writeWatchdogScript` are in `watchdog.test.ts`.
 */
import { writeFile as fsWriteFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WATCHDOG_EXIT_CODE_STALE_HEARTBEAT,
  WATCHDOG_SCRIPT,
  watchdogEnv,
  writeWatchdogScript,
} from './watchdog.js'
import {
  dashAvailable,
  killEngineIfKnown,
  LONG_LIVED_ENGINE,
  pidAlive,
  posix,
  raceDone,
  readPidFileTolerant,
  runWatchdog,
  TERM_IGNORING_ENGINE,
  useTmpDir,
  waitFor,
} from '../../../test/helpers/watchdog-harness.js'

describe.skipIf(!posix)('the watchdog entrypoint script', () => {
  const tmpDir = useTmpDir()

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
      const dir = tmpDir()
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
    const dir = tmpDir()
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
    const dir = tmpDir()
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
})
