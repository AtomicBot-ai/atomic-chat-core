import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'
import { AtomicCoreError } from '../../contracts/index.js'
import type { SessionInfo, UnloadResult } from '../../contracts/index.js'
import type { EngineHost } from '../../engine-builds/index.js'
import { FifoLock, loadCancelledError, raceLoadCancel, throwIfLoadCancelled } from '../shared/index.js'
import type {
  EmitFn,
  GpuClaimHook,
  GpuOccupancy,
  LocalLoadOptions,
  LocalRuntime,
  SessionRoutePolicy,
} from '../shared/index.js'
import type { StrataControlStatus } from './strata-control-plan.js'
import type { StrataOwnedControl } from './strata-owned-control.js'

interface Endpoint {
  port: number
  apiKey: string
  close(): Promise<void>
}
export interface StrataRuntimeLaunch {
  build: string
  gpuId: string
  modelPath: string
  logPath?: string
  timeoutMs: number
  owner: Pick<StrataOwnedControl, 'start' | 'status' | 'stop'>
  proveHttp(status: StrataControlStatus, signal: AbortSignal): Promise<boolean>
  expose(): Promise<Endpoint>
  policy?: SessionRoutePolicy
}
interface Options {
  guardLoad?: (modelId: string, work: () => Promise<SessionInfo>) => Promise<SessionInfo>
  stopPreparations?: () => Promise<void>
  buildClaims?: () => string[]
  reconcileRetained?: (modelId: string) => Promise<void>
  retained?: () => readonly { modelId: string; cards: string[]; build?: string }[]
  prepare(
    modelId: string,
    generation: string,
    opts: LocalLoadOptions,
    signal: AbortSignal
  ): Promise<StrataRuntimeLaunch>
  claimGpu?: GpuClaimHook
  emit?: EmitFn
  pollMs?: number
}
interface Held {
  launch: StrataRuntimeLaunch
  occupancy: GpuOccupancy
  endpoint?: Endpoint
  session?: SessionInfo
  closing?: Promise<boolean>
  monitor?: AbortController
}
interface Pending {
  abort: AbortController
  result: Promise<SessionInfo>
}
const busy = () =>
  new AtomicCoreError('GPU_BUSY', 'Strata process exit is unconfirmed. The selected GPU is still held.')

async function startupMemoryError(logPath: string): Promise<AtomicCoreError | undefined> {
  const file = await open(logPath, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await file.stat()
    if (!stat.isFile()) return
    const tail = Buffer.alloc(Math.min(stat.size, 64 * 1024))
    const { bytesRead } = await file.read(tail, 0, tail.length, stat.size - tail.length)
    const log = tail.toString('utf8', 0, bytesRead)
    const vram = /\bnot enough VRAM left for the hybrid experts' buffers and slots\b[^\r\n]*/i.exec(log)?.[0]
    const cudaOom = /\b(?:CUDA (?:error:\s*)?out of memory|cudaMalloc[^\r\n]*\bfailed:\s*out of memory)\b/i
    if (!vram && !cudaOom.test(log)) return
    const amounts = /\b(\d{1,9}) MiB needed, (\d{1,9}) MiB free\b/i.exec(vram ?? '')
    return new AtomicCoreError(
      'OUT_OF_MEMORY',
      'Strata ran out of GPU memory while loading the model.',
      amounts ? `${amounts[1]} MiB needed, ${amounts[2]} MiB free.` : undefined
    )
  } finally {
    await file.close()
  }
}

export class StrataRuntime implements LocalRuntime {
  private readonly exclusive = new FifoLock()
  private readonly held = new Map<string, Held>()
  private readonly pending = new Map<string, Pending>()
  private readonly close = new AbortController()

  constructor(private readonly options: Options) {}

  list(): SessionInfo[] {
    return [...this.held.values()].flatMap((row) => (row.session ? [{ ...row.session }] : []))
  }

  findSession(modelId: string): SessionInfo | undefined {
    const session = this.held.get(modelId)?.session
    return session ? { ...session } : undefined
  }

  getLoadedModels(): string[] {
    return this.list().map((session) => session.model_id)
  }

  isLoading(modelId: string): boolean {
    return this.pending.has(modelId)
  }

  gpuOccupancy(): GpuOccupancy[] {
    return [
      ...[...this.held.values()].map((row) => ({ ...row.occupancy })),
      ...(this.options.retained?.() ?? []).map((row): GpuOccupancy => ({
        model_id: row.modelId,
        cards: row.cards,
        auxiliary: false,
        state: 'stop-unconfirmed',
      })),
    ]
  }

