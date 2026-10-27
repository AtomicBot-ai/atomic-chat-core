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

// The Foundry Local host (change add-foundry-local, design D1): the app's core starts its own binary
// in this hidden mode, one process per model; it never reaches the daemon. The same public entry `atc`
// uses (change close-cli-core-gaps, D1).
if (process.argv[2] === 'foundry-host') {
  const { runFoundryHostMain } = await import('./runtime/foundry-local/foundry-host.js')
  process.exit(await runFoundryHostMain(process.argv.slice(3)))
}
// The LiteRT-LM host (change add-litert-lm-runtime, design D1), the same way.
if (process.argv[2] === 'litert-host') {
  const { runLiteRtHostMain } = await import('./runtime/litert-lm/litert-host.js')
  process.exit(await runLiteRtHostMain(process.argv.slice(3)))
}
// The GenieX host (change add-geniex-runtime, design D1), the same way.
if (process.argv[2] === 'geniex-host') {
  const { runGeniexHostMain } = await import('./runtime/geniex/geniex-host.js')
  process.exit(await runGeniexHostMain(process.argv.slice(3)))
}

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
