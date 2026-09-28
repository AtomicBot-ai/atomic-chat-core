#!/usr/bin/env node
/**
 * Dedicated app-owned binary. It has no CLI command dispatcher or path override for CLI commands.
 * This entry only hands the real process, clock and core to `runAppDaemon` (`host/app-daemon.ts`);
 * `scripts/build-binaries.mjs` and `docs/app-e2e.md` depend on this file's path.
 */
import { homedir } from 'node:os'
import { AtomicCore } from './core/index.js'
import { nodeCliIo } from './cli/io.js'
import { runAppDaemon } from './host/app-daemon.js'
import { createCoreReporter } from './telemetry/index.js'

await runAppDaemon({
  argv: process.argv.slice(2),
  io: nodeCliIo(),
  processEvents: process,
  exit: (code) => process.exit(code),
  pid: process.pid,
  platform: process.platform,
  arch: process.arch,
  homeDir: homedir(),
  now: () => new Date(),
  createReporter: createCoreReporter,
  createCore: (options) => AtomicCore.create(options),
})
