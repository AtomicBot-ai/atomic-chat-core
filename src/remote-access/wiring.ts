/**
 * Everything the tunnel manager needs from the outside, put together in one place so the owner's
 * wiring stays a single call: how `cloudflared` is found and started, how a URL is proven, and where
 * the crash-recovery record goes.
 */

import { readFile } from 'node:fs/promises'
import { TunnelJournal } from './journal.js'
import type { RemoteAccessManagerDeps } from './manager.js'
import { PublicProber } from './probe.js'
import type { EdgeAddress, Prober } from './probe.js'
import type { TunnelSpawner, TunnelTimings } from './process.js'
import { cloudflaredSpawner } from './spawner.js'

/**
 * Test hooks only, like the ChatGPT endpoints': stand in for Cloudflare's edge and trust its
 * certificate. Production never sets them.
 */
export const REMOTE_ACCESS_EDGE_ENV = 'ATOMIC_REMOTE_ACCESS_EDGE'
export const REMOTE_ACCESS_CA_ENV = 'ATOMIC_REMOTE_ACCESS_CA'

export interface RemoteAccessWiring {
  /** Test seams: a scripted process, a scripted probe, short timings. */
  overrides?: { spawner?: TunnelSpawner; prober?: Prober; timings?: Partial<TunnelTimings> } | undefined
  /** `--cloudflared-bin`. */
  cloudflaredPath?: string | undefined
  resourcesDir?: string | undefined
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  journalPath: string
  emptyConfigPath: string
  instanceId: string
  warn: (message: string) => void
}

/** `host:port` of a stand-in for Cloudflare's edge; `undefined` for anything else. */
export function parseEdgeAddress(value: string | undefined): EdgeAddress | undefined {
  const match = /^(.+):(\d+)$/.exec(value?.trim() ?? '')
  if (!match) return undefined
  return { host: (match[1] as string).replace(/^\[|\]$/g, ''), port: Number(match[2]) }
}

export async function wireRemoteAccess(
  wiring: RemoteAccessWiring
): Promise<Pick<RemoteAccessManagerDeps, 'spawner' | 'prober' | 'timings' | 'journal'>> {
  const edge = parseEdgeAddress(wiring.env[REMOTE_ACCESS_EDGE_ENV])
  const caPath = wiring.env[REMOTE_ACCESS_CA_ENV]
  const prober =
    wiring.overrides?.prober ??
    new PublicProber({
      ...(edge ? { edgeAddresses: async () => [edge] } : {}),
      ...(caPath ? { ca: await readFile(caPath) } : {}),
    })
  const spawner =
    wiring.overrides?.spawner ??
    cloudflaredSpawner({
      explicit: wiring.cloudflaredPath,
      env: wiring.env,
      resourcesDir: wiring.resourcesDir,
      platform: wiring.platform,
      emptyConfigPath: wiring.emptyConfigPath,
      log: wiring.warn,
    })
  return {
    spawner,
    prober,
    ...(wiring.overrides?.timings ? { timings: wiring.overrides.timings } : {}),
    journal: new TunnelJournal(wiring.journalPath, wiring.instanceId, { log: wiring.warn }),
  }
}
