/**
 * `<dir>/<stem>.log`: a synchronously-written, rotating log file. Internal to the core host layer —
 * not exported from `src/host/index.ts` or the package. Used for `core.log` (task 3.1 wires the
 * daemon's own logger and stderr into it); `<stem>` is parameterised so the same code could serve
 * another rotating file later.
 *
 * `formatLogLine` is the single place that builds the `[YYYY-MM-DD][HH:MM:SS][target][LEVEL]`
 * header (design D3): both this file's entries and every stderr line the core writes go through it,
 * so a person reading either sees the same format.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

/** The size at which `core.log` (and `app.log`) rotate, matching tauri-plugin-log. */
export const MAX_LOG_BYTES = 10 * 1024 * 1024
/** How many rotated `<stem>_*.log` archives are kept; the oldest beyond this is deleted. */
export const MAX_LOG_ARCHIVES = 4

/**
 * Builds one log entry: UTC, to the second, regardless of the process timezone. A multi-line
 * `message` carries the header on its first line only; the rest is written verbatim. The entry
 * always ends with exactly one trailing `\n`.
 */
export function formatLogLine(date: Date, target: string, level: LogLevel, message: string): string {
  const iso = date.toISOString()
  const day = iso.slice(0, 10)
  const time = iso.slice(11, 19)
  return `[${day}][${time}][${target}][${level}] ${message}\n`
}

/** `YYYY-MM-DD_HH-MM-SS`, UTC: the timestamp half of an archive's `<stem>_<...>.log` name. */
function archiveTimestamp(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 10)}_${iso.slice(11, 19).replace(/:/g, '-')}`
}

const ARCHIVE_NAME_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/

/**
 * The subset of `node:fs`'s synchronous API the writer needs, injected so tests can simulate a
 * broken disk without touching real IO error conditions.
 */
export interface LogFileFs {
  mkdirSync(path: string, options: { recursive: true }): void
  existsSync(path: string): boolean
  statSync(path: string): { size: number }
  openSync(path: string, flags: string): number
  writeSync(fd: number, data: string): number
  closeSync(fd: number): void
  renameSync(from: string, to: string): void
  unlinkSync(path: string): void
  readdirSync(path: string): string[]
}

const realFs: LogFileFs = {
  mkdirSync,
  existsSync,
  statSync,
  openSync,
  writeSync,
  closeSync,
  renameSync,
  unlinkSync,
  readdirSync,
}

export interface LogFileOptions {
  /** Clock injected for tests; defaults to the real time. */
  now?: () => Date
  /** Filesystem injected for tests; defaults to real `node:fs`. */
  fs?: LogFileFs
  /** Where the single "log file disabled" warning goes; defaults to `process.stderr`. */
  stderr?: (text: string) => void
  /** Size at which the file rotates; defaults to {@link MAX_LOG_BYTES}. Tests may lower it. */
  maxBytes?: number
  /** Archives kept after rotation; defaults to {@link MAX_LOG_ARCHIVES}. Tests may lower it. */
  maxArchives?: number
}

export interface LogFile {
  write(target: string, level: LogLevel, message: string): void
  close(): void
}

/**
 * Opens `<dir>/<stem>.log` for append, creating `dir` if needed, and returns a writer that rotates
 * the file once an incoming entry would push it past `maxBytes` (default 10 MiB), keeping
 * `maxArchives` (default 4) archives named `<stem>_YYYY-MM-DD_HH-MM-SS.log`.
 *
 * Never throws. An open or write failure — or a rotation failure that leaves no writable file open
 * — writes one `WARN` line built by {@link formatLogLine} to `stderr` and disables the writer for
 * good: every `write`/`close` call afterwards is a silent no-op. A rotation failure that still
 * leaves the *current* file writable is not one of these; see {@link rotate}.
 */
export function openLogFile(dir: string, stem: string, options: LogFileOptions = {}): LogFile {
  const now = options.now ?? (() => new Date())
  const fs = options.fs ?? realFs
  const stderr = options.stderr ?? ((text: string) => void process.stderr.write(text))
  const maxBytes = options.maxBytes ?? MAX_LOG_BYTES
  const maxArchives = options.maxArchives ?? MAX_LOG_ARCHIVES
  const path = join(dir, `${stem}.log`)

  let fd: number | undefined
  let size = 0
  let disabled = false

  /** Fires the one-time warning and turns every later call into a no-op. Never throws. */
  function disable(reason: string): void {
    if (disabled) return
    disabled = true
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch {
        // already broken; nothing more to do
      }
      fd = undefined
    }
    try {
      stderr(formatLogLine(now(), 'core', 'WARN', `log file disabled: ${reason}`))
    } catch {
      // stderr itself is best-effort
    }
  }

  try {
    fs.mkdirSync(dir, { recursive: true })
    fd = fs.openSync(path, 'a')
    size = fs.statSync(path).size
  } catch (error) {
    disable((error as Error).message)
  }

  function archivePath(date: Date): string {
    return join(dir, `${stem}_${archiveTimestamp(date)}.log`)
  }

  function pruneArchives(): void {
    const prefix = `${stem}_`
    const archives = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && ARCHIVE_NAME_RE.test(name.slice(prefix.length)))
      .sort()
      .reverse() // `<stem>_YYYY-MM-DD_HH-MM-SS.log` sorts lexicographically newest-first this way.
    for (const name of archives.slice(maxArchives)) fs.unlinkSync(join(dir, name))
  }

  /**
   * Closes the current descriptor, renames it to an archive name, and opens a fresh `<stem>.log`.
   * Order matters: the descriptor is closed *before* the rename (a file open on Windows cannot be
   * renamed by the process holding it), per design D4.
   *
   * Returns whether a writable file is open afterwards. A rename failure alone is not fatal — it
   * leaves the active file in place under its old name, so this falls back to reopening *that*
   * file and retries rotation on the next write. Only a failure that leaves nothing open (the
   * fallback reopen also fails, or the freshly-renamed-to file cannot be opened) is fatal; the
   * caller disables the writer for that.
   */
  function rotate(): boolean {
    const current = fd
    if (current === undefined) return false
    fs.closeSync(current)
    fd = undefined

    const target = archivePath(now())
    try {
      if (fs.existsSync(target)) fs.renameSync(target, `${target}.bak`)
      fs.renameSync(path, target)
    } catch {
      try {
        fd = fs.openSync(path, 'a')
        size = fs.statSync(path).size
        return true
      } catch {
        return false
      }
    }

    try {
      fd = fs.openSync(path, 'a')
      size = 0
    } catch {
      return false
    }
    try {
      pruneArchives()
    } catch {
      // Cleanup only — rotation itself already succeeded.
    }
    return true
  }

  return {
    write(target, level, message) {
      if (disabled) return
      const entry = formatLogLine(now(), target, level, message)
      const bytes = Buffer.byteLength(entry, 'utf8')
      if (size > 0 && size + bytes > maxBytes && !rotate()) {
        disable('rotation left no writable file')
        return
      }
      const openFd = fd
      if (openFd === undefined) {
        // Unreachable: `disabled` (checked above) is the only state with no open `fd`, and a
        // `rotate()` that returns `true` always leaves one open. Kept as a safety net, not a path
        // any test drives.
        disable('no open file')
        return
      }
      try {
        fs.writeSync(openFd, entry)
        size += bytes
      } catch (error) {
        disable((error as Error).message)
      }
    },
    close() {
      if (disabled || fd === undefined) return
      try {
        fs.closeSync(fd)
      } catch {
        // best effort — the descriptor may already be unusable
      }
      fd = undefined
      disabled = true
    },
  }
}
