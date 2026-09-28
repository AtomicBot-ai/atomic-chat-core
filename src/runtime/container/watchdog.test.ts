/**
 * Two layers: a unit test of `writeWatchdogScript` against a fake filesystem, and — POSIX-only,
 * since it spawns `/bin/sh` for real — a process-level test of the script text itself, against tiny
 * Node "fake server" fixtures instead of a real `trtllm-serve` (the container/Docker wiring that
 * would run it for real is task 2.8/2.12's job, not this one's).
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile as fsWriteFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AtomicCoreError } from '../../contracts/index.js'
import {
  WATCHDOG_ENV_VARS,
  WATCHDOG_EXIT_CODE_STALE_HEARTBEAT,
  WATCHDOG_SCRIPT,
  WATCHDOG_SCRIPT_MODE,
  writeWatchdogScript,
} from './watchdog.js'
import type { WatchdogScriptFs } from './watchdog.js'

// ── writeWatchdogScript (fs injected) ────────────────────────────────────────────────────────────

function fakeFs(): WatchdogScriptFs & {
  mkdirCalls: Array<{ path: string; options: { recursive: boolean } }>
  written: Record<string, string>
  chmodCalls: Array<{ path: string; mode: number }>
} {
  const mkdirCalls: Array<{ path: string; options: { recursive: boolean } }> = []
  const written: Record<string, string> = {}
  const chmodCalls: Array<{ path: string; mode: number }> = []
  return {
    mkdirCalls,
    written,
    chmodCalls,
    async mkdir(path, options) {
      mkdirCalls.push({ path, options })
      return undefined
    },
    async writeFile(path, data) {
      written[path] = data
    },
    async chmod(path, mode) {
      chmodCalls.push({ path, mode })
    },
  }
}

describe('writeWatchdogScript', () => {
  it('creates the parent directory, writes the script verbatim, and locks it to read+execute only', async () => {
    const fs = fakeFs()
    const path = '/data/atomic-core/managed-runtimes/watchdog/atomic-watchdog-entrypoint.sh'

    const result = await writeWatchdogScript(path, fs)

    expect(result).toBe(path)
    expect(fs.mkdirCalls).toEqual([
      { path: '/data/atomic-core/managed-runtimes/watchdog', options: { recursive: true } },
    ])
    expect(fs.written[path]).toBe(WATCHDOG_SCRIPT)
    expect(fs.chmodCalls).toEqual([{ path, mode: WATCHDOG_SCRIPT_MODE }])
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

describe.skipIf(!posix)('the watchdog entrypoint script', () => {
  it('lets the engine keep running while the heartbeat stays fresh', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    const { child, done } = runWatchdog(scriptPath, [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile], {
      [WATCHDOG_ENV_VARS.heartbeatFile]: heartbeatPath,
      [WATCHDOG_ENV_VARS.staleLimitSecs]: '2',
      [WATCHDOG_ENV_VARS.pollIntervalSecs]: '1',
      [WATCHDOG_ENV_VARS.killGraceSecs]: '1',
    })

    // A ticker keeping the heartbeat fresh for well past the stale limit.
    const tick = setInterval(() => {
      fsWriteFile(heartbeatPath, '').catch(() => {})
    }, 300)
    try {
      await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
      await new Promise((r) => setTimeout(r, 3_000))
      expect(child.exitCode).toBeNull()
      const pid = Number((await readFile(pidFile, 'utf8')).trim())
      expect(await pidAlive(pid)).toBe(true)
    } finally {
      clearInterval(tick)
      child.kill('SIGKILL')
      await done.catch(() => undefined)
    }
  }, 10_000)

  it('kills the engine and exits with the stale-heartbeat code once the heartbeat goes stale', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    const pidFile = join(dir, 'engine.pid')
    await fsWriteFile(heartbeatPath, '')

    const { done } = runWatchdog(scriptPath, [process.execPath, '-e', LONG_LIVED_ENGINE, pidFile], {
      [WATCHDOG_ENV_VARS.heartbeatFile]: heartbeatPath,
      [WATCHDOG_ENV_VARS.staleLimitSecs]: '1',
      [WATCHDOG_ENV_VARS.pollIntervalSecs]: '1',
      [WATCHDOG_ENV_VARS.killGraceSecs]: '1',
    })
    // Heartbeat is never touched again after the script's own initial creation: it goes stale.

    await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
    const pid = Number((await readFile(pidFile, 'utf8')).trim())

    // limit(1s) + poll(1s) + grace(1s) + slack.
    const result = await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('watchdog did not exit in time')), 8_000)
      ),
    ])

    expect(result.code).toBe(WATCHDOG_EXIT_CODE_STALE_HEARTBEAT)
    await waitFor(async () => !(await pidAlive(pid)), 2_000)
  }, 12_000)

  it('propagates the engine exit status when the engine exits on its own', async () => {
    const scriptPath = join(dir, 'entrypoint.sh')
    await writeWatchdogScript(scriptPath)
    const heartbeatPath = join(dir, 'heartbeat')
    await fsWriteFile(heartbeatPath, '')

    const { done } = runWatchdog(scriptPath, [process.execPath, '-e', 'process.exit(5)'], {
      [WATCHDOG_ENV_VARS.heartbeatFile]: heartbeatPath,
      [WATCHDOG_ENV_VARS.staleLimitSecs]: '30',
      [WATCHDOG_ENV_VARS.pollIntervalSecs]: '1',
      [WATCHDOG_ENV_VARS.killGraceSecs]: '5',
    })

    const result = await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('watchdog did not exit in time')), 5_000)
      ),
    ])
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
      {
        [WATCHDOG_ENV_VARS.heartbeatFile]: heartbeatPath,
        [WATCHDOG_ENV_VARS.staleLimitSecs]: '30',
        [WATCHDOG_ENV_VARS.pollIntervalSecs]: '1',
        [WATCHDOG_ENV_VARS.killGraceSecs]: '5',
      }
    )

    await waitFor(async () => (await stat(pidFile).catch(() => undefined)) !== undefined, 2_000)
    child.kill('SIGTERM')

    const result = await Promise.race([
      done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('watchdog did not exit in time')), 5_000)
      ),
    ])

    expect(result.code).toBe(42)
    expect(await readFile(markerFile, 'utf8')).toBe('term')
  }, 8_000)
})
