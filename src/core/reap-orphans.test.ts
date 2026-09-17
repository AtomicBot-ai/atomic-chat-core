import { describe, expect, it } from 'vitest'
import { createCore, data, useCoreHarness } from '../../test/helpers/core-harness.js'
import { ProcessJournal } from '../lock/index.js'

useCoreHarness()

describe('recovering from a previous owner', () => {
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
