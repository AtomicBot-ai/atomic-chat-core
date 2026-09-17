/**
 * Installs a backend pack into a data folder whose `llama-server` is `fake-llama-server.mjs`, so a
 * core that resolves and spawns a backend the ordinary way gets the fake one.
 *
 * POSIX only: the launcher is a `#!/bin/sh` script, and Windows will not execute a script named
 * `llama-server.exe` (CreateProcess needs a real PE image). Windows covers the backend-spawning path
 * with a real `llama-server` in the live suite (`ATOMIC_LIVE_UPSTREAM_BIN`, PLAN.md §4 phase 1);
 * tests that need this helper skip there rather than pretending to pass.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalProviderId } from '../../src/contracts/index.js'
import type { DataLayout } from '../../src/config/index.js'
import type { FakeLlamaOptions } from './fake-llama-server.js'

export const FAKE_LLAMA_SCRIPT = fileURLToPath(new URL('./fake-llama-server.mjs', import.meta.url))
/** True where a shell-script backend can be executed. */
export const CAN_INSTALL_FAKE_BACKEND = process.platform !== 'win32'

export interface FakeBackendPack {
  version: string
  backend: string
  exePath: string
  versionBackend: string
}

export async function installFakeBackend(
  layout: DataLayout,
  options: FakeLlamaOptions & { provider?: LocalProviderId; version?: string; backend?: string } = {}
): Promise<FakeBackendPack> {
  const provider = options.provider ?? 'llamacpp-upstream'
  const version = options.version ?? 'b6325'
  const backend = options.backend ?? 'macos-arm64'
  const dir = join(layout.provider(provider).backendsDir, version, backend, 'build', 'bin')
  await mkdir(dir, { recursive: true })
  const exePath = join(dir, 'llama-server')
  const env = [
    `FAKE_LLAMA_MODE=${options.mode ?? 'ready'}`,
    options.gpu ? 'FAKE_LLAMA_GPU=1' : '',
    options.delayMs ? `FAKE_LLAMA_DELAY=${options.delayMs}` : '',
    options.reply ? `FAKE_LLAMA_REPLY=${JSON.stringify(options.reply)}` : '',
    options.minCtx ? `FAKE_LLAMA_MIN_CTX=${options.minCtx}` : '',
    options.computeErrorMarker
      ? `FAKE_LLAMA_COMPUTE_ERROR_MARKER=${JSON.stringify(options.computeErrorMarker)}`
      : '',
  ]
    .filter(Boolean)
    .join(' ')
  // `exec VAR=x cmd` is not valid sh; the variables have to be exported first.
  await writeFile(
    exePath,
    `#!/bin/sh\n${env ? `export ${env}\n` : ''}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_LLAMA_SCRIPT)} "$@"\n`
  )
  await chmod(exePath, 0o755)
  return { version, backend, exePath, versionBackend: `${version}/${backend}` }
}
