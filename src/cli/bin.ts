#!/usr/bin/env node
/**
 * Executable entry: the only file with side effects on import. `main.ts` stays injectable so tests
 * can drive commands without spawning. `scripts/build-binaries.mjs` compiles this file.
 */
import { nodeCliIo } from './io.js'
import { runCli } from './main.js'

const exitCode = await runCli(process.argv.slice(2), nodeCliIo())
process.exitCode = exitCode
