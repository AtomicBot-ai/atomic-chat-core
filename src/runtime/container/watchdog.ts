/**
 * The watchdog entrypoint for a `tensorrt-llm` model container (openspec change
 * `add-tensorrt-llm-linux`, task 2.9, spec `tensorrt-llm-runtime` ▸ "Watchdog гарантирует
 * освобождение GPU"). Docker gives it PID 1 in place of `trtllm-serve`: it starts the engine, then
 * polls a heartbeat file the core keeps touching (see `heartbeat.ts`) from outside the container.
 * If that file stops changing, the core is presumed dead (crashed, killed, machine slept) and the
 * engine is torn down so the GPU is freed even though nothing asked for that on purpose. The
 * requirement is explicit that this cannot be turned off by a setting: there is no config path that
 * skips the poll loop, only the timing knobs below.
 *
 * For the script to actually be able to do this, the executor (task 2.8/2.12) MUST run it as the
 * container's PID 1 — directly, or under `--init` — and MUST NOT run the container with
 * `--pid=host`: a watchdog that is not PID 1 does not own the process tree Docker tears down when
 * the container exits, and `trtllm-serve`'s own worker processes would then survive the watchdog's
 * own exit instead of dying with it.
 *
 * The script is embedded as a plain POSIX `/bin/sh` string rather than loaded from a file at
 * runtime, because the core must stay runtime-agnostic (no `import.meta.url`-relative loading) and
 * because the container never gets write access to it — `writeWatchdogScript` below is the only way
 * it reaches disk, mode `0555`, for the executor to bind-mount read-only next to the model.
 *
 * Docker argv/mount wiring, the executor that invokes this, and the lifecycle that runs the
 * heartbeat ticker against a real container are out of scope here (tasks 2.8, 2.11, 2.12); this
 * module only provides the script text, the function that writes it to a given path, and
 * `watchdogEnv`, the one place that turns the timing constants into the env vars the script reads —
 * callers should use it rather than building that env object by hand, so a future change to a
 * default only has to happen here.
 */

import { randomBytes } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'

// ── Timing constants ─────────────────────────────────────────────────────────────────────────────
//
// Placeholders (design.md "Open Questions" ▸ "Точные значения heartbeat-интервала, лимита
// watchdog... измеряются в live-тесте core"): task 2.19 measures real values against real hardware
// and updates these. They are deliberately generous relative to a plausible heartbeat write cost so
// a slow disk does not trip the watchdog on its own. This is the one place all three live — the
// heartbeat ticker (`heartbeat.ts`), the watchdog script and `watchdogEnv` below all agree with each
// other only because everything reads from here; nothing else in the codebase should redeclare them.

/** How often the core touches the heartbeat file. */
export const DEFAULT_HEARTBEAT_INTERVAL_SECS = 5
/** How long the heartbeat file may go unchanged before the watchdog kills the engine. */
export const DEFAULT_WATCHDOG_STALE_LIMIT_SECS = 30
/** How often the watchdog polls the heartbeat file. */
export const DEFAULT_WATCHDOG_POLL_INTERVAL_SECS = DEFAULT_HEARTBEAT_INTERVAL_SECS
/** TERM→KILL grace the watchdog gives the engine once it has decided to stop it. */
export const DEFAULT_WATCHDOG_KILL_GRACE_SECS = 10

// ── Script configuration surface ─────────────────────────────────────────────────────────────────
//
// The script's own argv is reserved entirely for the engine command Docker passes as CMD (it must
// follow a literal "--" and is forwarded as "$@", never built into or eval'd as a shell string), so
// the watchdog's own settings travel as env vars instead.

export const WATCHDOG_ENV_VARS = {
  heartbeatFile: 'ATOMIC_WATCHDOG_HEARTBEAT_FILE',
  staleLimitSecs: 'ATOMIC_WATCHDOG_STALE_LIMIT_SECS',
  pollIntervalSecs: 'ATOMIC_WATCHDOG_POLL_INTERVAL_SECS',
  killGraceSecs: 'ATOMIC_WATCHDOG_KILL_GRACE_SECS',
} as const

export interface WatchdogEnvOptions {
  /** Path to the heartbeat file inside the container; no default, since it has no sane one. */
  heartbeatFile: string
  staleLimitSecs?: number
  pollIntervalSecs?: number
  killGraceSecs?: number
}

