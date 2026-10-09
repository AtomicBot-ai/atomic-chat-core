/**
 * Two unit layers here: `writeWatchdogScript` against a fake filesystem (plus two real-path checks),
 * and `watchdogEnv`. The process-level tests of the script text itself — POSIX-only, since they spawn
 * `/bin/sh` for real against tiny Node "fake server" fixtures instead of a real `trtllm-serve` — are
 * split across the `watchdog.script-*.test.ts` files so vitest runs those real-time scenarios on
 * separate workers; they share `test/helpers/watchdog-harness.ts` (the container/Docker wiring that
 * would run the script for real is task 2.8/2.12's job, not this one's).
 */
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
import { describe, expect, it, vi } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  DEFAULT_WATCHDOG_KILL_GRACE_SECS,
  DEFAULT_WATCHDOG_POLL_INTERVAL_SECS,
  DEFAULT_WATCHDOG_STALE_LIMIT_SECS,
  WATCHDOG_ENV_VARS,
  WATCHDOG_SCRIPT,
  WATCHDOG_SCRIPT_MODE,
  watchdogEnv,
  writeWatchdogScript,
} from './watchdog.js'
import type { WatchdogScriptFs } from './watchdog.js'
import { skipTestOnWindows } from '../../../test/helpers/platform.js'
import {
  killEngineIfKnown,
  pidAlive,
  readPidFileTolerant,
  useTmpDir,
} from '../../../test/helpers/watchdog-harness.js'

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
  it('writes the script to a temp file in the same directory, chmods it, then renames it over the target', async (ctx) => {
    skipTestOnWindows(ctx, 'asserts POSIX paths and modes')
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

    // POSIX semantics on purpose, whatever the runner: Windows keeps no mode to re-secure.
    await writeWatchdogScript(path, fs, 'linux')

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
  it('on Windows, reads a script whose mode reads back as 0444 as current: no second write', async () => {
    const fs = fakeFs()
    await writeWatchdogScript('/data/watchdog.sh', fs, 'win32')
    const written = fs.entries['/data/watchdog.sh']
    if (written === undefined) throw new Error('expected the script to be written')
    written.mode = 0o444 // what Windows reports for the read-only 0555 file
    await writeWatchdogScript('/data/watchdog.sh', fs, 'win32')
    expect(fs.renameCalls).toHaveLength(1)
  })

  it('elsewhere, still rewrites a script whose mode is not 0555', async () => {
    const fs = fakeFs()
    await writeWatchdogScript('/data/watchdog.sh', fs, 'linux')
    const written = fs.entries['/data/watchdog.sh']
    if (written === undefined) throw new Error('expected the script to be written')
    written.mode = 0o444
    await writeWatchdogScript('/data/watchdog.sh', fs, 'linux')
    expect(fs.renameCalls).toHaveLength(2)
  })

  it('on Windows, makes a stale script writable before renaming over it (NTFS refuses a read-only target)', async () => {
    const fs = fakeFs()
    await writeWatchdogScript('/data/watchdog.sh', fs, 'win32')
    const written = fs.entries['/data/watchdog.sh']
    if (written === undefined) throw new Error('expected the script to be written')
    written.content = 'an older script'
    await writeWatchdogScript('/data/watchdog.sh', fs, 'win32')
    expect(fs.chmodCalls.at(-1)).toEqual({ path: '/data/watchdog.sh', mode: 0o644 })
    expect(fs.renameCalls).toHaveLength(2)
    expect(fs.entries['/data/watchdog.sh']?.mode).toBe(0o555)
  })

  it('can be called twice in a row on the same real path without EACCES', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-core-watchdog-write-'))
    try {
      const path = join(dir, 'atomic-watchdog-entrypoint.sh')

      await writeWatchdogScript(path)
      await expect(writeWatchdogScript(path)).resolves.toBe(path)

      expect(await readFile(path, 'utf8')).toBe(WATCHDOG_SCRIPT)
      const mode = (await stat(path)).mode & 0o777
      // Windows keeps only the read-only attribute of 0555: no write bit is what it can show.
      if (process.platform === 'win32') expect(mode & 0o222).toBe(0)
      else expect(mode).toBe(WATCHDOG_SCRIPT_MODE)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  // Item 6 (findings-2.9-r2), on a real filesystem: a symlink to a file with identical content must
  // be replaced with a real regular file, not left as a symlink.
  it('replaces a real symlink pointing at identical content', async (ctx) => {
    skipTestOnWindows(ctx, 'asserts the 0555 mode, which Windows does not keep')
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

// Item 1 (findings-2.9-r3, Important): deterministic, not a real writeFileSync-race reproduction —
// forcing the actual truncate→write window is inherently racy, and if the guard genuinely regressed,
// forcing it for real would call `process.kill(0, 'SIGKILL')` against this very test process's own
// process group (exactly the bug being tested for). These pin the parsing/guarding logic directly
// against a pid file holding the exact bogus content that race window produces, with no race needed:
// `Number('')` and `Number('0')` are both `0`, and POSIX defines `kill(0, sig)` as "every process in
// the caller's own process group", not "no such process".
describe('pid-file safety (findings-2.9-r3 item 1)', () => {
  // The harness's pid guards are what every process-level watchdog test relies on to never signal
  // the wrong process, so they are pinned here, next to the unit tests, not in the slow script files.
  const tmpDir = useTmpDir()

  it('never calls process.kill with pid 0 or a negative pid, however the pid file reads', async () => {
    const dir = tmpDir()
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
    const dir = tmpDir()
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(pidFile, '')
    setTimeout(() => {
      fsWriteFile(pidFile, '4242').catch(() => {})
    }, 150)

    const pid = await readPidFileTolerant(pidFile, 2_000)

    expect(pid).toBe(4242)
  })

  it('readPidFileTolerant returns undefined, not 0, if only an invalid pid ever appears', async () => {
    const dir = tmpDir()
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(pidFile, '0')

    const pid = await readPidFileTolerant(pidFile, 300)

    expect(pid).toBeUndefined()
  })
})
