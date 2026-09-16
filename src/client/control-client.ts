/**
 * Browser-safe client of the control API (`/atomic/v1`). The CLI uses it over plain `fetch`; the
 * Tauri adapter will hand it an `invoke`-backed transport so the control token never enters the
 * webview (PLAN.md §3.6). No `node:*` may appear in this folder.
 *
 * Every failure comes back as `AtomicCoreError` with the code the core sent, so callers branch on
 * the same strings whether the core is in-process or across a socket.
 */

import { AtomicCoreError, CONTROL_API_PREFIX, CONTROL_PROTOCOL_VERSION } from '../contracts/index.js'
import type {
  CoreEventName,
  ErrorCode,
  LocalApiServerState,
  SessionInfo,
  UnloadResult,
} from '../contracts/index.js'

export interface CoreClientOptions {
  baseUrl: string
  token: string
  fetch?: typeof fetch
  /** Identify this client in `clients` and in the core's logs. */
  name?: string
}

export interface ClientRegistration {
  client: { id: string; name: string; pid: number | null }
  heartbeat_interval_ms: number
  snapshot: CoreSnapshot
}

export interface CoreSnapshot {
  instance_id: string
  protocol: number
  version: string
  pid: number
  data_folder: string
  cursor: string
  sessions: Array<SessionInfo & { provider: string }>
  server: LocalApiServerState
  clients: Array<{ id: string; name: string; pid: number | null }>
  downloads: unknown[]
}

export interface CoreEventMessage {
  id: string
  event: CoreEventName | 'resync'
  data: unknown
}

export class CoreClient {
  private readonly fetchImpl: typeof fetch
  readonly baseUrl: string

  constructor(private readonly options: CoreClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.fetchImpl = options.fetch ?? fetch
  }

  private url(path: string): string {
    return `${this.baseUrl}${CONTROL_API_PREFIX}${path}`
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response
    try {
      res = await this.fetchImpl(this.url(path), {
        ...init,
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.headers ?? {}),
        },
      })
    } catch (e) {
      throw new AtomicCoreError(
        'CORE_NOT_RUNNING',
        'Cannot reach the Atomic Chat core.',
        (e as Error).message
      )
    }
    const text = await res.text()
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
    if (!res.ok) throw errorFromBody(body, res.status)
    return body as T
  }

  health(): Promise<{ ok: true; pid: number; version: string; instance_id: string; protocol: number }> {
    return this.call('/health')
  }

  snapshot(): Promise<CoreSnapshot> {
    return this.call('/snapshot')
  }

  /** Refuse an owner we cannot speak to, instead of failing later on a route it does not have. */
  async handshake(): Promise<CoreSnapshot> {
    const snapshot = await this.snapshot()
    if (snapshot.protocol !== CONTROL_PROTOCOL_VERSION) {
      throw new AtomicCoreError(
        'CORE_PROTOCOL_MISMATCH',
        'The running Atomic Chat core speaks a different control protocol.',
        `core protocol ${snapshot.protocol} (version ${snapshot.version}), this build expects ${CONTROL_PROTOCOL_VERSION}`
      )
    }
    return snapshot
  }

  register(pid?: number): Promise<ClientRegistration> {
    return this.call('/clients', {
      method: 'POST',
      body: JSON.stringify({ name: this.options.name ?? 'atomic-chat-core client', pid: pid ?? null }),
    })
  }

  heartbeat(clientId: string): Promise<{ ok: true }> {
    return this.call(`/clients/${encodeURIComponent(clientId)}/heartbeat`, { method: 'POST' })
  }

  unregister(clientId: string): Promise<{ ok: true }> {
    return this.call(`/clients/${encodeURIComponent(clientId)}`, { method: 'DELETE' })
  }

  sessions(): Promise<{ sessions: Array<SessionInfo & { provider: string }> }> {
    return this.call('/sessions')
  }

  async loadModel(
    provider: string,
    modelId: string,
    body: Record<string, unknown> = {}
  ): Promise<SessionInfo> {
    return (await this.acquireModel(provider, modelId, body)).session
  }

  /** Load or attach, while preserving whether this request created the session. */
  async acquireModel(
    provider: string,
    modelId: string,
    body: Record<string, unknown> = {}
  ): Promise<{ session: SessionInfo; created: boolean }> {
    return this.call<{ session: SessionInfo; created: boolean }>(`/models/${provider}/${modelId}/load`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  }

  unloadModel(provider: string, modelId: string): Promise<UnloadResult> {
    return this.call(`/models/${provider}/${modelId}/unload`, { method: 'POST' })
  }

  serverStatus(): Promise<LocalApiServerState> {
    return this.call('/server')
  }

  startServer(options: {
    host?: string
    port?: number
    prefix?: string
    api_key?: string
  }): Promise<LocalApiServerState> {
    return this.call('/server/start', { method: 'POST', body: JSON.stringify(options) })
  }

  stopServer(): Promise<LocalApiServerState> {
    return this.call('/server/stop', { method: 'POST' })
  }

  shutdown(options: { force?: boolean; client_id?: string } = {}): Promise<{ ok: true }> {
    return this.call('/shutdown', { method: 'POST', body: JSON.stringify(options) })
  }

  /**
   * Subscribe to the event stream. Resolves when the stream ends; `onEvent` sees each frame,
   * including the `resync` the core sends when a cursor is too old to replay.
   */
  async events(
    onEvent: (message: CoreEventMessage) => void,
    options: { cursor?: string; signal?: AbortSignal; onOpen?: () => void } = {}
  ): Promise<void> {
    const res = await this.fetchImpl(
      this.url(`/events${options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : ''}`),
      {
        headers: { authorization: `Bearer ${this.options.token}`, accept: 'text/event-stream' },
        ...(options.signal ? { signal: options.signal } : {}),
      }
    )
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '')
      throw errorFromBody(text ? (JSON.parse(text) as Record<string, unknown>) : {}, res.status)
    }
    options.onOpen?.()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      let split = buffer.indexOf('\n\n')
      while (split >= 0) {
        const frame = buffer.slice(0, split)
        buffer = buffer.slice(split + 2)
        const message = parseFrame(frame)
        if (message) onEvent(message)
        split = buffer.indexOf('\n\n')
      }
    }
  }
}

function parseFrame(frame: string): CoreEventMessage | undefined {
  let id = ''
  let event = ''
  const dataLines: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue // heartbeat comment
    if (line.startsWith('id:')) id = line.slice(3).trim()
    else if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!event) return undefined
  let data: unknown
  try {
    data = dataLines.length ? JSON.parse(dataLines.join('\n')) : undefined
  } catch {
    data = dataLines.join('\n')
  }
  return { id, event: event as CoreEventMessage['event'], data }
}

function errorFromBody(body: Record<string, unknown>, status: number): AtomicCoreError {
  const error = body['error'] as { code?: string; message?: string; details?: string } | undefined
  return new AtomicCoreError(
    (error?.code as ErrorCode) ?? 'INTERNAL_ERROR',
    error?.message ?? `The core answered ${status}.`,
    error?.details
  )
}
