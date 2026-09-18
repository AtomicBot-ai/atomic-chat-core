import type { LocalProviderId } from '../contracts/index.js'
import type { LoadOptions } from '../runtime/llamacpp/index.js'
import type { LocalLoadOptions } from '../runtime/index.js'
import type { WireDiffusionOptions } from '../diffusion/index.js'
import type { Prober, TunnelSpawner, TunnelTimings } from '../remote-access/index.js'

export type CoreLogger = (level: 'info' | 'warn' | 'error', message: string) => void

export interface AtomicCoreOptions {
  ownerScope?: 'app' | 'cli'
  /** Explicit data folder; otherwise resolved like the app does (PLAN.md §8.2 "Data folder"). */
  dataFolder?: string
  /** Where the app's bundled sidecar binaries live (`resources/bin`); needed for MLX and Foundation Models. */
  resourcesDir?: string
  /**
   * The `cloudflared` binary for remote access (`--cloudflared-bin`). The app bundles it next to its
   * own executable and says where; without it `ATOMIC_CLOUDFLARED_BIN` and the resources folder are
   * tried, and with none of them remote access reports `cloudflared_unavailable`.
   */
  cloudflaredPath?: string
  /** Test seams for the remote-access tunnel: a scripted process, a scripted probe, short timings. */
  remoteAccess?: { spawner?: TunnelSpawner; prober?: Prober; timings?: Partial<TunnelTimings> }
  /** Test seams of the image-generation service (a fake engine, short timings). */
  diffusion?: WireDiffusionOptions['overrides']
  /** The platform runtimes are offered for (macOS-only engines are not registered elsewhere). Test seam. */
  platform?: NodeJS.Platform
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** 'owner' takes the instance lock; 'auto' is the same today — attaching is the CLI's job. */
  role?: 'owner' | 'auto'
  controlHost?: string
  /** 0 (the default) picks a free port and publishes it in the lock. */
  controlPort?: number
  logger?: CoreLogger
}

export const LOCAL_PROVIDER: LocalProviderId = 'llamacpp-upstream'

/**
 * Load options as the control API carries them: the shared ones plus llama.cpp's explicit paths.
 * Without `signal`: a load is cancelled through `AtomicCore.cancelLoad`, and the control route casts
 * a JSON body straight into these options, so a `signal` key arriving there must never be trusted.
 */
export type CoreLoadOptions = Omit<LocalLoadOptions, 'signal'> & Omit<LoadOptions, 'overrides' | 'signal'>
