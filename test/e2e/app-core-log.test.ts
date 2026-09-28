/**
 * The compiled `atomic-chat-app-core` keeps its own log: `<data>/atomic-core/logs/core.log`, appended
 * across restarts, with every core entry also on stderr under the same
 * `[YYYY-MM-DD][HH:MM:SS][core][<LEVEL>] ` header in UTC, and every line an engine prints in the file
 * under `engine:<provider>/<model>`. A log folder it cannot write costs the file, never the core. The
 * CLI's `atomic-chat-core daemon` writes no such file and keeps its `[level] message` stderr.
 *
 * No imports from `src/`.
 */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { APP_BIN, BIN, CORE_VERSION } = core

/** The header of every entry the core writes itself, on stderr and in `core.log`. */
const HEADER = /^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[core\]\[(DEBUG|INFO|WARN|ERROR)\] /
/** The header of any entry in `core.log`, the engines' included: `[date][time][<target>][<LEVEL>] `. */
const ANY_HEADER = /^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[([^\]]+)\]\[(DEBUG|INFO|WARN|ERROR)\] /
/**
 * The app core runs 14 hours away from UTC, so a header written in local time is off by far more
 * than the two minutes {@link expectRecentUtc} allows, whatever zone the machine is in.
 */
const APP_ENV = { TZ: 'Pacific/Kiritimati' }
const MODEL = 'qwen3-8b'
const ENGINE_STDOUT = 'fake llama-server: this line went to stdout'
/** What the core warns when the backend manifest cannot be fetched (see {@link logAWarning}). */
const MANIFEST_WARNING = '[fetchRemoteBackends] All manifest fetch transports failed'

let dataFolder: string
const daemons: ChildProcess[] = []
/** Folders a case made read-only; they get their permissions back before the data folder goes. */
const lockedDirs: string[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-app-core-log-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  for (const dir of lockedDirs.splice(0)) await chmod(dir, 0o700)
  await rm(dataFolder, { recursive: true, force: true })
})

const logsDir = () => join(dataFolder, 'atomic-core', 'logs')
const coreLogPath = () => join(logsDir(), 'core.log')
const readCoreLog = () => readFileSync(coreLogPath(), 'utf8')
const linesOf = (text: string) => text.split(/\r?\n/).filter((line) => line !== '')
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

const startApp = () => core.startDaemon(dataFolder, daemons, [], APP_ENV, APP_BIN)

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

/**
 * Run the app core to its exit, for a start that is expected to fail. Should it print a ready line
 * after all, it is killed at once, so the case fails on its stdout instead of hanging.
 */
