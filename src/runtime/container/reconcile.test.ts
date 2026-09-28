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

    const result = await reconcileExecutions(journal, 'current-instance', exec, noopLog)

    expect(result.stopped.map((r) => r.container_id)).toEqual(['orphan1'])
    expect(result.absent).toEqual([])
    expect(result.unconfirmed).toEqual([])
    expect(journal.list()).toEqual([])
    expect((await ExecutionJournal.open(data.layout)).list()).toEqual([])
  })

  it('never calls the executor for a foreign container that carries our labels but is not in the journal', async () => {
    const journal = await ExecutionJournal.open(data.layout) // empty: nothing journalled
    const exec = vi.fn(async (): Promise<DockerCommandResult> => {
      throw new Error('must never be called: no journalled containers to reconcile')
    })

    const result = await reconcileExecutions(journal, 'current-instance', exec, noopLog)

    expect(result).toEqual({ stopped: [], absent: [], unconfirmed: [] })
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

  it('never touches a record that already belongs to the running instance', async () => {
    const journal = await ExecutionJournal.open(data.layout)
    await journal.add(record({ container_id: 'mine', instance_id: 'current-instance' }))
    const exec = vi.fn(async (): Promise<DockerCommandResult> => {
      throw new Error('must never be called for the current instance')
    })

    const result = await reconcileExecutions(journal, 'current-instance', exec, noopLog)

    expect(result).toEqual({ stopped: [], absent: [], unconfirmed: [] })
    expect(exec).not.toHaveBeenCalled()
    expect(journal.list().map((r) => r.container_id)).toEqual(['mine'])
  })
})
