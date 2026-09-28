/**
 * The watchdog entrypoint for a `tensorrt-llm` model container (openspec change
 * `add-tensorrt-llm-linux`, task 2.9, spec `tensorrt-llm-runtime` ▸ "Watchdog гарантирует
 * освобождение GPU"). Docker gives it PID 1 in place of `trtllm-serve`: it starts the engine, then
 * polls a heartbeat file the core keeps touching (see `heartbeat.ts`) from outside the container.
 * If that file falls stale — the core crashed, was killed, or the host slept — the script kills the
 * engine and exits itself, so the GPU is freed even though nothing on the host asked for that on
 * purpose. The requirement is explicit that this cannot be turned off by a setting: there is no
 * config path that skips the poll loop, only the timing knobs below.
 *
 * The script is embedded as a plain POSIX `/bin/sh` string rather than loaded from a file at
 * runtime, because the core must stay runtime-agnostic (no `import.meta.url`-relative loading) and
 * because the container never gets write access to it — `writeWatchdogScript` below is the only way
 * it reaches disk, mode `0555`, for the executor (task 2.8/2.12) to bind-mount read-only next to the
 * model.
 *
 * Docker argv/mount wiring, the executor that invokes this, and the lifecycle that runs the
 * heartbeat ticker against a real container are out of scope here (tasks 2.8, 2.11, 2.12); this
 * module only provides the script text and the function that writes it to a given path.
 */

import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'

// ── Timing constants ─────────────────────────────────────────────────────────────────────────────
//
// Placeholders (design.md "Open Questions" ▸ "Точные значения heartbeat-интервала, лимита
// watchdog... измеряются в live-тесте core"): task 2.19 measures real values against real hardware
// and updates these. They are deliberately generous relative to a plausible heartbeat write cost so
// a slow disk does not trip the watchdog on its own. This is the one place all three live — the
// heartbeat ticker (`heartbeat.ts`) and the watchdog script agree with each other only because both
// read from here.

/** How often the core touches the heartbeat file. */
export const DEFAULT_HEARTBEAT_INTERVAL_SECS = 5
/** How long the heartbeat file may go untouched before the watchdog kills the engine. */
export const DEFAULT_WATCHDOG_STALE_LIMIT_SECS = 30
/** TERM→KILL grace the watchdog gives the engine once it has decided the heartbeat is stale. */
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

