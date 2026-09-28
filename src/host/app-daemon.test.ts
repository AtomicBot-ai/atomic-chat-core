import { EventEmitter } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { recordingIo } from '../cli/index.js'
import type { AtomicCoreOptions } from '../core/index.js'
import { createCoreReporter } from '../telemetry/index.js'
import type { CoreReporterInput } from '../telemetry/index.js'
import { CORE_VERSION } from '../version.js'
import { runAppDaemon } from './app-daemon.js'
import type { AppDaemonCore, AppDaemonDeps } from './app-daemon.js'

/** The header every stderr chunk that starts an entry must carry (specs/core-log, design D3). */
const STRICT_HEADER = /^\[\d{4}-\d{2}-\d{2}\]\[\d{2}:\d{2}:\d{2}\]\[core\]\[(DEBUG|INFO|WARN|ERROR)\] /
const NOW = new Date('2026-09-28T12:00:05.750Z')
const STAMP = '[2026-09-28][12:00:05]'
const START_LINE = `${STAMP}[core][INFO] atomic-chat-app-core ${CORE_VERSION} starting (pid 4242, darwin/arm64)\n`
const READY: ReturnType<AppDaemonCore['readyLine']> = {
  event: 'core:ready',
  pid: 4242,
  instance_id: 'instance-1',
  protocol: 1,
  version: CORE_VERSION,
  control_host: '127.0.0.1',
  control_port: 5555,
}

let data: TmpDataFolder

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-app-daemon-')
})
afterEach(async () => {
  await data.cleanup()
})

interface HarnessOptions {
  argv?: string[]
  /** Replaces the fake core's start; the options the daemon passed are recorded first either way. */
  createCore?: (options: AtomicCoreOptions) => Promise<AppDaemonCore>
  /** Runs while the core is up, before the fake shutdown signal arrives. */
  whileRunning?: (options: AtomicCoreOptions) => void | Promise<void>
  /** Runs inside the injected `exit`, the moment the daemon ends the process. */
  onExit?: () => void
}

/** A daemon run against recording io, a fixed clock, a fake core and a real temporary data folder. */
function harness(options: HarnessOptions = {}) {
  let coreOptions: AtomicCoreOptions | undefined
  let reporterInput: CoreReporterInput | undefined
  const exits: number[] = []
  const processEvents = new EventEmitter()
  const started = (): AtomicCoreOptions => {
    if (!coreOptions) throw new Error('the core was never started')
    return coreOptions
  }
  const io = recordingIo({
    waitForShutdown: async (onStop) => {
      await options.whileRunning?.(started())
      await onStop()
    },
  })
  const deps: AppDaemonDeps = {
    argv: options.argv ?? ['daemon', '--data-folder', data.root, '--control-port', '0'],
    io,
    processEvents,
    exit: (code) => {
      exits.push(code)
      options.onExit?.()
    },
    pid: 4242,
    platform: 'darwin',
    arch: 'arm64',
    homeDir: '/home/tester',
    now: () => NOW,
    createReporter: async (input) => {
      reporterInput = input
      return createCoreReporter(input)
    },
    createCore: async (coreStart) => {
      coreOptions = coreStart
      if (options.createCore) return options.createCore(coreStart)
      return { readyLine: () => READY, shutdown: async () => {}, stopped: new Promise<void>(() => {}) }
    },
  }
  return {
    deps,
    io,
    exits,
    processEvents,
    coreOptions: started,
    reporterInput: (): CoreReporterInput => {
      if (!reporterInput) throw new Error('the reporter was never created')
      return reporterInput
    },
    logFile: (): string => readFileSync(join(data.layout.core.logsDir, 'core.log'), 'utf8'),
  }
}

function expectEveryChunkHeaded(chunks: string[]): void {
  expect(chunks.length).toBeGreaterThan(0)
  for (const chunk of chunks) expect(chunk).toMatch(STRICT_HEADER)
}

