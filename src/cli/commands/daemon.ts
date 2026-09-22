/** `daemon` — run this process as the owner of a data folder. */

import { homedir } from 'node:os'
import { parseArgs } from 'node:util'
import { AtomicCore } from '../../core/index.js'
import {
  breadcrumbLogger,
  captureReport,
  createCoreReporter,
  parseTelemetryFlag,
  processFailureReport,
} from '../../telemetry/index.js'
import { CORE_VERSION } from '../../version.js'
import type { CliIo } from '../io.js'
import { layoutFor, pathValue } from './shared.js'
import { printFirstRunNotice } from './telemetry.js'

/** `daemon` — become the owner and stay up until something asks us to stop. */
export async function daemonCommand(argv: string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      'data-folder': { type: 'string' },
      'control-port': { type: 'string' },
      'control-host': { type: 'string' },
      'public-port': { type: 'string' },
      'public-host': { type: 'string' },
      'api-key': { type: 'string' },
      'resources-dir': { type: 'string' },
      'cloudflared-bin': { type: 'string' },
      'verbose': { type: 'boolean', short: 'v' },
      // A host that starts this daemon may pass its user's consent; absent, the core decides itself.
      'telemetry': { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const layout = layoutFor(values, io)
  const resourcesDir = pathValue(values['resources-dir'], io.cwd)
  const cloudflaredPath = pathValue(values['cloudflared-bin'], io.cwd)
  const reporter = await createCoreReporter({
    host: 'cli',
    ownerScope: 'cli',
    enabled: parseTelemetryFlag(values['telemetry']),
    dataFolder: layout.root,
    telemetryFile: layout.core.telemetry,
    homeDir: homedir(),
    env: io.env,
    platform: process.platform,
    arch: process.arch,
    version: CORE_VERSION,
    warn: (message) => io.stderr(`[warn] ${message}\n`),
  })
  await printFirstRunNotice(io, layout.core.telemetry)
  io.installProcessHandlers?.({ reporter })
  let core: AtomicCore
  try {
    core = await AtomicCore.create({
      dataFolder: layout.root,
      ownerScope: 'cli',
      ...(resourcesDir ? { resourcesDir } : {}),
      ...(cloudflaredPath ? { cloudflaredPath } : {}),
      controlPort: values['control-port'] !== undefined ? Number(values['control-port']) : 0,
      ...(values['control-host'] ? { controlHost: values['control-host'] } : {}),
      env: io.env,
      errorReporter: reporter,
      logger: breadcrumbLogger(reporter, (level, message) => {
        if (values.verbose || level !== 'info') io.stderr(`[${level}] ${message}\n`)
      }),
    })
  } catch (error) {
    captureReport(reporter, processFailureReport('startup', error))
    await reporter.flush()
    throw error
  }
  // The first stdout line is the handshake; everything else goes to stderr so it stays parseable.
  io.stdout(`${JSON.stringify(core.readyLine())}\n`)
  if (values['public-port'] !== undefined) {
    await core.startPublicServer({
      port: Number(values['public-port']),
      ...(values['public-host'] ? { host: values['public-host'] } : {}),
      ...(values['api-key'] ? { apiKey: values['api-key'] } : {}),
    })
  }
  // Either a signal reaches us, or something asked the core to stop through the control API.
  await Promise.race([
    io.waitForShutdown(async () => {
      await core.shutdown()
    }),
    core.stopped,
  ])
  await reporter.flush()
  return 0
}