/** The script's own config was missing or malformed (missing env var, missing `--` separator). */
export const WATCHDOG_EXIT_CODE_CONFIG_ERROR = 96
/** The heartbeat file was stale (or missing) past the limit; the engine was killed. */
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
//  - `set -u` only, not `-e`: shells disagree on whether `set -e` fires when a command substitution
//    used in a plain assignment (`x=$(cmd)`) fails, so every failure this script cares about is
//    checked explicitly instead.
//  - mtime is read with `stat -c %Y` (GNU coreutils — the actual runtime is the NGC Ubuntu base
//    image) falling back to `stat -f %m` (BSD/macOS `stat`), so the exact same file also runs under
//    the `/bin/sh` on a macOS development machine, which is what the test suite for this script does
//    (no container involved).
//  - A missing heartbeat file counts as maximally stale rather than as "no data yet": the file is
//    created at startup if absent, so in normal operation this only fires if something removed it
//    mid-run, which is exactly the "assume the worst" case the watchdog exists for.
//  - "$@" is always quoted and only ever used to start a background process, never passed to `eval`
//    or a shell -c string, so nothing in the engine's own argv can be interpreted as shell syntax.
const WATCHDOG_SCRIPT_LINES: readonly string[] = [
  '#!/bin/sh',
  '# atomic-chat-core watchdog entrypoint (openspec change add-tensorrt-llm-linux, task 2.9).',
  '# Generated by src/runtime/container/watchdog.ts — do not edit the mounted copy by hand.',
  '#',
  '# Starts the engine command given after "--" in the background, then kills it and exits if the',
  '# heartbeat file the core touches from outside the container goes stale. Configuration is env',
  '# vars (see WATCHDOG_ENV_VARS in watchdog.ts); the script argv is reserved for the engine command.',
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
  '[ "${1:-}" = "--" ] || fail "expected -- before the engine command"',
  'shift',
  '',
  'HEARTBEAT_FILE=$ATOMIC_WATCHDOG_HEARTBEAT_FILE',
  'STALE_LIMIT_SECS=$ATOMIC_WATCHDOG_STALE_LIMIT_SECS',
  'POLL_INTERVAL_SECS=$ATOMIC_WATCHDOG_POLL_INTERVAL_SECS',
  'KILL_GRACE_SECS=$ATOMIC_WATCHDOG_KILL_GRACE_SECS',
  '',
  '# Give the engine a full stale-limit window before the first real heartbeat is required.',
  '[ -e "$HEARTBEAT_FILE" ] || : > "$HEARTBEAT_FILE" 2>/dev/null || true',
  '',
  '"$@" &',
  'ENGINE_PID=$!',
  '',
  'forward() {',
  '  kill -"$1" "$ENGINE_PID" 2>/dev/null || true',
  '  wait "$ENGINE_PID" 2>/dev/null',
  '  exit $?',
  '}',
  "trap 'forward TERM' TERM",
  "trap 'forward INT' INT",
  '',
  'heartbeat_mtime() {',
  '  m=$(stat -c %Y "$1" 2>/dev/null) && { echo "$m"; return 0; }',
  '  m=$(stat -f %m "$1" 2>/dev/null) && { echo "$m"; return 0; }',
  '  return 1',
  '}',
  '',
  'while true; do',
  '  if ! kill -0 "$ENGINE_PID" 2>/dev/null; then',
  '    wait "$ENGINE_PID"',
  '    exit $?',
  '  fi',
  '',
  '  mtime=$(heartbeat_mtime "$HEARTBEAT_FILE") || mtime=""',
  '  now=$(date +%s)',
  '  if [ -z "$mtime" ]; then',
  '    age=$STALE_LIMIT_SECS',
  '  else',
  '    age=$((now - mtime))',
  '  fi',
  '',
  '  if [ "$age" -ge "$STALE_LIMIT_SECS" ]; then',
  '    echo "atomic-watchdog: heartbeat stale (${age}s >= ${STALE_LIMIT_SECS}s); stopping the engine" >&2',
  '    kill -TERM "$ENGINE_PID" 2>/dev/null || true',
  '    deadline=$(( $(date +%s) + KILL_GRACE_SECS ))',
  '    while kill -0 "$ENGINE_PID" 2>/dev/null; do',
  '      if [ "$(date +%s)" -ge "$deadline" ]; then',
  '        kill -KILL "$ENGINE_PID" 2>/dev/null || true',
  '        break',
  '      fi',
  '      sleep 1',
  '    done',
  '    wait "$ENGINE_PID" 2>/dev/null',
  '    exit "$WATCHDOG_EXIT_STALE_HEARTBEAT"',
  '  fi',
  '',
  '  sleep "$POLL_INTERVAL_SECS"',
  'done',
  '',
]

/** The watchdog entrypoint script text, ready to write to disk verbatim. */
export const WATCHDOG_SCRIPT: string = WATCHDOG_SCRIPT_LINES.join('\n')

/** The slice of `node:fs/promises` `writeWatchdogScript` needs; tests pass an in-memory fake. */
export interface WatchdogScriptFs {
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>
  writeFile(path: string, data: string): Promise<void>
  chmod(path: string, mode: number): Promise<void>
}

const NODE_FS: WatchdogScriptFs = { mkdir, writeFile, chmod }

/**
 * Writes the watchdog entrypoint script to `path` (creating its parent directory if needed) and
 * makes it read-and-execute-only. The executor (task 2.8/2.12) bind-mounts the result into the
 * model container read-only and passes it as the container's entrypoint; this function has no
 * opinion on where `path` lives — that is the core's per-scope data directory, chosen by the caller.
 */
export async function writeWatchdogScript(path: string, fs: WatchdogScriptFs = NODE_FS): Promise<string> {
  try {
    await fs.mkdir(dirname(path), { recursive: true })
    await fs.writeFile(path, WATCHDOG_SCRIPT)
    await fs.chmod(path, WATCHDOG_SCRIPT_MODE)
  } catch (error) {
    throw new AtomicCoreError(
      'IO_ERROR',
      'Cannot write the watchdog entrypoint script.',
      error instanceof Error ? error.message : String(error)
    )
  }
  return path
}
