/**
 * `@atomic-chat/core/geniex-host`: the one entry of the hidden `geniex-host` mode (change
 * `add-geniex-runtime`, design D1). The core binaries and any program that embeds the core as a
 * library (`atc`) hand it the arguments after `geniex-host` before they parse their own commands,
 * because `geniexHostCommand` starts the host as `<this program> geniex-host …`.
 *
 * Importing this file loads no `bun:*`: the library lives in a Worker the mode alone starts.
 */

import { detachableWriter } from '../../cli/io.js'
import { WorkerEngine, spawnGeniexWorker } from './host/engine.js'
import { lineIo, runGeniexHost } from './host/run.js'

/**
 * Runs `geniex-host <argv…>` and returns its exit code (`EXIT` in `host/run.ts`). Lines go to this
 * process's stdout and stderr through writers that go quiet instead of crashing the host when the
 * core closed its end of a pipe (EPIPE).
 */
export async function runGeniexHostMain(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: detachableWriter(process.stdout),
    stderr: detachableWriter(process.stderr),
  }
): Promise<number> {
  return runGeniexHost(argv, { ...lineIo(io), startEngine: () => new WorkerEngine(spawnGeniexWorker()) })
}
