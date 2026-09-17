/**
 * The production spawner: find the binary, make sure the user's own cloudflared configuration cannot
 * steer the quick tunnel, and start it.
 */

import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { cloudflaredArgs, resolveCloudflaredBinary, scrubTunnelEnv } from './cloudflared-args.js'
import { spawnTunnel } from './process.js'
import type { TunnelCommand, TunnelProcess, TunnelSpawner } from './process.js'

export interface CloudflaredSpawnerOptions {
  /** `--cloudflared-bin`. */
  explicit?: string | undefined
  env: NodeJS.ProcessEnv
  resourcesDir?: string | undefined
  platform: NodeJS.Platform
  /** Where the empty `--config` document lives on Windows, which has no `/dev/null`. */
  emptyConfigPath: string
  exists?: (path: string) => boolean
  log?: (message: string) => void
  /** Test seam: run something else in place of the resolved command. */
  launch?: (command: TunnelCommand, platform: NodeJS.Platform) => TunnelProcess
}

/**
 * An empty configuration document for `--config`, so cloudflared does not read
 * `~/.cloudflared/config.yml`. Best effort on Windows: without it the tunnel still works for
 * everybody who has no configuration file of their own.
 */
export async function emptyConfigFor(
  platform: NodeJS.Platform,
  windowsPath: string
): Promise<string | undefined> {
  if (platform !== 'win32') return '/dev/null'
  try {
    await mkdir(dirname(windowsPath), { recursive: true })
    await writeFile(windowsPath, '')
    return windowsPath
  } catch {
    return undefined
  }
}

export function cloudflaredSpawner(options: CloudflaredSpawnerOptions): TunnelSpawner {
  return async (origin, protocol) => {
    const program = resolveCloudflaredBinary({
      explicit: options.explicit,
      env: options.env,
      resourcesDir: options.resourcesDir,
      platform: options.platform,
      exists: options.exists ?? existsSync,
    })
    if (program === undefined) {
      options.log?.('remote access: no cloudflared binary was found for this installation')
      return undefined
    }
    const emptyConfig = await emptyConfigFor(options.platform, options.emptyConfigPath)
    const command: TunnelCommand = {
      program,
      args: cloudflaredArgs(origin, protocol, emptyConfig),
      env: scrubTunnelEnv(options.env),
    }
    return (options.launch ?? spawnTunnel)(command, options.platform)
  }
}
