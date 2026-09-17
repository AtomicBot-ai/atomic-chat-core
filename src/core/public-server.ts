/**
 * The lifecycle of the public `/v1` listener owned by `AtomicCore`: start, stop and state, the option
 * normalization that makes an identical start idempotent, and the published state files.
 *
 * It is a separate, optional listener whose stop must never take control down with it.
 *
 * It also keeps the remote-access tunnel honest about it: a public URL must never point at a port
 * that has stopped, or at whatever binds that port next. So a stop ends the tunnel *first*, a
 * genuine start ends any tunnel that survived (it pointed at the previous port), and a repeated
 * start that changes nothing leaves the tunnel alone.
 */

import { writeFile } from 'node:fs/promises'
import { AtomicCoreError } from '../contracts/index.js'
import type { LocalApiServerState } from '../contracts/index.js'
import type { DataLayout } from '../config/index.js'
import type { CoreEmitter } from '../events/index.js'
import {
  DEFAULT_PROXY_TIMEOUT_SECS,
  DEFAULT_PUBLIC_HOST,
  DEFAULT_PUBLIC_PORT,
  DEFAULT_PUBLIC_PREFIX,
  PublicServer,
  markServerRunning,
  markServerStopped,
  normalizePrefix,
  stoppedState,
} from '../server/index.js'
import type { PublicServerDeps } from '../server/index.js'
import { dialOrigin } from '../remote-access/index.js'
import type { ServerEndpoint } from '../remote-access/index.js'
import type { CoreLogger } from './types.js'

export interface PublicServerStartOptions {
  host?: string
  port?: number
  prefix?: string
  apiKey?: string
  trustedHosts?: string[]
  proxyTimeoutSecs?: number
  /**
   * Write the app's `<data>/local-api-server.json` while this server runs. Only the owner of the
   * public API writes that file, so the app asks for this when it hands the server to the core, and
   * a core serving on its own leaves the app's file alone.
   */
  writeStateFile?: boolean
  /** Take a free port when the requested one cannot be bound (the app's behaviour); see `PublicServer`. */
  fallbackPort?: boolean
}

interface NormalizedPublicServerOptions {
  host: string
  port: number
  prefix: string
  apiKey: string
  trustedHosts: string[]
  proxyTimeoutSecs: number
  writeStateFile: boolean
  fallbackPort: boolean
  /** What was asked for, which a port fallback may have replaced. */
  requestedPort?: number
}

export interface PublicServerLifecycleDeps {
  layout: DataLayout
  events: CoreEmitter
  log: CoreLogger
  /** Throws once the owning core is stopping; checked again inside the serialized transition. */
  assertRunning: () => void
  /** What the listener routes to, built for each start. */
  serverDeps: () => PublicServerDeps
  /** The tunnel in front of this listener: ended before a stop, re-announced after every transition. */
  remoteAccess?: { stop: () => Promise<unknown>; announce: () => void }
}

/** Owns the public listener and serializes its start/stop transitions. */
export class PublicServerLifecycle {
  private publicServer: PublicServer | undefined
  private lastPublicState: LocalApiServerState = stoppedState()
  private publicConfig: NormalizedPublicServerOptions | undefined
  private publicTransition: Promise<void> = Promise.resolve()
  private stopping = false

  constructor(private readonly deps: PublicServerLifecycleDeps) {}

  state(): LocalApiServerState {
    return this.publicServer ? this.publicServer.state() : { ...this.lastPublicState }
  }

  /**
   * Where a tunnel would point: the *bound* port (a fallback can change it) and a host that really
   * listens. `undefined` while there is no listener — and already while one is stopping, so nothing
   * new is pointed at a port that is about to go.
   */
  endpoint(): ServerEndpoint | undefined {
    if (!this.publicServer || !this.publicConfig || this.stopping) return undefined
    return {
      origin: dialOrigin(this.publicServer.host, this.publicServer.port),
      hasApiKey: this.publicConfig.apiKey !== '',
    }
  }

