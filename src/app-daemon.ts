#!/usr/bin/env node
/** Dedicated app-owned binary. It has no CLI command dispatcher or path override for CLI commands. */
import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { dataLayout } from './config/index.js'
import { AtomicCore } from './core/index.js'
import { CORE_VERSION } from './version.js'
import { nodeCliIo } from './cli/io.js'
import {
  breadcrumbLogger,
  createCoreReporter,
  failFatally,
  installProcessHandlers,
  parseTelemetryFlag,
} from './telemetry/index.js'

const io = nodeCliIo()
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--version') {
  io.stdout(`${CORE_VERSION}\n`)
} else {
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
  const reporter = await createCoreReporter({
    host: 'atomic-chat',
    ownerScope: 'app',
    enabled: parseTelemetryFlag(values['telemetry']),
    dataFolder,
    telemetryFile: dataLayout(dataFolder).core.telemetry,
    homeDir: homedir(),
    env: io.env,
    platform: process.platform,
    arch: process.arch,
    version: CORE_VERSION,
    warn: (message) => io.stderr(`[warn] ${message}\n`),
  })
  const fatal = { reporter, writeStderr: io.stderr, exit: (code: number) => process.exit(code) }
  installProcessHandlers(process, fatal)
  let core: AtomicCore
  try {
    core = await AtomicCore.create({
      ownerScope: 'app',
      dataFolder,
      controlPort: Number(values['control-port'] ?? 0),
      ...(values['resources-dir'] ? { resourcesDir: values['resources-dir'] } : {}),
      // The app bundles the tunnel binary next to its own executable, not under its resources.
      ...(values['cloudflared-bin'] ? { cloudflaredPath: values['cloudflared-bin'] } : {}),
      env: io.env,
      errorReporter: reporter,
      logger: breadcrumbLogger(reporter, (level, message) => io.stderr(`[${level}] ${message}\n`)),
    })
  } catch (error) {
    await failFatally('startup', error, fatal)
    throw error
  }
  io.stdout(`${JSON.stringify(core.readyLine())}\n`)
  await Promise.race([io.waitForShutdown(() => core.shutdown()), core.stopped])
  await reporter.flush()
}