/**
 * Builds the `ATOMIC_WATCHDOG_*` env vars the script needs, filling in the timing constants above
 * for anything the caller does not override. This is the single place that turns those constants
 * into the wire form the script reads — the executor/lifecycle MUST build the container's env
 * through this function rather than re-deriving `ATOMIC_WATCHDOG_POLL_INTERVAL_SECS` and friends
 * itself, so the three timing knobs never drift out of sync with the ticker's own default interval.
 */
export function watchdogEnv(options: WatchdogEnvOptions): Record<string, string> {
  return {
    [WATCHDOG_ENV_VARS.heartbeatFile]: options.heartbeatFile,
    [WATCHDOG_ENV_VARS.staleLimitSecs]: String(options.staleLimitSecs ?? DEFAULT_WATCHDOG_STALE_LIMIT_SECS),
    [WATCHDOG_ENV_VARS.pollIntervalSecs]: String(
      options.pollIntervalSecs ?? DEFAULT_WATCHDOG_POLL_INTERVAL_SECS
    ),
    [WATCHDOG_ENV_VARS.killGraceSecs]: String(options.killGraceSecs ?? DEFAULT_WATCHDOG_KILL_GRACE_SECS),
  }
}

/** The script's own config was missing or malformed (missing env var, missing `--` separator, a
 *  timing value that is not a positive integer). */
export const WATCHDOG_EXIT_CODE_CONFIG_ERROR = 96
/** The heartbeat observation (an mtime, or "missing") held unchanged for the stale threshold. */
export const WATCHDOG_EXIT_CODE_STALE_HEARTBEAT = 97

/** Suggested filename for `writeWatchdogScript`'s target; the executor decides the actual path. */
export const WATCHDOG_SCRIPT_FILENAME = 'atomic-watchdog-entrypoint.sh'
/** Mode the script is written with: readable and executable, never writable, not even by owner. */
export const WATCHDOG_SCRIPT_MODE = 0o555