function runAppToExit(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(APP_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...APP_ENV },
  })
  daemons.push(child)
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
    if (stdout.includes('\n')) child.kill('SIGKILL')
  })
  child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
  return new Promise((resolve, reject) => {
    child.once('error', reject)
    // `close`, not `exit`: by then every byte of both pipes is in.
    child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** Stop a daemon the way the app does, and wait until it and its pipes are closed. */
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.kill('SIGTERM')
  await closed
}

/** Poll `read` until it returns something: output reaches a pipe or a file in its own time. */
async function eventually<T>(what: string, read: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** The header's date and time, read as UTC, are now give or take two minutes. */
function expectRecentUtc(line: string): void {
  const at = Date.parse(`${line.slice(1, 11)}T${line.slice(13, 21)}Z`)
  expect(Number.isNaN(at), line).toBe(false)
  expect(Math.abs(Date.now() - at), line).toBeLessThan(2 * 60_000)
}

interface Entry {
  target: string
  level: string
  /** The entry without its header: the first line's message and the lines that follow it verbatim. */
  body: string
}

/** A line with a header starts an entry; the lines after it without one continue that entry. */
function entriesOf(text: string): Entry[] {
  const entries: Entry[] = []
  for (const line of linesOf(text)) {
    const head = ANY_HEADER.exec(line)
    if (head) {
      entries.push({ target: head[1] as string, level: head[2] as string, body: line.slice(head[0].length) })
      continue
    }
    const last = entries.at(-1)
    if (!last) throw new Error(`the first line has no header: ${line}`)
    last.body += `\n${line}`
  }
  return entries
}

/** A manifest behind a proxy that refuses connections is logged as a warning (as in detached-logging). */
async function logAWarning(ready: ReadyLine, stderr: () => string): Promise<void> {
  const catalog = await control(ready, '/backends/llamacpp-upstream/catalog', {
    method: 'POST',
    body: JSON.stringify({ force: true, proxy: { url: 'http://127.0.0.1:1', ignore_ssl: true } }),
  })
  expect(catalog.status, await catalog.clone().text()).toBe(200)
  await eventually('the manifest warning on stderr', () =>
    stderr().includes(MANIFEST_WARNING) ? true : undefined
  )
}

describe.skipIf(!existsSync(APP_BIN))('the app core log', () => {
  it('creates <data>/atomic-core/logs/core.log and starts it with the version', async () => {
    expect(existsSync(logsDir())).toBe(false)
    const { ready } = await startApp()

    const first = linesOf(readCoreLog())[0] ?? ''
    expect(first).toMatch(HEADER)
    expect(HEADER.exec(first)?.[1]).toBe('INFO')
    expect(first.replace(HEADER, '')).toBe(
      `atomic-chat-app-core ${CORE_VERSION} starting (pid ${ready.pid}, ${process.platform}/${process.arch})`
    )
    expectRecentUtc(first)
  })

  it('appends to core.log across a restart instead of truncating it', async () => {
    const firstRun = await startApp()
    await stop(firstRun.child)
    const before = readCoreLog()
    const secondRun = await startApp()
    const after = readCoreLog()

    expect(after.slice(0, before.length)).toBe(before)
    expect(after.length).toBeGreaterThan(before.length)
    const started = linesOf(after)
      .map((line) => / atomic-chat-app-core \S+ starting \(pid (\d+),/.exec(line)?.[1])
      .filter((pid) => pid !== undefined)
      .map(Number)
    expect(started).toEqual([firstRun.ready.pid, secondRun.ready.pid])
  })

  it('exits on a busy --control-port with the reason as an ERROR entry in core.log and on stderr', async () => {
    const holder = createServer()
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve))
    try {
      const port = (holder.address() as AddressInfo).port
      const run = await runAppToExit(['daemon', '--data-folder', dataFolder, '--control-port', String(port)])

      expect(run.code, run.stderr).toBe(1)
      expect(run.stdout, 'a core that did not start prints no handshake').toBe('')
      const logged = entriesOf(readCoreLog()).filter((entry) => entry.level === 'ERROR')
      expect(logged).toHaveLength(1)
      expect(logged[0]).toMatchObject({ target: 'core', body: expect.stringContaining('EADDRINUSE') })

      // The same reason, whole, on stderr, where every entry is the core's own.
      const printed = entriesOf(run.stderr)
      expect(printed.map((entry) => entry.target)).toEqual(printed.map(() => 'core'))
      expect(printed.filter((entry) => entry.level === 'ERROR').map((entry) => entry.body)).toEqual(
        logged.map((entry) => entry.body)
      )
      const errorLine = linesOf(run.stderr).find((line) => line.includes('[core][ERROR] ')) ?? ''
      expect(errorLine).toMatch(HEADER)
      expectRecentUtc(errorLine)
    } finally {
      await new Promise((resolve) => holder.close(resolve))
    }
  })

  it('heads every stderr line with [YYYY-MM-DD][HH:MM:SS][core][<LEVEL>] in UTC', async () => {
    const { ready, child, stderr } = await startApp()
    await logAWarning(ready, stderr)
    await stop(child)

    // Nothing this run logs spans lines, so every line of stderr starts an entry.
    const lines = linesOf(stderr())
    expect(lines.length).toBeGreaterThanOrEqual(3)
    for (const line of lines) {
      expect(line).toMatch(HEADER)
      expectRecentUtc(line)
    }
    const levels = new Set(lines.map((line) => HEADER.exec(line)?.[1]))
    expect([...levels]).toEqual(expect.arrayContaining(['INFO', 'WARN']))
  })

  // Windows has no POSIX modes to take away, and root writes into the folder regardless.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'keeps serving and writing stderr when the logs folder is not writable',
    async () => {
      await mkdir(logsDir(), { recursive: true })
      await chmod(logsDir(), 0o500)
      lockedDirs.push(logsDir())

      const { ready, stderr } = await startApp()
      expect((await control(ready, '/health')).status).toBe(200)
      await logAWarning(ready, stderr)

      const lines = linesOf(stderr())
      for (const line of lines) expect(line).toMatch(HEADER)
      const disabled = lines.findIndex((line) => line.includes('[core][WARN] log file disabled: '))
      expect(disabled, stderr()).toBeGreaterThanOrEqual(0)
      expect(lines[disabled]).toContain('EACCES')
      // The core's entries go on after it: the start entry, and the warning logged while serving.
      const later = lines.slice(disabled + 1)
      expect(later).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`[core][INFO] atomic-chat-app-core ${CORE_VERSION} starting`),
          expect.stringContaining(`[core][WARN] ${MANIFEST_WARNING}`),
        ])
      )
      expect(existsSync(coreLogPath())).toBe(false)
    }
  )

  it.skipIf(!existsSync(BIN))(
    'leaves the CLI daemon without core.log and with its [level] message stderr',
    async () => {
      const { ready, child, stderr } = await core.startDaemon(dataFolder, daemons, [], {}, BIN)
      await logAWarning(ready, stderr)
      await stop(child)

      const lines = linesOf(stderr())
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringMatching(new RegExp(`^\\[warn\\] ${escapeRe(MANIFEST_WARNING)}`)),
        ])
      )
      for (const line of lines) {
        expect(line).toMatch(/^\[(debug|info|warn|error)\] /)
        expect(line).not.toMatch(ANY_HEADER)
      }
      expect(existsSync(coreLogPath())).toBe(false)
    }
  )

  // The fake backend is a shell script.
  it.skipIf(process.platform === 'win32')(
    "logs the engine start line and the fake llama-server's stdout and stderr to core.log",
    async () => {
      await core.writeModel(dataFolder, MODEL)
      await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_STDOUT: ENGINE_STDOUT }, { provider: 'llamacpp' })
      const { ready, stderr } = await startApp()
      // As in load-errors: the fork's only Linux arm64 build is CUDA 13, which the core never picks
      // by itself there, so the pack is named.
      if (process.platform === 'linux' && process.arch === 'arm64') {
        const chosen = await control(ready, '/settings/llamacpp', {
          method: 'PATCH',
          body: JSON.stringify({ values: { version_backend: `b10018-1.3.0/${core.HOST_BACKEND}` } }),
        })
        expect(chosen.status, await chosen.clone().text()).toBe(200)
      }

      const loaded = await control(ready, `/models/llamacpp/${MODEL}/load`, { method: 'POST', body: '{}' })
      expect(loaded.status, await loaded.clone().text()).toBe(200)

      const engine = `engine:llamacpp/${MODEL}`
      const entries = await eventually('engine stdout and stderr in core.log', () => {
        const all = entriesOf(readCoreLog())
        const streams = all
          .filter((entry) => entry.target === engine)
          .map((entry) => entry.body.split(' ')[0])
        return streams.includes('[stdout]') && streams.includes('[stderr]') ? all : undefined
      })

      const startIndex = entries.findIndex(
        (entry) =>
          entry.target === 'core' && entry.body.startsWith(`starting llama-server for llamacpp/${MODEL}: `)
      )
      expect(startIndex, readCoreLog()).toBeGreaterThanOrEqual(0)
      expect(entries[startIndex]?.level).toBe('INFO')
      expect(entries[startIndex]?.body).toContain('--port ')

      const ofEngine = entries.filter((entry) => entry.target === engine)
      for (const entry of ofEngine) {
        expect(entry.level).toBe('INFO')
        expect(entry.body).toMatch(/^\[(stdout|stderr)\] /)
      }
      expect(ofEngine.map((entry) => entry.body)).toEqual(
        expect.arrayContaining([
          `[stdout] ${ENGINE_STDOUT}`,
          '[stderr] build: 6325 (fake) with cc (GCC) 13.2.0 for x86_64-linux-gnu',
          expect.stringMatching(/^\[stderr\] main: server is listening on /),
        ])
      )
      // The start line comes before anything the engine printed.
      expect(startIndex).toBeLessThan(entries.findIndex((entry) => entry.target === engine))

      // The start line is the core's own entry, so it is on stderr too; the engine's output is not.
      expect(stderr()).toContain(`[core][INFO] starting llama-server for llamacpp/${MODEL}: `)
      expect(stderr()).not.toContain(`[${engine}]`)
      expect(stderr()).not.toContain(ENGINE_STDOUT)
    }
  )
})
