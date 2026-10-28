/**
 * How an e2e test makes the compiled core register GenieX off a Snapdragon X laptop (change
 * `add-geniex-runtime`): `ATOMIC_GENIEX_TEST_CHIP` stands in for the processor string and
 * `ATOMIC_GENIEX_HOST_TEST_COMMAND` for `geniex-host`. The fake host is a shell launcher, so the tests
 * run on POSIX only; a Windows run would need a `.cmd` launcher.
 */

import { chmod, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const FAKE_GENIEX_HOST = fileURLToPath(new URL('./fake-geniex-host.mjs', import.meta.url))

/** A launcher at `path` that runs the fake host with `env` exported first. */
export async function writeFakeGeniexHost(path: string, env: Record<string, string> = {}): Promise<string> {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  await writeFile(
    path,
    `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_GENIEX_HOST)} "$@"\n`
  )
  await chmod(path, 0o755)
  return path
}

/** The environment that registers the provider on this (non-Snapdragon) machine. */
export function geniexTestEnv(
  host: string,
  chip: 'x-elite' | 'x2-elite' = 'x-elite'
): Record<string, string> {
  return { ATOMIC_GENIEX_TEST_CHIP: chip, ATOMIC_GENIEX_HOST_TEST_COMMAND: host }
}
