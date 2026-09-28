import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatLogLine, MAX_LOG_ARCHIVES, MAX_LOG_BYTES, openLogFile } from './log-file.js'
import type { LogFileFs } from './log-file.js'

/** Wraps the real `node:fs` sync API so a single test can override just one method. */
function realFsWith(overrides: Partial<LogFileFs>): LogFileFs {
  return {
    mkdirSync,
    existsSync,
    statSync,
    openSync,
    writeSync,
    closeSync,
    renameSync,
    unlinkSync,
    readdirSync,
    ...overrides,
  }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-log-file-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('formatLogLine', () => {
  it('forms the header in UTC regardless of the process timezone', () => {
    const originalTz = process.env['TZ']
    process.env['TZ'] = 'Pacific/Kiritimati' // UTC+14: local date would differ from UTC's
    try {
      const date = new Date('2026-09-28T12:00:05.500Z')
      expect(formatLogLine(date, 'core', 'WARN', 'backend catalog is stale')).toBe(
        '[2026-09-28][12:00:05][core][WARN] backend catalog is stale\n'
      )
    } finally {
      if (originalTz === undefined) delete process.env['TZ']
      else process.env['TZ'] = originalTz
    }
  })

  it('keeps the header on the first line only of a multi-line message', () => {
    const date = new Date('2026-09-28T00:00:00Z')
    const message = 'first line\nsecond line\nthird line'
    expect(formatLogLine(date, 'core', 'ERROR', message)).toBe(
      '[2026-09-28][00:00:00][core][ERROR] first line\nsecond line\nthird line\n'
    )
  })

  // The app splits records on this header (design D7 of `add-unified-logs`); model ids are folder
  // names with no character rules, so a target must never break it.
  const STRICT_HEADER =
    /^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[[^\]]*\]\[(TRACE|DEBUG|INFO|WARN|ERROR)\] /
  it.each([
    ['a closing bracket', 'engine:llamacpp/model]', 'engine:llamacpp/model_'],
    ['both brackets', 'engine:llamacpp/model [Q4]', 'engine:llamacpp/model _Q4_'],
    ['a newline and a carriage return', 'engine:mlx/a\nb\rc', 'engine:mlx/a_b_c'],
    ['a tab, NUL, U+001F and DEL', 'engine:mlx/\t\u0000\u001f\u007f', 'engine:mlx/____'],
    [
      'nothing to replace',
      'engine:llamacpp-upstream/Qwen3 8B (é, модель)',
      'engine:llamacpp-upstream/Qwen3 8B (é, модель)',
    ],
  ])('replaces [, ] and control characters in the target with _: %s', (_case, target, expected) => {
    const line = formatLogLine(new Date('2026-09-28T00:00:00Z'), target, 'INFO', '[stdout] hello')
    expect(line).toBe(`[2026-09-28][00:00:00][${expected}][INFO] [stdout] hello\n`)
    expect(line).toMatch(STRICT_HEADER)
  })
})

describe('openLogFile', () => {
  it('creates the directory and writes a formatted line to <stem>.log', () => {
    const path = join(dir, 'nested', 'core.log')
    const log = openLogFile(join(dir, 'nested'), 'core', { now: () => new Date('2026-09-28T12:00:05Z') })
    log.write('core', 'INFO', 'hello')
    log.close()
    expect(readFileSync(path, 'utf8')).toBe('[2026-09-28][12:00:05][core][INFO] hello\n')
  })

  it('appends after reopening the same file', () => {
    const path = join(dir, 'core.log')
    const first = openLogFile(dir, 'core', { now: () => new Date('2026-09-28T12:00:05Z') })
    first.write('core', 'INFO', 'first entry')
    first.close()

    const second = openLogFile(dir, 'core', { now: () => new Date('2026-09-28T12:00:06Z') })
    second.write('core', 'INFO', 'second entry')
    second.close()

    expect(readFileSync(path, 'utf8')).toBe(
      '[2026-09-28][12:00:05][core][INFO] first entry\n[2026-09-28][12:00:06][core][INFO] second entry\n'
    )
  })
})

