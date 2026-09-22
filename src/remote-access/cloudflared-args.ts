/**
 * How `cloudflared` is launched: which binary, which arguments, which environment. Pure.
 *
 * `cloudflared tunnel --url <origin>` opens a "quick tunnel": no Cloudflare account, no domain, and
 * a fresh `https://<words>.trycloudflare.com` name on every start.
 *
 * Ported from: src-tauri/src/core/server/remote_access/process.rs (image-generation line, `767ff6350`).
 */

import { join } from 'node:path'

/** The core does not download the tunnel binary; this variable names one for dev and CLI use. */
export const CLOUDFLARED_BIN_ENV = 'ATOMIC_CLOUDFLARED_BIN'

export function cloudflaredFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
}

/**
 * The command line of one quick tunnel.
 *
 * `emptyConfig` switches off the lookup of `~/.cloudflared/config.yml`: a user who also runs a
 * *named* tunnel has ingress rules there, none of which match a quick tunnel's hostname, so
 * cloudflared itself would answer every request through ours with 404. `--no-autoupdate` because the
 * binary ships signed inside the app bundle, and left to itself cloudflared replaces its own file.
 */
export function cloudflaredArgs(origin: string, protocol?: string, emptyConfig?: string): string[] {
  const args = ['tunnel']
  if (emptyConfig !== undefined) args.push('--config', emptyConfig)
  args.push('--url', origin, '--no-autoupdate')
  if (protocol !== undefined) args.push('--protocol', protocol)
  return args
}

/**
 * The child's environment: the caller's, minus every `TUNNEL_*` variable. cloudflared reads those as
 * flags (`TUNNEL_TOKEN`, `TUNNEL_TRANSPORT_PROTOCOL`, `TUNNEL_URL`…); a user who also runs their own
 * tunnels may have them exported, and they must not steer ours.
 */
export function scrubTunnelEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const scrubbed: Record<string, string> = {}
  for (const [key, value] of Object.entries(env))
    if (value !== undefined && !key.toUpperCase().startsWith('TUNNEL_')) scrubbed[key] = value
  return scrubbed
}

export interface CloudflaredLocation {
  /** `--cloudflared-bin`: the app names the sidecar it bundles next to its own executable. */
  explicit?: string | undefined
  env?: NodeJS.ProcessEnv | undefined
  /** The app's `resources/bin`, where the other bundled servers live. */
  resourcesDir?: string | undefined
  platform: NodeJS.Platform
  exists: (path: string) => boolean
}

/**
 * The tunnel binary, or `undefined` when this installation does not carry one — which the status
 * reports as `cloudflared_unavailable`. An explicit path that does not exist is not silently
 * replaced by another candidate: the caller said where it is.
 */
export function resolveCloudflaredBinary(location: CloudflaredLocation): string | undefined {
  const fromEnv = location.env?.[CLOUDFLARED_BIN_ENV]?.trim()
  const named = location.explicit?.trim() || fromEnv
  if (named) return location.exists(named) ? named : undefined
  if (!location.resourcesDir) return undefined
  const bundled = join(location.resourcesDir, cloudflaredFileName(location.platform))
  return location.exists(bundled) ? bundled : undefined
}
