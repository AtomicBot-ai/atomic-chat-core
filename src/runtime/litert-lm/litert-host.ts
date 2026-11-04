/**
 * `@atomic-chat/core/litert-host`: the one entry of the hidden `litert-host` mode (change
 * `add-litert-lm-runtime`, design D1). The core binaries and any program that embeds the core as a
 * library (`atc`) hand it the arguments after `litert-host` before they parse their own commands,
 * because `liteRtHostCommand` starts the host as `<this program> litert-host …`.
 *
 * Importing this file loads no `bun:*`: the FFI bindings load dynamically, inside the mode alone.
 */

import { detachableWriter } from '../../cli/io.js'
import { lineIo, loadLibraryWithBun, runLiteRtHost } from './host/run.js'

/**
 * Runs `litert-host <argv…>` and returns its exit code (`EXIT` in `host/run.ts`). Lines go to this
 * process's stdout and stderr through writers that go quiet instead of crashing the host when the
 * core closed its end of a pipe (EPIPE).
 */
export async function runLiteRtHostMain(
  argv: readonly string[],
  io: { stdout: (text: string) => void; stderr: (text: string) => void } = {
    stdout: detachableWriter(process.stdout),
    stderr: detachableWriter(process.stderr),
  }
): Promise<number> {
  return runLiteRtHost(argv, { ...lineIo(io), loadLibrary: loadLibraryWithBun })
}