// ── The script itself ────────────────────────────────────────────────────────────────────────────
//
// Built from an array of lines (not a template literal) so the shell's own "${...}" syntax never
// collides with JavaScript's — nothing here needs interpolation from TypeScript.
//
// Notes on choices that are not obvious from the text:
//
//  - `set -u` only, not `-e`: shells disagree on whether `set -e` fires when a command substitution
//    used in a plain assignment (`x=$(cmd)`) fails, so every failure this script cares about is
//    checked explicitly instead.
//
//  - Staleness is judged by whether the heartbeat *observation* — its mtime, or the literal
//    "missing" — has stayed the same for `THRESHOLD` consecutive polls counted from script start,
//    never by comparing that mtime against the current wall clock. A wall-clock "now - mtime >=
//    limit" check has three real failure modes this avoids: an unwritable heartbeat directory made
//    the tolerant create's own redirection fail in a way that used to abort the whole shell before
//    the engine even started (a `: > file` redirection failure is a *special builtin* error, which
//    POSIX allows a non-interactive shell to treat as fatal); a leftover heartbeat file from a
//    previous run has an mtime old enough to look already-stale on the very first poll; and a host
//    clock that jumps (NTP step, VM pause/resume) desyncs "now" from the mtime it is compared against
//    in either direction. Comparing consecutive observations to each other sidesteps all three: the
//    file being created late, missing outright, or already old are just more values that either stay
//    the same (and eventually trip the threshold) or change (and reset the count), independent of
//    what time it is. The baseline (`PREV_OBSERVATION`) is read exactly once, right after the
//    tolerant create, and `UNCHANGED_POLLS` starts at 0 and is reset to 0 (not 1) on every change —
//    the poll that first observes a value establishes the baseline, it does not itself count as one
//    confirmed-unchanged poll, or `STALE_LIMIT_SECS <= POLL_INTERVAL_SECS` would kill a heartbeat
//    that was changing on every single poll (findings-2.9-r2 item 1).
//
//  - `THRESHOLD = ceil((STALE_LIMIT_SECS + 1) / POLL_INTERVAL_SECS)`, not `ceil(STALE_LIMIT_SECS /
//    POLL_INTERVAL_SECS)`. Plain `ceil(limit/poll)` polls after the baseline is *usually* enough, but
//    mtime's whole-second resolution can make it up to a second short: a write at, say, X.9s records
//    mtime X, and a later poll landing at exactly X+limit can already show that same integer second
//    as its own most recent write if that write also happened to floor to X — so a plain
//    `ceil(limit/poll)` can fire as early as `limit - 1` real seconds after the true last write when
//    `poll` evenly divides `limit`. Padding the numerator by one whole second absorbs that one-second
//    floor error, so the kill is never earlier than `STALE_LIMIT_SECS` after the last real write —
//    only, in the worst case, up to `POLL_INTERVAL_SECS` later than the old formula would have fired
//    (findings-2.9-r3 item 3; a smaller, residual version of the round-2 off-by-one's own symptom —
//    that one could fire a full poll interval early in the general case and is fixed separately
//    above; this is the up-to-one-second error that remains from mtime's own rounding even once the
//    poll counting itself is exactly right).
//
//  - A heartbeat file that already exists when the script starts is left alone, not truncated: the
//    tolerant create only runs when nothing is there yet. Its age never mattered to the loop above,
//    only whether it keeps changing from here on, so there was never a correctness reason to touch
//    it — and leaving it alone is what makes "a genuinely leftover file" something a test can set up
//    and then verify was not clobbered.
//
//  - mtime is read with `stat -c %Y` (GNU coreutils — the actual runtime is the NGC Ubuntu base
//    image) falling back to `stat -f %m` (BSD/macOS `stat`), so the exact same file also runs under
//    the `/bin/sh` on a macOS development machine, which is what the test suite for this script does
//    (no container involved). Both forms report mtime with whole-second resolution only, which
//    matters for how small `ATOMIC_WATCHDOG_POLL_INTERVAL_SECS` can safely be: two polls one second
//    apart can land on either side of the *same* integer second under ordinary scheduling jitter
//    even while the file is genuinely being rewritten several times a second, reading as a false
//    "unchanged" observation. `DEFAULT_WATCHDOG_POLL_INTERVAL_SECS` (5s, matching the heartbeat
//    ticker's own default interval) gives ample margin; a caller that overrides it much smaller than
//    that should keep `STALE_LIMIT_SECS` large enough, relative to the poll interval, that one
//    aliased poll cannot look like a full stale window on its own.
//
//  - The poll sleep is backgrounded and `wait`-ed (`sleep "$N" & wait $!`) rather than run in the
//    foreground, and traps are installed before the engine ever starts: a foreground `sleep` blocks
//    a POSIX shell from running a trap until that sleep itself returns, so `docker stop`'s TERM
//    could sit unhandled for up to one whole poll interval; `wait` is interruptible immediately.
//    Traps go in before `"$@" &` because this script is the container's PID 1, and PID 1 gets no
//    signal at all for anything it has not explicitly trapped — a window with the engine running and
//    no trap installed yet would make `docker stop` silently do nothing during it.
//
//  - INT is forwarded as TERM, not as INT: a command started with `&` when job control is off (the
//    normal state for a non-interactive script) has SIGINT ignored for it by the shell as part of
//    POSIX's rules for asynchronous lists, so sending the engine a literal INT can be a silent
//    no-op. TERM has no such carve-out, so both signals converge on it.
//
//  - Both the stale-heartbeat path and TERM/INT forwarding go through the same `terminate_engine`:
//    TERM, then poll for exit, escalating to KILL once `KILL_GRACE_SECS` has passed with the engine
//    still alive. Forwarding a stop signal is not allowed to hang forever on an engine that never
//    reacts. The poll itself is a short `sleep 0.25 & wait $!` (backgrounded/`wait`-ed, for the same
//    reason as the main loop's poll sleep) rather than a full second, so an engine that dies right
//    after TERM is noticed promptly — `kill -0` cannot tell a genuinely running process from a
//    not-yet-reaped zombie, so without frequent re-checking, the *first* check after sending TERM
//    would still see the (zombie) pid as present and commit to a full second's wait before checking
//    again (findings-2.9-r3 item 7).
//
//  - `terminate_engine` guards against re-entry with `STOPPING`: a second TERM/INT arriving while a
//    shutdown is already in progress (`docker stop` repeating itself, or a TERM landing during the
//    stale path's own grace wait) does not restart the grace clock, and — as of this round — does not
//    even shorten it. `GRACE_DEADLINE` is a wall-clock deadline (`date +%s` plus `KILL_GRACE_SECS`
//    plus one, seconds since the epoch) taken once, the first time `STOPPING` flips to 1, and never touched
//    again; the initial signal is likewise sent only once. Two rounds of the same bug, both from
//    treating the grace period as a count of loop iterations instead of an actual span of time:
//    counting *polls* let a trap firing again *during* the interrupted call's own `wait` restart
//    `terminate_engine` from its top on every signal, so a TERM repeating faster than `KILL_GRACE_SECS`
//    could postpone the KILL indefinitely (findings-2.9-r2 item 2); the first fix for that counted
//    *elapsed polls* instead of restarting them, which stopped the postponement but introduced the
//    opposite problem — each interrupted poll still advanced the count by a full nominal second
//    regardless of how little real time had actually elapsed, so ten TERMs 100ms apart could cut a
//    10s grace period down to close to 1s (findings-2.9-r3 item 2). A wall-clock deadline is immune to
//    both: however many times the wait gets interrupted and re-entered, "is it past the deadline yet"
//    gives the same answer it would have without any interruptions at all. `STOP_EXIT_CODE` exists for
//    the same re-entry: if the stale path is what is tearing the engine down, its trap invocation
//    (should one fire mid-shutdown) must still `exit 97`, not whatever status the interrupted `wait`
//    happened to leave in `$?` — the stale branch sets it before calling `terminate_engine`, and the
//    TERM/INT trap falls back to `$?` only when nothing set it. The `+ 1` (final review M-10):
//    `date +%s` floors, so a deadline of `now + KILL_GRACE_SECS` taken at X.9 s fired at X+G, only
//    G-0.9 s later — the real grace landed anywhere in (G-1, G]. Adding one second makes it
//    (G, G+1]: never shorter than the grace an engine was promised, at most a second longer.
//
//  - `date +%s` and a fractional `sleep 0.25` are not POSIX, but both shells this script runs under
//    support them: GNU coreutils in the NGC Ubuntu base image, and BSD `date`/`sleep` on the macOS
//    machines its tests run on. A base image without them would need this revisited.
//
//  - `terminate_engine` resolves the pid to act on as `${ENGINE_PID:-$!}` (with `set +u`/`set -u`
//    bracketing it, since `$!` is unset — not just empty — before any job has ever been backgrounded,
//    and referencing an unset special parameter under `set -u` is itself fatal on at least one real
//    `/bin/sh`). A TERM/INT landing in the gap between `"$@" &` starting the engine and the very next
//    statement assigning `ENGINE_PID=$!` would otherwise see `ENGINE_PID` still empty and return
//    early as if there were nothing to stop — exiting 0 with the engine alive and orphaned
//    (findings-2.9-r2 item 3). `$!` — the shell's own record of the most recently started background
//    job — still resolves correctly in exactly that gap, because it is set by `&` itself, before the
//    next statement ever runs.
//
//  - A missing heartbeat file is just another observation value, not a special case: the file is
//    still created tolerantly at startup (wrapped in a subshell, `( : > "$F" ) 2>/dev/null || true`,
//    so a failure there cannot take the special-builtin-abort path down with it), but nothing past
//    that point depends on it having worked.
//
//  - The main loop re-checks `kill -0 "$ENGINE_PID"` immediately before acting on a stale reading, not
//    only at the top of the loop: the poll sleep can span the exact moment the engine exits on its
//    own, and without this second check a poll that turned out stale *and* found the engine already
//    gone would still report the stale-heartbeat exit code (97) instead of the engine's own — hiding
//    what actually happened (a crash, an OOM kill) behind a code that means something else entirely
//    (findings-2.9-r3 item 6).
//
//  - "$@" is always quoted and only ever used to start a background process, never passed to `eval`
//    or a shell -c string, so nothing in the engine's own argv can be interpreted as shell syntax.
const WATCHDOG_SCRIPT_LINES: readonly string[] = [
  '#!/bin/sh',
  '# atomic-chat-core watchdog entrypoint (openspec change add-tensorrt-llm-linux, task 2.9).',
  '# Generated by src/runtime/container/watchdog.ts — do not edit the mounted copy by hand.',
  '#',
  '# Starts the engine command given after "--" in the background, then kills it and exits if the',
  '# heartbeat file the core touches from outside the container stops changing. Configuration is env',
  '# vars (see watchdogEnv() in watchdog.ts); the script argv is reserved for the engine command.',
  "# Must run as the container's PID 1 (directly or under --init); the container must not use",
  "# --pid=host, or the engine's own workers will outlive this script's exit.",
  '',
  'set -u',
  '',
  'WATCHDOG_EXIT_CONFIG_ERROR=96',
  'WATCHDOG_EXIT_STALE_HEARTBEAT=97',
  '',
  'fail() {',
  '  echo "atomic-watchdog: $1" >&2',
  '  exit "$WATCHDOG_EXIT_CONFIG_ERROR"',
  '}',
  '',
  '[ -n "${ATOMIC_WATCHDOG_HEARTBEAT_FILE:-}" ] || fail "ATOMIC_WATCHDOG_HEARTBEAT_FILE is required"',
  '[ -n "${ATOMIC_WATCHDOG_STALE_LIMIT_SECS:-}" ] || fail "ATOMIC_WATCHDOG_STALE_LIMIT_SECS is required"',
  '[ -n "${ATOMIC_WATCHDOG_POLL_INTERVAL_SECS:-}" ] || fail "ATOMIC_WATCHDOG_POLL_INTERVAL_SECS is required"',
  '[ -n "${ATOMIC_WATCHDOG_KILL_GRACE_SECS:-}" ] || fail "ATOMIC_WATCHDOG_KILL_GRACE_SECS is required"',
  '',
  'HEARTBEAT_FILE=$ATOMIC_WATCHDOG_HEARTBEAT_FILE',
  'STALE_LIMIT_SECS=$ATOMIC_WATCHDOG_STALE_LIMIT_SECS',
  'POLL_INTERVAL_SECS=$ATOMIC_WATCHDOG_POLL_INTERVAL_SECS',
  'KILL_GRACE_SECS=$ATOMIC_WATCHDOG_KILL_GRACE_SECS',
  '',
  '# A malformed timing value must not silently disable the watchdog (a non-integer',
  '# STALE_LIMIT_SECS would make the arithmetic below fail with "Illegal number" only once it is',
  '# first used, and a zero POLL_INTERVAL_SECS would turn the poll loop into a busy loop). A leading',
  '# zero is rejected too, not just tolerated as decimal: "08"/"09" are not valid octal digits and',
  '# abort arithmetic evaluation outright, and "010" is silently octal 8, not decimal ten — neither',
  '# is a value anyone setting this env var meant to produce.',
  'validate_positive_int() {',
  '  case $2 in',
  "    ''|*[!0-9]*|0|0[0-9]*) fail \"$1 must be a positive integer with no leading zero (got '$2')\" ;;",
  '  esac',
  '  [ "$2" -gt 0 ] 2>/dev/null || fail "$1 must be a positive integer with no leading zero (got \'$2\')"',
  '}',
  'validate_positive_int ATOMIC_WATCHDOG_STALE_LIMIT_SECS "$STALE_LIMIT_SECS"',
  'validate_positive_int ATOMIC_WATCHDOG_POLL_INTERVAL_SECS "$POLL_INTERVAL_SECS"',
  'validate_positive_int ATOMIC_WATCHDOG_KILL_GRACE_SECS "$KILL_GRACE_SECS"',
  '',
  '[ "${1:-}" = "--" ] || fail "expected -- before the engine command"',
  'shift',
  '',
  '# Consecutive-unchanged-polls threshold. +1 on the limit (equivalently: ceil((limit+1)/poll))',
  "# pads out one whole second of slack for mtime's own whole-second rounding, so a kill can never",
  '# land earlier than STALE_LIMIT_SECS after the true last write, only possibly a bit later.',
  "# PREV_OBSERVATION is seeded once, right below (after the tolerant create), from the heartbeat's",
  '# actual state; UNCHANGED_POLLS then counts polls whose observation matched the one before it,',
  '# starting from 0 — the poll that establishes the baseline is not itself counted as unchanged.',
  'THRESHOLD=$(( (STALE_LIMIT_SECS + POLL_INTERVAL_SECS) / POLL_INTERVAL_SECS ))',
  '',
  '# Only if nothing is there yet: a genuinely leftover file from a previous run is left alone. Best-',
  '# effort either way — staleness is judged by the observation loop below, not by this having worked.',
  'if [ ! -e "$HEARTBEAT_FILE" ]; then',
  '  ( : > "$HEARTBEAT_FILE" ) 2>/dev/null || true',
  'fi',
  '',
  'heartbeat_observation() {',
  '  m=$(stat -c %Y "$1" 2>/dev/null) && { echo "$m"; return 0; }',
  '  m=$(stat -f %m "$1" 2>/dev/null) && { echo "$m"; return 0; }',
  '  echo missing',
  '}',
  '',
  'PREV_OBSERVATION=$(heartbeat_observation "$HEARTBEAT_FILE")',
  'UNCHANGED_POLLS=0',
  '',
  'ENGINE_PID=',
  'STOPPING=0',
  'GRACE_DEADLINE=',
  'STOP_EXIT_CODE=',
  '',
  'terminate_engine() {',
  '  set +u',
  '  pid=${ENGINE_PID:-$!}',
  '  set -u',
  '  [ -n "$pid" ] || return 0',
  '  if [ "$STOPPING" -eq 0 ]; then',
  '    STOPPING=1',
  '    kill -"$1" "$pid" 2>/dev/null || true',
  '    GRACE_DEADLINE=$(( $(date +%s) + KILL_GRACE_SECS + 1 ))',
  '  fi',
  '  while kill -0 "$pid" 2>/dev/null; do',
  '    if [ "$(date +%s)" -ge "$GRACE_DEADLINE" ]; then',
  '      kill -KILL "$pid" 2>/dev/null || true',
  '      break',
  '    fi',
  '    sleep 0.25 & wait $!',
  '  done',
  '  wait "$pid" 2>/dev/null',
  '}',
  '',
  'trap \'terminate_engine TERM; exit "${STOP_EXIT_CODE:-$?}"\' TERM',
  'trap \'terminate_engine TERM; exit "${STOP_EXIT_CODE:-$?}"\' INT',
  '',
  '"$@" &',
  'ENGINE_PID=$!',
  '',
  'while true; do',
  '  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then',
  '    wait "$ENGINE_PID"',
  '    exit $?',
  '  fi',
  '',
  '  sleep "$POLL_INTERVAL_SECS" & wait $!',
  '',
  '  OBSERVATION=$(heartbeat_observation "$HEARTBEAT_FILE")',
  '  if [ "$OBSERVATION" = "$PREV_OBSERVATION" ]; then',
  '    UNCHANGED_POLLS=$((UNCHANGED_POLLS + 1))',
  '  else',
  '    UNCHANGED_POLLS=0',
  '    PREV_OBSERVATION=$OBSERVATION',
  '  fi',
  '',
  '  if [ "$UNCHANGED_POLLS" -ge "$THRESHOLD" ]; then',
  '    # The engine may have exited on its own during the sleep just above, in the same poll that',
  '    # also turned out stale; its own exit status is what happened and takes priority over 97.',
  '    if ! kill -0 "$ENGINE_PID" 2>/dev/null; then',
  '      wait "$ENGINE_PID"',
  '      exit $?',
  '    fi',
  '    echo "atomic-watchdog: heartbeat unchanged for $UNCHANGED_POLLS/$THRESHOLD polls; stopping the engine" >&2',
  '    STOP_EXIT_CODE=$WATCHDOG_EXIT_STALE_HEARTBEAT',
  '    terminate_engine TERM',
  '    exit "$WATCHDOG_EXIT_STALE_HEARTBEAT"',
  '  fi',
  'done',
  '',
]

