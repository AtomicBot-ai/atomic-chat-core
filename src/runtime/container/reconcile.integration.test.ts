/**
 * End-to-end evidence for reconcile against a fake `docker` binary, for the task brief's two
 * acceptance scenarios (spec `tensorrt-llm-runtime`, "Восстановление контейнеров после перезапуска
 * core"): "осиротевший контейнер после kill -9 core" and "чужой контейнер с меткой". Same style as
 * `integration.test.ts` (a real spawned process standing in for `docker`, driven through
 * `createDockerExec` + `operations.ts`), not `test/e2e/`: nothing wires this module's reconcile call
 * into the compiled binary yet (`core/create.ts`'s TODO next to `reapOrphans`), so a binary-level e2e
 * would only prove the fake binary works, not this module.
 */
import { describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { createDockerExec } from './exec.js'
import { ExecutionJournal } from './execution-journal.js'
import type { ExecutionRecord } from './execution-journal.js'
import { reconcileExecutions } from './reconcile.js'

const record = (over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  container_id: 'orphaned0123456789',
  engine_id: 'tensorrt-llm',
  image_digest: `sha256:${'a'.repeat(64)}`,
  scope: 'app',
  instance_id: 'dead-instance',
  created_at: '2026-09-28T00:00:00.000Z',
  ...over,
})

/**
 * A fake `docker` whose container inventory is fixed at script-build time: `running` answers `inspect`
 * as up, and confirms `stop`/`rm`; everything else answers "no such container", the same stderr shape
 * a real daemon gives back. Standing in for "the host after `kill -9` of a previous core": the
 * container it started is still running, and a foreign container with our labels is on the host too,
 * but was never created by this core (never journalled).
 */
function fakeDockerScript(runningIds: string[]): string {
  return `
    const running = new Set(${JSON.stringify(runningIds)})
    const args = process.argv.slice(1)
    const sub = args[2] // args[0]='--host', args[1]=socket, args[2]=subcommand (or 'container' for inspect)
    const id = args[args.length - 1]
    if (sub === 'container' && args[3] === 'inspect') {
      if (running.has(id)) {
        console.log(JSON.stringify([{ Id: id, State: { Running: true, Status: 'running' } }]))
        process.exit(0)
      }
      console.error('Error: No such container: ' + id)
      process.exit(1)
    }
    if (sub === 'stop') {
      if (running.has(id)) {
        running.delete(id)
        process.exit(0)
      }
      console.error('Error: No such container: ' + id)
      process.exit(1)
    }
    if (sub === 'rm') {
      running.delete(id)
      process.exit(0)
    }
    console.error('fake docker: unrecognized subcommand ' + sub)
    process.exit(1)
  `
}

describe('reconcile end to end against a fake docker binary', () => {
  it('осиротевший контейнер после kill -9 core: stops, removes, and un-journals the previous instance’s still-running container', async () => {
    const data = await makeTmpDataFolder('atomic-core-reconcile-e2e-orphan-')
    try {
      const journal = await ExecutionJournal.open(data.layout)
      await journal.add(record())

      // The container this dead instance started is still running on the host after its kill -9.
      const rawExec = createDockerExec({ dockerPath: process.execPath })
      const exec = (args: string[]) =>
        rawExec(['-e', fakeDockerScript([record().container_id]), '--', ...args])
      const log = vi.fn()

      const result = await reconcileExecutions(journal, 'new-instance', exec, log)

      expect(result.stopped.map((r) => r.container_id)).toEqual([record().container_id])
      expect(result.unconfirmed).toEqual([])
      expect(result.failed).toEqual([])
      expect(journal.list()).toEqual([]) // dropped before the first load can be served
      expect((await ExecutionJournal.open(data.layout)).list()).toEqual([])
      expect(log).toHaveBeenCalledWith('info', expect.stringContaining(record().container_id))
    } finally {
      await data.cleanup()
    }
  })

  it('чужой контейнер с меткой: a labelled container the host is running, but this core never journalled, is left running and untouched', async () => {
    const data = await makeTmpDataFolder('atomic-core-reconcile-e2e-foreign-')
    try {
      const journal = await ExecutionJournal.open(data.layout) // nothing of ours running: empty journal
      const foreignId = 'foreign-labelled-container'

      const rawExec = createDockerExec({ dockerPath: process.execPath })
      // The foreign container answers "running" if asked — proving reconcile never asks about it at all.
      const exec = (args: string[]) => rawExec(['-e', fakeDockerScript([foreignId]), '--', ...args])
      const execSpy = vi.fn(exec)

      const result = await reconcileExecutions(journal, 'new-instance', execSpy, vi.fn())

      expect(result).toEqual({ stopped: [], absent: [], unconfirmed: [], failed: [] })
      expect(execSpy).not.toHaveBeenCalled() // no journal record means no inspect, no stop, ever
    } finally {
      await data.cleanup()
    }
  })
})
