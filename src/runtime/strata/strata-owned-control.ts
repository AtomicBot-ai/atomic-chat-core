import { setTimeout as delay } from 'node:timers/promises'
import { AtomicCoreError } from '../../contracts/index.js'
import { verifyProcessIdentity } from '../../lock/index.js'
import { FifoLock } from '../shared/index.js'
import type { StrataControlStatus } from './strata-control-plan.js'
import type { StrataControlProcess } from './strata-control-process.js'
import type { StrataProcessInspector } from './strata-process-inspector.js'
import type { StrataLaunchIntent, StrataProcessJournal } from './strata-process-journal.js'

const gone = (verdict: string) => verdict === 'dead' || verdict === 'mismatch'

/** Couples one private Control generation to the durable GPU ownership record. */
export class StrataOwnedControl {
  private readonly lock = new FifoLock()

  constructor(
    private readonly intent: StrataLaunchIntent,
    private readonly journal: StrataProcessJournal,
    private readonly control: Pick<StrataControlProcess, 'start' | 'status' | 'stop'>,
    private readonly inspector: Pick<
      StrataProcessInspector,
      'initialize' | 'snapshot' | 'identify' | 'verify' | 'terminate'
    >,
    private readonly settleMs = 2000
  ) {}

  start(timeoutMs: number, signal?: AbortSignal): Promise<StrataControlStatus> {
    return this.lock.run(async () => {
      signal?.throwIfAborted()
      await this.inspector.initialize()
      await this.journal.begin(this.intent)
      return this.control.start({
        timeoutMs,
        ...(signal ? { signal } : {}),
        register: async (pid) => {
          const startId = await this.inspector.identify(pid)
          await this.journal.observe(this.intent.generation, {
            processes: [{ role: 'launcher', pid, startId }],
          })
        },
      })
    })
  }

  status(): Promise<StrataControlStatus> {
    return this.lock.run(() => this.observeStatus())
  }

  stop(): Promise<boolean> {
    return this.lock.run(() => this.stopTree(false))
  }

  reconcile(currentInstanceId: string, verifyCore = verifyProcessIdentity): Promise<boolean> {
    return this.lock.run(async () => {
      const entry = this.entry()
      if (!entry) return true
      const { core } = entry
      if (core.instanceId === currentInstanceId || !gone(await verifyCore(core.pid, core.startId)))
        return false
      return this.stopTree(true)
    })
  }

  private entry() {
    return this.journal.list().find((item) => item.generation === this.intent.generation)
  }

  private async observeStatus(): Promise<StrataControlStatus> {
    const entry = this.entry()
    if (!entry) throw new AtomicCoreError('GPU_BUSY', 'Strata generation is not registered.')
    const status = await this.control.status({
      ...(entry.ownerId ? { ownerId: entry.ownerId } : {}),
      ...(entry.instanceId ? { instanceId: entry.instanceId } : {}),
    })
    const { processes } = await this.inspector.snapshot()
    if (status.ownerId) {
      const owner = processes.find((p) => p.role === 'owner' && p.pid === status.hostPid)
      if (!owner || (await this.inspector.verify(owner.pid, owner.startId)) !== 'match')
        throw new AtomicCoreError('GPU_BUSY', 'Strata Control owner identity is not confirmed.')
    }
    if (status.state === 'ready') {
      const server = processes.find((p) => p.role === 'server' && p.pid === status.childPid)
      if (!server || (await this.inspector.verify(server.pid, server.startId)) !== 'match')
        throw new AtomicCoreError('MODEL_LOAD_FAILED', 'Strata server identity is not confirmed.')
      const compute = processes.filter((p) => p.role === 'compute')
      if (
        !compute.length ||
        !(await Promise.all(compute.map((p) => this.inspector.verify(p.pid, p.startId)))).includes('match')
      )
        throw new AtomicCoreError('MODEL_LOAD_FAILED', 'Strata compute identity is not confirmed.')
    }
    await this.journal.observe(this.intent.generation, {
      processes,
      ...(status.ownerId ? { ownerId: status.ownerId } : {}),
      ...(status.instanceId ? { instanceId: status.instanceId } : {}),
      ...(status.profileRevision ? { profileRevision: status.profileRevision } : {}),
    })
    return status
  }

  private async stopTree(recover: boolean): Promise<boolean> {
    const entry = this.entry()
    if (!entry) return true
    try {
      // Even if the CLI's abort callback already fired, do not trust an empty receipt set
      // while that CLI can still create an owner.
      for (const launcher of entry.processes.filter((p) => p.role === 'launcher')) {
        if (!gone(await this.inspector.verify(launcher.pid, launcher.startId))) return false
      }
      try {
        const status = await this.observeStatus()
        if (status.ownerId && status.state !== 'stopped' && status.state !== 'stale') {
          await this.control.stop({
            ownerId: status.ownerId,
            ...(status.instanceId ? { instanceId: status.instanceId } : {}),
          })
        }
      } catch {
        // A lost owner can no longer answer. Only scoped receipts can establish its fate.
      }
      if (recover) {
        // End parents first so they cannot start further children while recovering. The
        // inspector revalidates the recorded identity immediately before each signal.
        for (const role of ['owner', 'server', 'compute', 'vision', 'guardian'] as const) {
          const { processes } = await this.inspector.snapshot()
          for (const p of processes.filter((p) => p.role === role)) {
            if ((await this.inspector.verify(p.pid, p.startId)) === 'match')
              await this.inspector.terminate(p.pid, p.startId)
          }
        }
      }
      const deadline = Date.now() + this.settleMs
      for (;;) {
        await this.journal.observe(this.intent.generation, await this.inspector.snapshot())
        if (
          await this.journal.confirmStopped(this.intent.generation, (pid, startId) =>
            this.inspector.verify(pid, startId)
          )
        )
          return true
        if (Date.now() >= deadline) return false
        await delay(100)
      }
    } catch {
      return false
    }
  }
}
