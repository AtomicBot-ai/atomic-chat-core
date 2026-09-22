/**
 * Wiring for `fake-cloudflared.mjs`. The fake is a Node script launched as `node <script> <the real
 * cloudflared argv>`, with no shell in between: a `sh -c` stand-in would leave a grandchild holding
 * the pipes, and everything downstream of the spawn — output parsing, exit detection, SIGTERM then
 * SIGKILL — is the production code path.
 */
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnTunnel } from '../../src/remote-access/index.js'
import type { TunnelCommand, TunnelProcess } from '../../src/remote-access/index.js'

export const FAKE_CLOUDFLARED_SCRIPT = fileURLToPath(new URL('./fake-cloudflared.mjs', import.meta.url))
export const FAKE_TUNNEL_URL = 'https://calm-river-demo.trycloudflare.com'

export type FakeCloudflaredMode =
  | 'url-then-registered'
  | 'url-only'
  | 'registers-only-on-http2'
  | 'silent'
  | 'exit-immediately'
  | 'ready-then-exit'
  | 'ignore-sigterm'

export interface FakeCloudflaredOptions {
  mode?: FakeCloudflaredMode
  url?: string
  /** Every started fake appends `{argv, tunnelEnv, pid}` here, one JSON line each. */
  argvFile?: string
}

export function fakeCloudflaredEnv(options: FakeCloudflaredOptions): Record<string, string> {
  const env: Record<string, string> = { FAKE_CLOUDFLARED_MODE: options.mode ?? 'url-then-registered' }
  if (options.url) env['FAKE_CLOUDFLARED_URL'] = options.url
  if (options.argvFile) env['FAKE_CLOUDFLARED_ARGV_FILE'] = options.argvFile
  return env
}

/** The command that runs the fake in place of `cloudflared <args>`. */
export function fakeCloudflaredCommand(
  args: string[],
  options: FakeCloudflaredOptions = {},
  env: Record<string, string> = {}
): TunnelCommand {
  return {
    program: process.execPath,
    args: [FAKE_CLOUDFLARED_SCRIPT, ...args],
    env: { ...(process.env as Record<string, string>), ...env, ...fakeCloudflaredEnv(options) },
  }
}

export function spawnFakeCloudflared(
  options: FakeCloudflaredOptions = {},
  args: string[] = []
): TunnelProcess {
  return spawnTunnel(fakeCloudflaredCommand(args, options))
}

/**
 * An executable named `cloudflared` that runs the fake, for code paths that spawn a path — the
 * compiled core. POSIX shells only; on Windows the caller skips.
 */
export async function writeFakeCloudflaredBinary(
  dir: string,
  options: FakeCloudflaredOptions = {}
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const path = join(dir, 'cloudflared')
  const exports = Object.entries(fakeCloudflaredEnv(options))
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  await writeFile(
    path,
    `#!/bin/sh\n${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLOUDFLARED_SCRIPT)} "$@"\n`
  )
  await chmod(path, 0o755)
  return path
}