  routePolicy(modelId: string): SessionRoutePolicy | undefined {
    const held = this.held.get(modelId)
    return held?.session ? held.launch.policy : undefined
  }

  engineHost(): EngineHost {
    return {
      exclusive: (fn) => this.exclusive.run(fn),
      inUse: async () => [
        ...new Set([
          ...[...this.held.values()].map((row) => row.launch.build),
          ...(this.options.buildClaims?.() ?? []),
          ...(this.options.retained?.() ?? []).flatMap((row) => (row.build ? [row.build] : [])),
        ]),
      ],
      activate: async (dir, replaced) => {
        if (this.options.retained?.().length || this.options.buildClaims?.().length) throw busy()
        for (const [id, row] of this.held) {
          if ((row.launch.build !== dir || replaced) && !(await this.stop(id, row))) throw busy()
        }
      },
    }
  }

  async load(modelId: string, opts: LocalLoadOptions = {}): Promise<SessionInfo> {
    if (this.close.signal.aborted) throw new AtomicCoreError('CORE_NOT_RUNNING', 'Strata is shutting down.')
    if (opts.signal?.aborted) throw loadCancelledError()
    const session = this.findSession(modelId)
    if (session) return session
    const pending = this.pending.get(modelId)
    if (pending) return { ...(await pending.result) }
    const abort = new AbortController()
    const loadCancel = opts.signal ? AbortSignal.any([abort.signal, opts.signal]) : abort.signal
    const queued = new AbortController()
    const cancelQueued = () => queued.abort()
    loadCancel.addEventListener('abort', cancelQueued, { once: true })
    const work = () => this.start(modelId, opts, abort.signal)
    const turn = this.exclusive.run(() => {
      // A claim can cancel a queued reload of its current occupant and wait for its unload.
      // Once a load starts, cancellation must wait for that load's cleanup.
      loadCancel.removeEventListener('abort', cancelQueued)
      throwIfLoadCancelled(loadCancel)
      return this.options.guardLoad ? this.options.guardLoad(modelId, work) : work()
    })
    const result = raceLoadCancel(turn, queued.signal)
    this.pending.set(modelId, { abort, result })
    try {
      return { ...(await result) }
    } finally {
      this.pending.delete(modelId)
    }
  }

  private async start(modelId: string, opts: LocalLoadOptions, cancel: AbortSignal): Promise<SessionInfo> {
    if (this.held.has(modelId) || this.options.retained?.().some((row) => row.modelId === modelId))
      throw busy()
    const signals = [cancel, this.close.signal, ...(opts.signal ? [opts.signal] : [])]
    const signal = AbortSignal.any(signals)
    const generation = randomBytes(16).toString('hex')
    let row: Held | undefined
    try {
      signal.throwIfAborted()
      if (opts.isEmbedding || opts.exePath || opts.port !== undefined)
        throw new AtomicCoreError(
          'INVALID_ARGUMENT',
          'Strata requires its packaged chat runtime and private ports.'
        )
      const launch = await this.options.prepare(modelId, generation, opts, signal)
      signal.throwIfAborted()
      const occupancy: GpuOccupancy = {
        model_id: modelId,
        cards: [launch.gpuId],
        auxiliary: false,
        state: 'loading',
      }
      const active: Held = { launch, occupancy }
      const hold = () => {
        row = active
        this.held.set(modelId, active)
      }
      if (this.options.claimGpu)
        await this.options.claimGpu(
          { model_id: modelId, cards: occupancy.cards, auxiliary: false, exclusiveCardsOfProvider: true },
          signal,
          hold
        )
      else hold()
      signal.throwIfAborted()
      const deadline = AbortSignal.timeout(launch.timeoutMs)
      const startup = AbortSignal.any([signal, deadline])
      try {
        await launch.owner.start(launch.timeoutMs, startup)
        while (!startup.aborted) {
          const status = await launch.owner.status()
          if (status.state === 'ready' && status.hostPid && (await launch.proveHttp(status, startup))) {
            startup.throwIfAborted()
            active.endpoint = await launch.expose()
            startup.throwIfAborted()
            const session: SessionInfo = {
              pid: status.hostPid,
              port: active.endpoint.port,
              api_key: active.endpoint.apiKey,
              generation,
              model_id: modelId,
              model_path: launch.modelPath,
              is_embedding: false,
            }
            active.session = session
            occupancy.state = 'ready'
            this.options.emit?.('session:started', { ...session, provider: 'strata' })
            const monitor = new AbortController()
            active.monitor = monitor
            void this.monitor(modelId, active, status.instanceId, monitor.signal)
            return session
          }
          if (status.state !== 'ready' && status.state !== 'starting')
            throw new AtomicCoreError('MODEL_LOAD_FAILED', 'Strata stopped before the model was ready.')
          await sleep(this.options.pollMs ?? 350, undefined, { signal: startup })
        }
        startup.throwIfAborted()
        throw new AtomicCoreError('MODEL_LOAD_FAILED', 'Strata did not report readiness.')
      } catch (error) {
        if (deadline.aborted && !signal.aborted)
          throw new AtomicCoreError(
            'MODEL_LOAD_TIMED_OUT',
            'Strata did not become ready within its load timeout.'
          )
        if (
          !startup.aborted &&
          launch.logPath &&
          error instanceof AtomicCoreError &&
          error.code === 'MODEL_LOAD_FAILED'
        ) {
          const memoryError = await startupMemoryError(launch.logPath).catch(() => undefined)
          if (memoryError) throw memoryError
        }
        throw error
      }
    } catch (error) {
      if (row && !(await this.stop(modelId, row))) throw busy()
      if (cancel.aborted || opts.signal?.aborted) throw loadCancelledError()
      if (this.close.signal.aborted) throw new AtomicCoreError('CORE_NOT_RUNNING', 'Strata is shutting down.')
      throw error
    }
  }

