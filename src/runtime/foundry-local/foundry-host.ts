/**
 * `@atomic-chat/core/foundry-host`: the one entry of the hidden `foundry-host` mode (change
 * close-cli-core-gaps, design D1). The core binaries and any program that embeds the core as a library
 * (`atc`) hand it the arguments after `foundry-host` before they parse their own commands, because
 * `foundryHostCommand` starts the host as `<this program> foundry-host …`.
 *
 * Importing this file loads no `bun:*`: the FFI bindings load dynamically, inside the mode alone.
 */

import { detachableWriter } from '../../cli/io.js'
import { lineIo, loadLibraryWithBun, runFoundryHost } from './host/run.js'

/**
 * Runs `foundry-host <argv…>` and returns its exit code (0 done, 2 usage, 3 the library does not
 * load, 4 a library call failed). Lines go to this process's stdout and stderr, through writers that
 * go quiet instead of crashing the host when the core closed its end of a pipe (EPIPE); `io` exists
 * for the core's own CLI, which takes its streams injected.
 */
export async function runFoundryHostMain(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: detachableWriter(process.stdout),
    stderr: detachableWriter(process.stderr),
  }
): Promise<number> {
  return runFoundryHost(argv, { ...lineIo(io), loadLibrary: loadLibraryWithBun })
}
