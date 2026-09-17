#!/usr/bin/env node
/** Dedicated app-owned binary. It has no CLI command dispatcher or path override for CLI commands. */
import { parseArgs } from 'node:util'
import { AtomicCore } from './core.js'
import { CORE_VERSION } from './version.js'
import { nodeCliIo } from './cli/io.js'

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
    },
    strict: true,
  })
  if (!values['data-folder']) throw new Error('The app must supply its data folder.')
  const core = await AtomicCore.create({
    ownerScope: 'app',
    dataFolder: values['data-folder'],
    controlPort: Number(values['control-port'] ?? 0),
    ...(values['resources-dir'] ? { resourcesDir: values['resources-dir'] } : {}),
    env: io.env,
    logger: (level, message) => io.stderr(`[${level}] ${message}\n`),
  })
  io.stdout(`${JSON.stringify(core.readyLine())}\n`)
  await Promise.race([io.waitForShutdown(() => core.shutdown()), core.stopped])
}
