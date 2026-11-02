import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { dataLayout } from '../config/index.js'
import type { ChildProcessRecord } from '../lock/index.js'
import { AudioService } from './service.js'
import { AUDIO_PROVIDER, audioJournal, wireAudio } from './wiring.js'

let dataFolder: string
beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-audio-wiring-'))
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
    add: async (record: ChildProcessRecord) => void records.push(record),
    remove: async (pid: number) => void removed.push(pid),
  }
}

describe('audioJournal', () => {
  it('writes an entry a successor can recognise, under the audio provider', async () => {
    const journal = fakeJournal()
    const adapter = audioJournal(journal, 'instance-1', () => 1_700_000_000_000)
    await adapter.add(process.pid, 4242, '/engine/audiocpp_server', 'kokoro-82m:q8_0')
    expect(journal.records).toEqual([
      {
        instance_id: 'instance-1',
        pid: process.pid,
        process_start_id: expect.any(String),
        exe: '/engine/audiocpp_server',
        provider: 'audio',
        model_id: 'kokoro-82m:q8_0',
        port: 4242,
        started_at: '2023-11-14T22:13:20.000Z',
      },
    ])
    expect(AUDIO_PROVIDER).toBe('audio')
    await adapter.remove(process.pid)
    expect(journal.removed).toEqual([process.pid])
  })
})

describe('wireAudio', () => {
  it('builds a started service over the layout, the seams passed through', async () => {
    const events: string[] = []
    const service = wireAudio({
      layout: dataLayout(dataFolder),
      journal: fakeJournal(),
      instanceId: 'instance-1',
      emit: (name) => void events.push(name),
      log: () => {},
      platform: 'linux',
      env: {},
      claimGpu: async () => {},
      backendOutput: () => {},
      overrides: { idleTickMs: 10, drawSeed: () => 1 },
    })
    expect(service).toBeInstanceOf(AudioService)
    expect((await service.status()).outputDir).toBe(join(dataFolder, 'audios'))
    await service.config({ idleUnloadSecs: 0 })
    expect(events).toEqual(['audio:state'])
    await service.shutdown()
  })
})
