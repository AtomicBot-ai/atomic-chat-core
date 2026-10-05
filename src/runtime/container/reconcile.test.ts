import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { ExecutionJournal } from './execution-journal.js'
import type { ExecutionRecord } from './execution-journal.js'
import { reconcileExecutions } from './reconcile.js'
import type { DockerCommandResult, DockerExec } from './types.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-reconcile-')
})
afterEach(() => data.cleanup())

const record = (over: Partial<ExecutionRecord> = {}): ExecutionRecord => ({
  container_id: 'orphan1',
  engine_id: 'tensorrt-llm',
  image_digest: `sha256:${'a'.repeat(64)}`,
  scope: 'app',
  instance_id: 'dead-instance',
  created_at: '2026-09-28T00:00:00.000Z',
  ...over,
})

const ok = (stdout = ''): DockerCommandResult => ({ code: 0, stdout, stderr: '' })
const absent = (): DockerCommandResult => ({
  code: 1,
  stdout: '',
  stderr: 'Error: No such container: gone\n',
})

/** A fake docker whose behaviour is keyed by container id (the last argv token) and subcommand. */
function fakeExecFor(
  behaviors: Record<
    string,
    { inspect?: DockerCommandResult; stop?: DockerCommandResult; rm?: DockerCommandResult }
  >
): DockerExec {
  return vi.fn(async (args: string[]) => {
    const containerId = args[args.length - 1] as string
    const behavior = behaviors[containerId]
    if (!behavior) throw new Error(`fakeExecFor: no behavior configured for container id ${containerId}`)
    if (args.includes('inspect')) return behavior.inspect ?? ok('[]')
    if (args.includes('stop')) return behavior.stop ?? ok()
    if (args.includes('rm')) return behavior.rm ?? ok()
    throw new Error(`fakeExecFor: unrecognized argv ${JSON.stringify(args)}`)
  })
}

const noopLog = () => {}