describe('runAppDaemon', () => {
  it('prints its version for --version and opens no log', async () => {
    const run = harness({ argv: ['--version'] })
    await runAppDaemon(run.deps)
    expect(run.io.out).toEqual([`${CORE_VERSION}\n`])
    expect(run.io.err).toEqual([])
    expect(existsSync(data.layout.core.logsDir)).toBe(false)
  })

  it('refuses bad arguments as before, without opening a log', async () => {
    await expect(runAppDaemon(harness({ argv: ['serve'] }).deps)).rejects.toThrow(
      'The app core only accepts the daemon command.'
    )
    await expect(runAppDaemon(harness({ argv: ['daemon'] }).deps)).rejects.toThrow(
      'The app must supply its data folder.'
    )
    await expect(
      runAppDaemon(harness({ argv: ['daemon', '--data-folder', data.root, '--verbose'] }).deps)
    ).rejects.toThrow(/--verbose/)
    await expect(
      runAppDaemon(harness({ argv: ['daemon', '--data-folder', data.root, '--telemetry', 'maybe'] }).deps)
    ).rejects.toThrow('--telemetry takes "on" or "off", not "maybe".')
    expect(existsSync(data.layout.core.logsDir)).toBe(false)
  })

  it('starts the log with its version, tees the logger, files engine output and keeps the handshake', async () => {
    const run = harness({
      argv: [
        'daemon',
        '--data-folder',
        data.root,
        '--control-port',
        '5555',
        '--resources-dir',
        '/app/resources',
        '--cloudflared-bin',
        '/app/cloudflared',
      ],
      whileRunning: ({ logger, backendOutput }) => {
        logger?.('info', 'starting llama-server for llamacpp/qwen3-8b: --port 3310')
        backendOutput?.({ provider: 'llamacpp', model: 'qwen3-8b', stream: 'stderr', line: 'main: loading' })
        backendOutput?.({ provider: 'llamacpp', model: 'qwen3-8b', stream: 'stdout', line: 'listening' })
        logger?.('warn', 'backend catalog is stale')
        logger?.('error', 'model load failed\n  cause: out of memory')
      },
    })
    await runAppDaemon(run.deps)

    const coreEntries = [
      START_LINE,
      `${STAMP}[core][INFO] starting llama-server for llamacpp/qwen3-8b: --port 3310\n`,
      `${STAMP}[core][WARN] backend catalog is stale\n`,
      `${STAMP}[core][ERROR] model load failed\n  cause: out of memory\n`,
    ]
    expect(run.io.err).toEqual(coreEntries)
    expect(run.logFile()).toBe(
      [
        coreEntries[0],
        coreEntries[1],
        `${STAMP}[engine:llamacpp/qwen3-8b][INFO] [stderr] main: loading\n`,
        `${STAMP}[engine:llamacpp/qwen3-8b][INFO] [stdout] listening\n`,
        coreEntries[2],
        coreEntries[3],
      ].join('')
    )
    expectEveryChunkHeaded(run.io.err)
    expect(run.io.out).toEqual([`${JSON.stringify(READY)}\n`])
    expect(run.coreOptions()).toMatchObject({
      ownerScope: 'app',
      dataFolder: data.root,
      controlPort: 5555,
      resourcesDir: '/app/resources',
      cloudflaredPath: '/app/cloudflared',
    })
    expect(run.reporterInput()).toMatchObject({
      host: 'atomic-chat',
      ownerScope: 'app',
      dataFolder: data.root,
    })

    // The file is closed once the core has stopped; stderr still takes the core's lines.
    run.coreOptions().logger?.('info', 'after shutdown')
    expect(run.logFile()).not.toContain('after shutdown')
    expect(run.io.err.at(-1)).toBe(`${STAMP}[core][INFO] after shutdown\n`)
  })

  it('gives the error reporter warnings a header on stderr and keeps them in the file', async () => {
    const run = harness({ whileRunning: () => run.reporterInput().warn('report not sent: ECONNREFUSED') })
    await runAppDaemon(run.deps)
    const warning = `${STAMP}[core][WARN] report not sent: ECONNREFUSED\n`
    expect(run.io.err).toEqual([START_LINE, warning])
    expect(run.logFile()).toBe(`${START_LINE}${warning}`)
  })

  it('writes a start-up failure to stderr and the file at ERROR, closes the file and exits 1', async () => {
    const failure = new Error('control port 5555 is busy')
    const run = harness({
      createCore: async ({ logger }) => {
        logger?.('info', 'binding the control port')
        throw failure
      },
      onExit: () => run.coreOptions().logger?.('info', 'written after the exit began'),
    })
    await expect(runAppDaemon(run.deps)).rejects.toBe(failure)

    expect(run.exits).toEqual([1])
    expect(run.io.out).toEqual([])
    expectEveryChunkHeaded(run.io.err)
    const fatal = run.io.err.find((chunk) => chunk.includes('[core][ERROR]'))
    expect(fatal).toMatch(
      /^\[2026-09-28\]\[12:00:05\]\[core\]\[ERROR\] Error: control port 5555 is busy\n {4}at /
    )
    // A stack keeps the header on its first line only, and ends with exactly one newline.
    expect(fatal?.split('\n').filter((line) => STRICT_HEADER.test(line))).toHaveLength(1)
    expect(fatal).toMatch(/[^\n]\n$/)
    expect(run.logFile()).toBe(
      `${START_LINE}${STAMP}[core][INFO] binding the control port\n${fatal ?? '<no ERROR entry>'}`
    )
    expect(run.io.err.at(-1)).toBe(`${STAMP}[core][INFO] written after the exit began\n`)
  })

  it('writes an uncaught failure while running to stderr and the file at ERROR, then exits 1', async () => {
    const run = harness({
      whileRunning: async () => {
        run.processEvents.emit('uncaughtException', new TypeError('late failure'))
        await vi.waitFor(() => expect(run.exits).toEqual([1]))
      },
    })
    await runAppDaemon(run.deps)

    expectEveryChunkHeaded(run.io.err)
    const fatal = run.io.err.find((chunk) => chunk.includes('[core][ERROR]'))
    expect(fatal).toMatch(/^\[2026-09-28\]\[12:00:05\]\[core\]\[ERROR\] TypeError: late failure\n/)
    expect(run.logFile()).toBe(`${START_LINE}${fatal ?? '<no ERROR entry>'}`)
  })

  it('starts the core and keeps writing stderr when the log folder cannot be written', async () => {
    writeFileSync(data.layout.core.logsDir, 'a file where the folder should be')
    const run = harness({ whileRunning: ({ logger }) => logger?.('warn', 'still logging') })
    await runAppDaemon(run.deps)

    expect(run.io.out).toEqual([`${JSON.stringify(READY)}\n`])
    expectEveryChunkHeaded(run.io.err)
    expect(run.io.err[0]).toMatch(/^\[2026-09-28\]\[12:00:05\]\[core\]\[WARN\] log file disabled: /)
    expect(run.io.err.slice(1)).toEqual([START_LINE, `${STAMP}[core][WARN] still logging\n`])
  })
})
