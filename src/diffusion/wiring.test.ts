import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { ChildProcessRecord } from '../lock/index.js'
import { DiffusionService } from './service.js'
import { diffusionJournal, wireDiffusion } from './wiring.js'

let dataFolder: string
beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-diffusion-wiring-'))
})
afterEach(async () => {
  await rm(dataFolder, { recursive: true, force: true })
})

function fakeJournal() {
  const records: ChildProcessRecord[] = []
  const removed: number[] = []
  return {
    records,
    removed,
    add: async (record: ChildProcessRecord) => {
      records.push(record)
    },
    remove: async (pid: number) => {
      removed.push(pid)
    },
  }
}

describe('diffusionJournal', () => {
  it('writes an entry a successor can recognise, under the diffusion provider', async () => {
    const journal = fakeJournal()
    const adapter = diffusionJournal(journal, 'instance-1', () => 1_700_000_000_000)
    await adapter.add(process.pid, 4242, '/engine/sd-server', 'z-image:q4_k_m')
    expect(journal.records).toEqual([
      {
        instance_id: 'instance-1',
        pid: process.pid,
        process_start_id: expect.any(String),
        exe: '/engine/sd-server',
        provider: 'diffusion',
        model_id: 'z-image:q4_k_m',
        port: 4242,
        started_at: '2023-11-14T22:13:20.000Z',
      },
    ])
    // A pid that is gone gets no start identity, and is still journalled.
    await adapter.add(2 ** 22 - 1, 1, '/x', 'm')
    expect(journal.records[1]?.process_start_id).toBeNull()
    await adapter.remove(process.pid)
    expect(journal.removed).toEqual([process.pid])
  })
})

describe('wireDiffusion', () => {
  it('builds a started service on the layout with the owner facts', async () => {
    const journal = fakeJournal()
    const events: string[] = []
    const service = wireDiffusion({
      layout: dataLayout(dataFolder),
      journal,
      instanceId: 'instance-2',
      emit: (name) => events.push(name),
      log: () => {},
      platform: process.platform,
      env: {},
      overrides: { idleTickMs: 10 },
    })
    expect(service).toBeInstanceOf(DiffusionService)
    const status = await service.configure({ dataFolder })
    expect(status.configured).toBe(true)
    expect(status.outputDir).toBe(join(dataFolder, 'images'))
    await service.setOutputDir('')
    expect(events).toEqual(['diffusion:state'])
    await service.shutdown()

    // The owner's facts are optional: the host's platform and environment are the defaults.
    const bare = wireDiffusion({
      layout: dataLayout(dataFolder),
      journal,
      instanceId: 'i',
      emit: () => {},
      log: () => {},
    })
    expect((await bare.getStatus()).configured).toBe(false)
    await bare.shutdown()
  })
})
