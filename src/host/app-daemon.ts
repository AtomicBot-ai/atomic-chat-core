/**
 * The `atomic-chat-app-core` binary behind its thin entry (`src/app-daemon.ts`): parse the app's
 * arguments, open `<data>/atomic-core/logs/core.log`, and run the core until something stops it.
 * Internal to the host layer — not exported from `src/host/index.ts` or the package.
 *
 * Every line this binary writes to stderr (the app keeps it as `core-start.log`) carries the
 * `formatLogLine` header with target `core`: the core's logger, the error reporter's warnings, the
 * fatal handlers and the log file's own "disabled" warning (design D3/D6 of `add-unified-logs`).
 * The same entries go to `core.log`, together with every engine's stdout/stderr, which goes to the
 * file only. The CLI's `daemon` command (`src/cli/commands/daemon.ts`) writes no log file and keeps
 * its `[level] message` stderr. The stdout handshake is the same one JSON ready line as before.
 */

import { parseArgs } from 'node:util'
import type { CliIo } from '../cli/index.js'
import { dataLayout } from '../config/index.js'
import type { AtomicCore, AtomicCoreOptions } from '../core/index.js'
import {
  breadcrumbLogger,
  failFatally,
  installProcessHandlers,
  parseTelemetryFlag,
} from '../telemetry/index.js'
import type { CoreReporterInput, ErrorReporter, FatalDeps, ProcessEvents } from '../telemetry/index.js'
import { CORE_VERSION } from '../version.js'
import { formatLogLine, openLogFile } from './log-file.js'
import type { LogLevel } from './log-file.js'

/** What the daemon uses of the core it starts; `AtomicCore` in the binary, a fake in tests. */
export type AppDaemonCore = Pick<AtomicCore, 'readyLine' | 'shutdown' | 'stopped'>

/**
 * Everything outside the daemon's own logic; the entry passes the real process, clock, reporter and
 * core. `core.log` itself is written with the real `node:fs` under `<data>/atomic-core/logs`.
 */
export interface AppDaemonDeps {
  /** The arguments after the executable: `process.argv.slice(2)`. */
  argv: string[]
  io: Pick<CliIo, 'stdout' | 'stderr' | 'env' | 'waitForShutdown'>
  /** Where uncaught exceptions and unhandled rejections are heard: `process`. */
  processEvents: ProcessEvents
  exit: (code: number) => unknown
  pid: number
  platform: NodeJS.Platform
  arch: string
  homeDir: string
  /** The clock of every log header, on stderr and in `core.log`. */
  now: () => Date
  createReporter: (input: CoreReporterInput) => Promise<ErrorReporter>
  createCore: (options: AtomicCoreOptions) => Promise<AppDaemonCore>
}

const LEVELS: Record<'info' | 'warn' | 'error', LogLevel> = { info: 'INFO', warn: 'WARN', error: 'ERROR' }

/**
 * Run `atomic-chat-app-core --version` or `atomic-chat-app-core daemon --data-folder <data> …`.
 * Argument errors throw before anything is opened. A start-up failure is written at `ERROR`,
 * reported, and ends the process through `deps.exit(1)`; the error is then rethrown.
 */
export async function runAppDaemon(deps: AppDaemonDeps): Promise<void> {
  const { io } = deps
  const args = [...deps.argv]
  if (args.length === 1 && args[0] === '--version') {
    io.stdout(`${CORE_VERSION}\n`)
    return
  }
  const command = args.shift()
  if (command !== 'daemon') throw new Error('The app core only accepts the daemon command.')
  const { values } = parseArgs({
    args,
    options: {
      'data-folder': { type: 'string' },
      'control-port': { type: 'string' },
      'resources-dir': { type: 'string' },
      'cloudflared-bin': { type: 'string' },
      // The app's `productAnalytic` consent at launch; it updates it later over PUT /telemetry.
      // Absent, the core decides for itself (docs/decisions/*-the-core-owns-its-error-reporting.md).
      'telemetry': { type: 'string' },
    },
    strict: true,
  })
  const dataFolder = values['data-folder']
  if (!dataFolder) throw new Error('The app must supply its data folder.')
  const telemetry = parseTelemetryFlag(values['telemetry'])
  const layout = dataLayout(dataFolder)

  // Never throws: a folder it cannot write leaves one WARN line on stderr and a no-op writer.
  const logFile = openLogFile(layout.core.logsDir, 'core', { now: deps.now, stderr: io.stderr })
  /** One entry of the core's own: the same header on stderr and in `core.log`. */
  const log = (level: LogLevel, message: string): void => {
    io.stderr(formatLogLine(deps.now(), 'core', level, message))
    logFile.write('core', level, message)
  }
  log(
    'INFO',
    `atomic-chat-app-core ${CORE_VERSION} starting (pid ${deps.pid}, ${deps.platform}/${deps.arch})`
  )

  const reporter = await deps.createReporter({
    host: 'atomic-chat',
    ownerScope: 'app',
    enabled: telemetry,
    dataFolder,
    telemetryFile: layout.core.telemetry,
    homeDir: deps.homeDir,
    env: io.env,
    platform: deps.platform,
    arch: deps.arch,
    version: CORE_VERSION,
    warn: (message) => log('WARN', message),
  })
  const fatal: FatalDeps = {
    reporter,
    // `failFatally` ends its text with a newline; the entry brings its own.
    writeStderr: (text) => log('ERROR', text.replace(/\n$/, '')),
    exit: (code) => {
      logFile.close()
      return deps.exit(code)
    },
  }
  installProcessHandlers(deps.processEvents, fatal)
  let core: AppDaemonCore
  try {
    core = await deps.createCore({
      ownerScope: 'app',
      dataFolder,
      controlPort: Number(values['control-port'] ?? 0),
      ...(values['resources-dir'] ? { resourcesDir: values['resources-dir'] } : {}),
      // The app bundles the tunnel binary next to its own executable, not under its resources.
      ...(values['cloudflared-bin'] ? { cloudflaredPath: values['cloudflared-bin'] } : {}),
      env: io.env,
      errorReporter: reporter,
      logger: breadcrumbLogger(reporter, (level, message) => log(LEVELS[level], message)),
      backendOutput: ({ provider, model, stream, line }) =>
        logFile.write(`engine:${provider}/${model}`, 'INFO', `[${stream}] ${line}`),
    })
  } catch (error) {
    await failFatally('startup', error, fatal)
    throw error
  }
  io.stdout(`${JSON.stringify(core.readyLine())}\n`)
  await Promise.race([io.waitForShutdown(() => core.shutdown()), core.stopped])
  await reporter.flush()
  logFile.close()
}