  /** Start the public listener; an identical start is idempotent, an incompatible one is a conflict. */
  start(options: PublicServerStartOptions): Promise<LocalApiServerState> {
    return this.withPublicTransition(async () => {
      this.deps.assertRunning()
      const requested = normalizePublicOptions(options)
      if (this.publicServer && this.publicConfig) {
        if (publicOptionsCompatible(this.publicConfig, requested, options.port))
          return this.publicServer.state()
        throw new AtomicCoreError(
          'CORE_ALREADY_RUNNING',
          'The public API server is already running with a different configuration.',
          `${this.publicServer.host}:${this.publicServer.port}${this.publicServer.prefix}`
        )
      }
      const server = await PublicServer.start(this.deps.serverDeps(), options).catch((e: unknown) => {
        const error = e as AtomicCoreError
        this.deps.events.emit('server:bind-failed', { port: options.port ?? 0, error: error.message })
        throw error
      })
      // A tunnel that survived until here pointed at the previous listener's port.
      await this.deps.remoteAccess?.stop().catch(() => {})
      this.publicServer = server
      this.publicConfig = { ...requested, port: server.port, requestedPort: requested.port }
      this.lastPublicState = server.state()
      await this.publishServerState(server.state())
      if (requested.writeStateFile) {
        await markServerRunning(
          this.deps.layout.serverStateFile,
          {
            host: server.host,
            port: server.port,
            prefix: server.prefix,
            requiresApiKey: requested.apiKey !== '',
          },
          (message) => this.deps.log('warn', message)
        )
      }
      this.deps.events.emit('server:started', { host: server.host, port: server.port })
      this.deps.log('info', `public API on ${server.url}`)
      this.deps.remoteAccess?.announce()
      return server.state()
    })
  }

  /** Stop the listener after any transition in flight; a stopped listener reports its last state. */
  stop(): Promise<LocalApiServerState> {
    return this.withPublicTransition(() => this.stopPublicServerNow())
  }

  private async stopPublicServerNow(): Promise<LocalApiServerState> {
    if (!this.publicServer) return this.state()
    const wroteStateFile = this.publicConfig?.writeStateFile === true
    // The tunnel first: otherwise its public URL points at a dead port, or at whatever binds it next.
    this.stopping = true
    try {
      await this.deps.remoteAccess?.stop().catch(() => {})
      this.lastPublicState = stoppedState(this.publicServer.state())
      await this.publicServer.close()
    } finally {
      this.stopping = false
    }
    this.publicServer = undefined
    this.publicConfig = undefined
    await this.publishServerState(this.lastPublicState)
    if (wroteStateFile)
      await markServerStopped(this.deps.layout.serverStateFile, (message) => this.deps.log('warn', message))
    this.deps.events.emit('server:stopped', {})
    this.deps.remoteAccess?.announce()
    return { ...this.lastPublicState }
  }

  /**
   * Publish where the public API is, for clients that have no control token — `server status` and
   * the app. This is the core's own copy; the app's `<data>/local-api-server.json` is written only
   * when the app handed the server over (`writeStateFile`), so there is always one writer of it.
   */
  private async publishServerState(state: LocalApiServerState): Promise<void> {
    await writeFile(this.deps.layout.core.publicServerState, `${JSON.stringify(state, null, 2)}\n`).catch(
      (e: Error) => this.deps.log('warn', `could not publish the public server state: ${e.message}`)
    )
  }

  private withPublicTransition<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.publicTransition.then(operation, operation)
    this.publicTransition = result.then(
      () => {},
      () => {}
    )
    return result
  }
}

function normalizePublicOptions(options: PublicServerStartOptions): NormalizedPublicServerOptions {
  return {
    host: options.host ?? DEFAULT_PUBLIC_HOST,
    port: options.port ?? DEFAULT_PUBLIC_PORT,
    prefix: normalizePrefix(options.prefix ?? DEFAULT_PUBLIC_PREFIX),
    apiKey: options.apiKey ?? '',
    trustedHosts: [...(options.trustedHosts ?? [])].sort(),
    proxyTimeoutSecs: options.proxyTimeoutSecs ?? DEFAULT_PROXY_TIMEOUT_SECS,
    writeStateFile: options.writeStateFile ?? false,
    fallbackPort: options.fallbackPort ?? false,
  }
}

function publicOptionsCompatible(
  current: NormalizedPublicServerOptions,
  requested: NormalizedPublicServerOptions,
  requestedPort: number | undefined
): boolean {
  // A server that fell back to a free port still answers a repeat of the request that put it there.
  const portMatches =
    requestedPort === 0 || current.port === requested.port || current.requestedPort === requested.port
  return (
    portMatches &&
    current.host === requested.host &&
    current.prefix === requested.prefix &&
    current.apiKey === requested.apiKey &&
    current.proxyTimeoutSecs === requested.proxyTimeoutSecs &&
    current.writeStateFile === requested.writeStateFile &&
    current.trustedHosts.length === requested.trustedHosts.length &&
    current.trustedHosts.every((host, index) => host === requested.trustedHosts[index])
  )
}
