/** `daemon` — run this process as the owner of a data folder. */

import { parseArgs } from 'node:util'
import { AtomicCore } from '../../core/index.js'
import type { CliIo } from '../io.js'
import { layoutFor, pathValue } from './shared.js'

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
      'verbose': { type: 'boolean', short: 'v' },
    },
    strict: true,
    allowPositionals: false,
  })
  const layout = layoutFor(values, io)
  const resourcesDir = pathValue(values['resources-dir'], io.cwd)
  const core = await AtomicCore.create({
    dataFolder: layout.root,
    ownerScope: 'cli',
    ...(resourcesDir ? { resourcesDir } : {}),
    controlPort: values['control-port'] !== undefined ? Number(values['control-port']) : 0,
    ...(values['control-host'] ? { controlHost: values['control-host'] } : {}),
    env: io.env,
    logger: (level, message) => {
      if (values.verbose || level !== 'info') io.stderr(`[${level}] ${message}\n`)
    },
  })
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
  return 0
}
