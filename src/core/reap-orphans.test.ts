import { describe, expect, it, vi } from 'vitest'
import { createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { ProcessJournal, processStartId, type ChildProcessRecord } from '../lock/index.js'
import { reapOrphans } from './reap-orphans.js'

useCoreHarness()

describe('recovering from a previous owner', () => {
  it('retains a confirmed live entry when the OS refuses termination', async () => {
    const journal = await ProcessJournal.open(data.layout)
    const identity = await processStartId(process.pid)
    expect(identity).toBeTypeOf('string')
    const record: ChildProcessRecord = {
      instance_id: 'previous-owner',
      pid: process.pid,
      process_start_id: identity!,
      exe: '/backends/flm-real',
      provider: 'fastflowlm',
      model_id: 'protected-model',
      port: 3999,
      started_at: new Date().toISOString(),
    }
    await journal.add(record)
    const originalKill = process.kill.bind(process)
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
      if (signal === 0) return originalKill(pid, signal)
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' })
    })
    const log = vi.fn()
    try {
      await reapOrphans(journal, 'new-owner', log)
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM')
      expect(journal.list()).toEqual([record])
      expect((await ProcessJournal.open(data.layout)).list()).toEqual([record])
      expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('until exit can be confirmed'))
    } finally {
      kill.mockRestore()
    }
  })

  it('terminates a backend the dead owner left running and forgets the entry', async () => {
    const { spawn } = await import('node:child_process')
    const { processStartId } = await import('../lock/index.js')
    const orphan = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true })
    await new Promise((r) => setTimeout(r, 150))
    const journal = await ProcessJournal.open(data.layout)
    await journal.add({
      instance_id: 'a-dead-owner',
      pid: orphan.pid as number,
      process_start_id: (await processStartId(orphan.pid as number)) ?? null,
      exe: '/backends/llama-server',
      provider: 'llamacpp-upstream',
      model_id: 'left-behind',
      port: 3999,
      started_at: new Date().toISOString(),
    })

    const { isProcessAlive } = await import('../lock/index.js')
    const pid = orphan.pid as number
    await createCore()
    // The child may already be gone before we can subscribe to 'exit', so poll instead.
    const deadline = Date.now() + 5000
    while (isProcessAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    expect(isProcessAlive(pid)).toBe(false)
    expect((await ProcessJournal.open(data.layout)).list()).toEqual([])
  })
})