describe('reconcileExecutions', () => {
  it('stops and removes a running orphan left by a dead instance, and drops its record', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record())
    const exec = fakeExecFor({
      orphan1: { inspect: ok(JSON.stringify([{ Id: 'orphan1', State: { Running: true } }])), stop: ok() },
    })
    const log = vi.fn()

    const result = await reconcileExecutions(journal, 'current-instance', exec, log)

    expect(result.stopped.map((r) => r.container_id)).toEqual(['orphan1'])
    expect(result.absent).toEqual([])
    expect(result.unconfirmed).toEqual([])
    expect(result.failed).toEqual([])
    expect(journal.list()).toEqual([])
    expect((await ExecutionJournal.open(data.layout)).list()).toEqual([])
    // A successful stop+remove is routine, not a warning: only an unconfirmed stop or a thrown error is.
    expect(log).toHaveBeenCalledWith('info', expect.stringContaining('orphan1'))
    expect(log).not.toHaveBeenCalledWith('warn', expect.anything())
  })

  it('never calls the executor for a foreign container that carries our labels but is not in the journal', async () => {
    const journal = await ExecutionJournal.open(data.layout) // empty: nothing journalled
    const exec = vi.fn(async (): Promise<DockerCommandResult> => {
      throw new Error('must never be called: no journalled containers to reconcile')
    })

    const result = await reconcileExecutions(journal, 'current-instance', exec, noopLog)

    expect(result).toEqual({ stopped: [], absent: [], unconfirmed: [], failed: [], skipped: [] })
    expect(exec).not.toHaveBeenCalled()
  })

  it('drops the record of a container that is already gone, without calling stop or rm', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'gone' }))
    const exec = fakeExecFor({ gone: { inspect: absent() } })

    const result = await reconcileExecutions(journal, 'current-instance', exec, noopLog)

    expect(result.absent.map((r) => r.container_id)).toEqual(['gone'])
    expect(journal.list()).toEqual([])
  })

  it('keeps the record and reports it when the stop cannot be confirmed', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'stuck' }))
    const exec = fakeExecFor({
      stuck: {
        inspect: ok(JSON.stringify([{ Id: 'stuck', State: { Running: true } }])),
        stop: { code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon' },
      },
    })
    const log = vi.fn()

    const result = await reconcileExecutions(journal, 'current-instance', exec, log)

    expect(result.unconfirmed.map((r) => r.container_id)).toEqual(['stuck'])
    expect(journal.list().map((r) => r.container_id)).toEqual(['stuck'])
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('stuck'))
  })

  it('keeps the record and continues with the rest of the journal when inspect throws for one record', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'throws' }))
    await journal.add(record({ container_id: 'orphan1' })) // a second, healthy record after the failing one
    const exec = vi.fn(async (args: string[]): Promise<DockerCommandResult> => {
      const containerId = args[args.length - 1] as string
      if (containerId === 'throws') throw new Error('Cannot connect to the Docker daemon')
      if (args.includes('inspect')) return ok(JSON.stringify([{ Id: containerId, State: { Running: true } }]))
      return ok()
    })
    const log = vi.fn()

    const result = await reconcileExecutions(journal, 'current-instance', exec, log)

    expect(result.failed.map((r) => r.container_id)).toEqual(['throws'])
    expect(result.stopped.map((r) => r.container_id)).toEqual(['orphan1']) // the rest of the journal still ran
    expect(journal.list().map((r) => r.container_id)).toEqual(['throws']) // the failed record is kept
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('throws'))
  })

  it('keeps the record and continues with the rest of the journal when removeContainer throws for one record', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'rm-throws' }))
    await journal.add(record({ container_id: 'orphan1' }))
    const exec = vi.fn(async (args: string[]): Promise<DockerCommandResult> => {
      const containerId = args[args.length - 1] as string
      if (args.includes('inspect')) return ok(JSON.stringify([{ Id: containerId, State: { Running: true } }]))
      if (args.includes('stop')) return ok()
      if (args.includes('rm') && containerId === 'rm-throws')
        throw new Error('Cannot connect to the Docker daemon')
      return ok()
    })
    const log = vi.fn()

    const result = await reconcileExecutions(journal, 'current-instance', exec, log)

    expect(result.failed.map((r) => r.container_id)).toEqual(['rm-throws'])
    expect(result.stopped.map((r) => r.container_id)).toEqual(['orphan1'])
    expect(
      journal
        .list()
        .map((r) => r.container_id)
        .sort()
    ).toEqual(['rm-throws']) // kept, not dropped
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining('rm-throws'))
  })

  it("one record's journal.remove failing (a real disk error, not a thrown docker call) leaves later records' removals intact", async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'rm-fails-on-disk' }))
    await journal.add(record({ container_id: 'orphan1' }))
    // Occupy the first record's own on-disk path with a directory, so journal.remove() itself throws
    // when reconcile reaches it (docker's own `rm` succeeds fine — this is a filesystem failure, not
    // a docker one). Before the round-2 fix, this alone would poison the journal's write queue and
    // silently skip orphan1's later journal.remove() too.
    const path = join(data.layout.managed.executionsDir, 'rm-fails-on-disk.json')
    await rm(path, { force: true })
    await mkdir(path, { recursive: true })

    const exec = fakeExecFor({
      'rm-fails-on-disk': {
        inspect: ok(JSON.stringify([{ Id: 'rm-fails-on-disk', State: { Running: true } }])),
        stop: ok(),
      },
      'orphan1': { inspect: ok(JSON.stringify([{ Id: 'orphan1', State: { Running: true } }])), stop: ok() },
    })
    const log = vi.fn()

    const result = await reconcileExecutions(journal, 'current-instance', exec, log)

    expect(result.failed.map((r) => r.container_id)).toEqual(['rm-fails-on-disk'])
    expect(result.stopped.map((r) => r.container_id)).toEqual(['orphan1'])
    expect(journal.list().map((r) => r.container_id)).toEqual(['rm-fails-on-disk']) // kept: never persisted
    // orphan1's own removal actually reached disk, proving the earlier failure did not poison the
    // queue (rm-fails-on-disk's own reopened state is not asserted here: its path is a directory by
    // this test's own construction, which a reopen can never read back as a valid record regardless).
    expect((await ExecutionJournal.open(data.layout)).list().map((r) => r.container_id)).not.toContain(
      'orphan1'
    )
  })

  it('never touches a record that already belongs to the running instance', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'mine', instance_id: 'current-instance' }))
    const exec = vi.fn(async (): Promise<DockerCommandResult> => {
      throw new Error('must never be called for the current instance')
    })

    const result = await reconcileExecutions(journal, 'current-instance', exec, noopLog)

    expect(result).toEqual({ stopped: [], absent: [], unconfirmed: [], failed: [], skipped: [] })
    expect(exec).not.toHaveBeenCalled()
    expect(journal.list().map((r) => r.container_id)).toEqual(['mine'])
  })

  it('stops at the first record after its signal aborts, leaving the rest journalled and reported as skipped (review 2.12 round 1)', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'orphan1' }))
    await journal.add(record({ container_id: 'orphan2' }))
    const controller = new AbortController()
    const base = fakeExecFor({ orphan1: { inspect: absent() }, orphan2: { inspect: absent() } })
    const exec: DockerExec = async (args, options) => {
      controller.abort() // the startup budget runs out while the first record is being handled
      return base(args, options)
    }
    const log = vi.fn()
    const result = await reconcileExecutions(journal, 'current-instance', exec, log, 10, controller.signal)
    expect(result.absent).toHaveLength(1)
    expect(result.skipped).toHaveLength(1)
    expect(journal.list()).toEqual([result.skipped[0]])
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining(result.skipped[0]!.container_id))
  })
})