  private async monitor(modelId: string, row: Held, instanceId: string | undefined, signal: AbortSignal) {
    try {
      while (!signal.aborted) {
        await sleep(5000, undefined, { signal, ref: false })
        const status = await row.launch.owner.status()
        if (
          status.state === 'ready' &&
          status.instanceId === instanceId &&
          (await row.launch.proveHttp(status, signal))
        )
          continue
        break
      }
    } catch {
      // Treat a lost identity as unusable. Stop confirmation remains a separate check.
    }
    if (!signal.aborted && row.session) {
      const pid = row.session.pid
      delete row.session
      this.options.emit?.('session:died', {
        provider: 'strata',
        model_id: modelId,
        pid,
        exit_code: null,
        signal: null,
        message: 'The Strata runtime no longer reports the loaded instance.',
      })
      await this.stop(modelId, row)
    }
  }

  async unload(modelId: string): Promise<UnloadResult> {
    const pending = this.pending.get(modelId)
    if (pending) {
      pending.abort.abort()
      await pending.result.catch(() => {})
    }
    const row = this.held.get(modelId)
    if (this.options.retained?.().some((entry) => entry.modelId === modelId)) {
      await this.options.reconcileRetained?.(modelId).catch(() => {})
      if (this.options.retained?.().some((entry) => entry.modelId === modelId))
        return { success: false, error: busy().message }
    }
    return !row || (await this.stop(modelId, row))
      ? { success: true }
      : { success: false, error: busy().message }
  }

  private stop(modelId: string, row: Held): Promise<boolean> {
    if (row.closing) return row.closing
    row.monitor?.abort()
    row.occupancy.state = 'stopping'
    const session = row.session
    delete row.session
    row.closing = (async () => {
      try {
        await row.endpoint?.close()
      } catch {
        // Still stop the producer after a gateway close failure.
      }
      delete row.endpoint
      if (session)
        this.options.emit?.('session:unloaded', { provider: 'strata', model_id: modelId, pid: session.pid })
      if (!(await row.launch.owner.stop().catch(() => false))) {
        row.occupancy.state = 'stop-unconfirmed'
        return false
      }
      this.held.delete(modelId)
      return true
    })().finally(() => {
      delete row.closing
    })
    return row.closing
  }

  async autoIncreaseCtx(modelId: string) {
    return {
      ok: false as const,
      reason: this.findSession(modelId) ? ('unsupported' as const) : ('not-loaded' as const),
    }
  }

  async recreateSession(modelId: string) {
    if (!this.findSession(modelId)) return { ok: false as const, reason: 'not-loaded' as const }
    if (!(await this.unload(modelId)).success) throw busy()
    return { ok: true as const, session: await this.load(modelId) }
  }

  async shutdown(): Promise<void> {
    this.close.abort()
    await this.options.stopPreparations?.()
    await Promise.allSettled([...this.pending.values()].map((load) => load.result))
    await Promise.all([...this.held].map(([id, row]) => this.stop(id, row)))
  }
}
