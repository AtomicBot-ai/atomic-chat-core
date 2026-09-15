#!/usr/bin/env node
/**
 * Executable entry: the only file with side effects on import. `main.ts` stays pure so tests can
 * drive `runCli()` directly. `scripts/build-binaries.mjs` compiles this file.
 */
import { runCli } from './main.js'

const result = runCli(process.argv.slice(2))
if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
process.exitCode = result.exitCode