describe('rotation', () => {
  it('defaults to a 10 MiB limit and 4 kept archives', () => {
    expect(MAX_LOG_BYTES).toBe(10 * 1024 * 1024)
    expect(MAX_LOG_ARCHIVES).toBe(4)
  })

  it('rotates once the next entry would push the file past the byte limit', () => {
    // A fixed clock, not an incrementing one: which of `write`'s internal steps happen to call
    // `now()` is an implementation detail, so every entry and the archive name share one instant.
    const now = () => new Date('2026-09-28T12:00:00Z')
    const log = openLogFile(dir, 'core', { now, maxBytes: 80 })
    log.write('core', 'INFO', 'a'.repeat(40)) // one entry is 76 bytes; well under the limit alone
    log.write('core', 'INFO', 'b'.repeat(40)) // current size (76) + this entry (76) > 80: rotates first
    log.close()

    expect(readdirSync(dir).sort()).toEqual(['core.log', 'core_2026-09-28_12-00-00.log'])
    expect(readFileSync(join(dir, 'core_2026-09-28_12-00-00.log'), 'utf8')).toBe(
      formatLogLine(new Date('2026-09-28T12:00:00Z'), 'core', 'INFO', 'a'.repeat(40))
    )
    expect(readFileSync(join(dir, 'core.log'), 'utf8')).toBe(
      formatLogLine(new Date('2026-09-28T12:00:00Z'), 'core', 'INFO', 'b'.repeat(40))
    )
  })

  it('keeps at most 4 archives, deleting the oldest first', () => {
    const preexisting = [
      'core_2026-09-24_00-00-00.log',
      'core_2026-09-25_00-00-00.log',
      'core_2026-09-26_00-00-00.log',
      'core_2026-09-27_00-00-00.log',
    ]
    for (const name of preexisting) writeFileSync(join(dir, name), 'an earlier archive\n')
    writeFileSync(join(dir, 'core.log'), 'x'.repeat(80)) // already at the limit

    const now = () => new Date('2026-09-28T00:00:00Z')
    const log = openLogFile(dir, 'core', { now, maxBytes: 80 })
    log.write('core', 'INFO', 'triggers rotation') // any entry now pushes the file over the limit
    log.close()

    expect(
      readdirSync(dir)
        .filter((name) => name !== 'core.log')
        .sort()
    ).toEqual([
      'core_2026-09-25_00-00-00.log',
      'core_2026-09-26_00-00-00.log',
      'core_2026-09-27_00-00-00.log',
      'core_2026-09-28_00-00-00.log',
    ])
  })

  it('a failed rename does not stop writing, and rotation is retried on the next write', () => {
    let renameCalls = 0
    const fs = realFsWith({
      renameSync: (from, to) => {
        renameCalls++
        if (renameCalls === 1) throw new Error('simulated disk error')
        renameSync(from, to)
      },
    })
    const now = () => new Date('2026-09-28T00:00:00Z')
    const log = openLogFile(dir, 'core', { now, maxBytes: 80, fs })

    log.write('core', 'INFO', 'a'.repeat(40)) // 76 bytes; under the limit alone, no rotation yet
    expect(() => log.write('core', 'INFO', 'b'.repeat(40))).not.toThrow() // rotation attempted, rename throws
    // the rename failed: still one file, and both entries landed in it
    expect(readdirSync(dir)).toEqual(['core.log'])
    expect(readFileSync(join(dir, 'core.log'), 'utf8')).toBe(
      formatLogLine(now(), 'core', 'INFO', 'a'.repeat(40)) +
        formatLogLine(now(), 'core', 'INFO', 'b'.repeat(40))
    )

    expect(() => log.write('core', 'INFO', 'c'.repeat(5))).not.toThrow() // retried, and this time it succeeds
    log.close()

    expect(readdirSync(dir).sort()).toEqual(['core.log', 'core_2026-09-28_00-00-00.log'])
    expect(renameCalls).toBeGreaterThanOrEqual(2)
  })

  it('rotation succeeds even while another reader has the file open', () => {
    const now = () => new Date('2026-09-28T00:00:00Z')
    const log = openLogFile(dir, 'core', { now, maxBytes: 80 })
    log.write('core', 'INFO', 'a'.repeat(40))

    // e.g. a log viewer tailing the file while the core rotates it.
    const readerFd = openSync(join(dir, 'core.log'), 'r')
    try {
      expect(() => log.write('core', 'INFO', 'b'.repeat(40))).not.toThrow()
      log.close()

      const buffer = Buffer.alloc(200)
      const bytesRead = readSync(readerFd, buffer, 0, 200, 0)
      expect(buffer.subarray(0, bytesRead).toString('utf8')).toBe(
        formatLogLine(now(), 'core', 'INFO', 'a'.repeat(40))
      )
    } finally {
      closeSync(readerFd)
    }

    expect(readdirSync(dir).sort()).toEqual(['core.log', 'core_2026-09-28_00-00-00.log'])
  })
})