/** The watchdog entrypoint script text, ready to write to disk verbatim. */
export const WATCHDOG_SCRIPT: string = WATCHDOG_SCRIPT_LINES.join('\n')

/** The slice of a `fs.Stats` the no-op check needs — real `lstat` results satisfy this structurally. */
export interface WatchdogScriptLstat {
  isFile(): boolean
  mode: number
}

/** The slice of `node:fs/promises` `writeWatchdogScript` needs; tests pass an in-memory fake. */
export interface WatchdogScriptFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>
  writeFile(path: string, data: string, options?: { flag?: string; mode?: number }): Promise<void>
  chmod(path: string, mode: number): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** Cleans up an abandoned temp file after a failed `chmod`/`rename`; failures are swallowed. */
  rm(path: string): Promise<void>
  /**
   * `lstat`, not `stat`: a symlink at `path` must never read as "already current" through the file
   * it points at, or `writeWatchdogScript` would leave the symlink in place instead of replacing it
   * with a real, independently-owned regular file.
   */
  lstat(path: string): Promise<WatchdogScriptLstat>
  /** Used only to compare content once `lstat` has already confirmed a regular file at `0555`. */
  readFile(path: string, encoding: 'utf8'): Promise<string>
}

const NODE_FS: WatchdogScriptFs = { mkdir, writeFile, chmod, rename, rm, lstat, readFile }

