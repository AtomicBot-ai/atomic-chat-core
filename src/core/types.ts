import type { LocalProviderId } from '../contracts/index.js'
import type { LoadOptions } from '../runtime/llamacpp/index.js'
import type { BackendOutputSink, LocalLoadOptions } from '../runtime/index.js'
import type { WireDecisionOptions } from '../decision/index.js'
import type { WireEmbeddingOptions } from '../embedding/index.js'
import type { WireDiffusionOptions } from '../diffusion/index.js'
import type { HardwareProbeResult } from '../hardware/index.js'
import type { Prober, TunnelSpawner, TunnelTimings } from '../remote-access/index.js'
import type { TelemetryControl } from '../telemetry/index.js'

export type CoreLogger = (level: 'info' | 'warn' | 'error', message: string) => void

export type { BackendOutputSink }

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
  /** Test seams of the decision module (a fake engine, installed packs, the `-h` probe). */
  decision?: WireDecisionOptions['overrides']
  /** Test seams of the embedding module (a fake engine, installed packs). */
  embedding?: WireEmbeddingOptions['overrides']
  /** Test seam of the hardware probe: a canned answer instead of the shell tools and sysfs. */
  hardware?: { probe?: () => Promise<HardwareProbeResult> }
  /** The platform runtimes are offered for (macOS-only engines are not registered elsewhere). Test seam. */
  platform?: NodeJS.Platform
  /**
   * Test seam: the docker CLI managed text runtimes run on Linux. Omitted, it is resolved from the
   * system directories (`/usr/bin`, `/usr/local/bin`, `/bin`), never `PATH`; `null` means none.
   */
  dockerPath?: string | null
  /**
   * The host's keyring for the public API (a terminal that hands every client its own key), read for
   * every request: a client must present one of these, and a revoked key is refused on the next
   * request. An empty list refuses every client; `undefined` keeps `server.api_key`.
   */
  publicApiKeys?: () => readonly string[] | undefined
  /**
   * Parallel byte-range streams for a hash-pinned file of at least 32 MiB (at most 4); one when
   * unset. A server without ranges falls back to one stream.
   */
  downloadStreams?: number
  /**
   * How long reading a remote GGUF header for a model check may take in all (a terminal that must not
   * hang on a slow or broken mirror); past it the check goes on without the header. Unset waits.
   */
  remoteGgufTimeoutMs?: number
  fetch?: typeof fetch
  env?: NodeJS.ProcessEnv
  /** 'owner' takes the instance lock; 'auto' is the same today — attaching is the CLI's job. */
  role?: 'owner' | 'auto'
  controlHost?: string
  /** 0 (the default) picks a free port and publishes it in the lock. */
  controlPort?: number
  logger?: CoreLogger
  /**
   * Every stdout/stderr line an engine prints, for the life of its session — llama.cpp (both
   * providers), MLX, Foundation Models and `sd-server`. In addition to whatever `logPath`/`verbose`
   * already route for one load, never instead; without it, engine output goes nowhere new and never
   * reaches `logger`. The app's daemon wires this to its `core.log`. A sink that throws is ignored,
   * after one `warn` through `logger` per engine session.
   * `cloudflared` output never reaches this sink: it carries the remote-access tunnel's public URL.
   */
  backendOutput?: BackendOutputSink
  /**
   * Where failures worth an issue go, and what `/atomic/v1/telemetry` drives. A host that owns its
   * process (the app's daemon, the CLI) builds one with `createCoreReporter` so start-up failures are
   * reported too; otherwise the core builds its own from `telemetry`.
   */
  errorReporter?: TelemetryControl
  /**
   * Error reporting when no `errorReporter` is given: the core reports to its own Sentry project by
   * itself, as `library` unless a `host` name is given. `enabled` is the host's consent; `false`
   * turns reporting off for this core altogether. See docs/decisions/*-the-core-owns-its-error-reporting.md.
   */
  telemetry?: false | { host?: string; hostVersion?: string; enabled?: boolean }
}

export const LOCAL_PROVIDER: LocalProviderId = 'llamacpp-upstream'

/**
 * Load options as the control API carries them: the shared ones plus llama.cpp's explicit paths.
 * Without `signal`: a load is cancelled through `AtomicCore.cancelLoad`, and the control route casts
 * a JSON body straight into these options, so a `signal` key arriving there must never be trusted.
 */
export type CoreLoadOptions = Omit<LocalLoadOptions, 'signal'> & Omit<LoadOptions, 'overrides' | 'signal'>