describe('failure isolation', () => {
  it('a rotation failure that leaves no writable file disables the log', () => {
    const warnings: string[] = []
    let openCalls = 0
    const fs = realFsWith({
      renameSync: () => {
        throw new Error('simulated rename failure')
      },
      openSync: (path, flags) => {
        openCalls++
        if (openCalls === 1) return openSync(path, flags) // the factory's own initial open succeeds
        throw new Error('simulated reopen failure') // every reopen after that — including the fallback — fails
      },
    })
    const now = () => new Date('2026-09-28T00:00:05Z')
    const log = openLogFile(dir, 'core', { now, maxBytes: 80, fs, stderr: (text) => warnings.push(text) })

    log.write('core', 'INFO', 'a'.repeat(40)) // under the limit alone, no rotation yet
    expect(() => log.write('core', 'INFO', 'b'.repeat(40))).not.toThrow() // rotation: rename fails, fallback reopen fails too

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^\[2026-09-28\]\[00:00:05\]\[core\]\[WARN\] log file disabled: .+\n$/)

    expect(() => log.write('core', 'INFO', 'later entry')).not.toThrow() // stays off, no second warning
    expect(warnings).toHaveLength(1)
  })

  it('a close that fails during rotation disables the log without throwing', () => {
    const warnings: string[] = []
    let closeCalls = 0
    const fs = realFsWith({
      closeSync: (fd) => {
        closeCalls++
        closeSync(fd) // the descriptor is gone, as close(2) leaves it even when it reports EIO
        throw new Error('EIO: i/o error, close')
      },
    })
    const now = () => new Date('2026-09-28T00:00:05Z')
    const log = openLogFile(dir, 'core', { now, maxBytes: 80, fs, stderr: (text) => warnings.push(text) })

    log.write('core', 'INFO', 'a'.repeat(40)) // under the limit alone, no rotation yet
    expect(() => log.write('core', 'INFO', 'b'.repeat(40))).not.toThrow() // rotation: the close throws

    expect(warnings).toEqual([
      formatLogLine(now(), 'core', 'WARN', 'log file disabled: EIO: i/o error, close'),
    ])

    // Stays off: no throw, no second warning, nothing more on disk, and the released descriptor
    // number (which the process may already have reused) is never closed a second time.
    expect(() => log.write('core', 'INFO', 'later entry')).not.toThrow()
    expect(() => log.close()).not.toThrow()
    expect(warnings).toHaveLength(1)
    expect(closeCalls).toBe(1)
    expect(readFileSync(join(dir, 'core.log'), 'utf8')).toBe(
      formatLogLine(now(), 'core', 'INFO', 'a'.repeat(40))
    )
  })

  it('an unwritable folder disables the log without throwing', () => {
    // A real chmod-restricted directory would also prove this, but POSIX permission bits do not
    // reliably block directory creation on Windows (this suite's CI includes windows-2022 and
    // windows-11-arm), so the failure is injected instead of relying on OS-specific enforcement.
    const fs = realFsWith({
      mkdirSync: () => {
        throw new Error('EACCES: permission denied, mkdir')
      },
    })
    const warnings: string[] = []
    const now = () => new Date('2026-09-28T12:00:05Z')
    let log: ReturnType<typeof openLogFile> | undefined
    expect(() => {
      log = openLogFile(join(dir, 'blocked'), 'core', { now, fs, stderr: (text) => warnings.push(text) })
    }).not.toThrow()
    expect(() => log?.write('core', 'INFO', 'hello')).not.toThrow()
    expect(() => log?.close()).not.toThrow()

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^\[2026-09-28\]\[12:00:05\]\[core\]\[WARN\] log file disabled: .+\n$/)
  })
})