/**
 * Whether `path` is already exactly what `writeWatchdogScript` would produce: a regular file (not a
 * symlink, not a directory or anything else), mode `0555` exactly, holding `WATCHDOG_SCRIPT`
 * verbatim. Content alone is not enough — a symlink that happens to point at identical content, or a
 * regular file with the right content but the wrong mode (e.g. still `0644` from some other writer),
 * both need to be replaced, not left alone.
 */
async function isCurrent(fs: WatchdogScriptFs, path: string, host: NodeJS.Platform): Promise<boolean> {
  const info = await fs.lstat(path).catch(() => undefined)
  if (info === undefined || !info.isFile()) return false
  // Windows keeps no POSIX mode: a 0555 file reads back as 0444, so the mode can never match there
  // and only the content says whether the script is current.
  if (host !== 'win32' && (info.mode & 0o777) !== WATCHDOG_SCRIPT_MODE) return false
  const content = await fs.readFile(path, 'utf8').catch(() => undefined)
  return content === WATCHDOG_SCRIPT
}

/**
 * Writes the watchdog entrypoint script to `path`, atomically and idempotently.
 *
 * A second call on a path that already holds the current script at the right mode (the common case:
 * the executor calls this on every container start, not only the first) is a no-op — worth checking,
 * since the file is `0555` and a second `writeFile` straight at that path would fail `EACCES`. When
 * it is not already current, the script is written to a temp file in the same directory (created
 * exclusively, so two writers never interleave into the same temp name), locked to `0555`, then
 * `rename`d over the target: a rename replaces whatever is at the destination — including a symlink
 * itself, not whatever it points at — in one atomic step, so a container that is mid-read of the old
 * script never sees a half-written file, and nothing already running with the old copy open loses it
 * out from under itself. If `chmod` or `rename` fails partway through, the abandoned temp file is
 * removed rather than left behind for the next call (or a directory listing) to trip over.
 *
 * The executor (task 2.8/2.12) bind-mounts the result into the model container read-only and passes
 * it as the container's entrypoint; this function has no opinion on where `path` lives — that is the
 * core's per-scope data directory, chosen by the caller.
 */
export async function writeWatchdogScript(
  path: string,
  fs: WatchdogScriptFs = NODE_FS,
  host: NodeJS.Platform = process.platform
): Promise<string> {
  if (await isCurrent(fs, path, host)) return path

  let tempPath: string | undefined
  try {
    const dir = dirname(path)
    await fs.mkdir(dir, { recursive: true })
    tempPath = join(dir, `.${basename(path)}.tmp-${randomBytes(6).toString('hex')}`)
    await fs.writeFile(tempPath, WATCHDOG_SCRIPT, { flag: 'wx' })
    await fs.chmod(tempPath, WATCHDOG_SCRIPT_MODE)
    // On Windows the 0555 of an earlier write is the read-only attribute, and NTFS refuses to rename
    // over a read-only file (EPERM): the second write after a restart failed. Made writable first, the
    // replacement stays one rename.
    if (host === 'win32') await fs.chmod(path, 0o644).catch(() => {})
    await fs.rename(tempPath, path)
  } catch (error) {
    if (tempPath !== undefined) await fs.rm(tempPath).catch(() => {})
    throw new AtomicCoreError(
      'IO_ERROR',
      'Cannot write the watchdog entrypoint script.',
      error instanceof Error ? error.message : String(error)
    )
  }
  return path
}
