import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { processStartEpoch } from './process-identity.js'
import {
  assertNotLoadedByLegacy,
  LEGACY_RUNTIME_FILE,
  legacySessionFor,
  parseLegacyRuntimeState,
  readLegacyRuntime,
} from './legacy-guard.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-legacy-')
})
afterEach(() => data.cleanup())

const publish = (state: unknown) =>
  writeFile(join(data.layout.core.dir, LEGACY_RUNTIME_FILE), JSON.stringify(state))

const liveApp = (sessions: unknown[] = []) => ({
  pid: process.pid,
  updated_at: 1_700_000_000,
  provider: 'llamacpp-upstream',
  sessions,
})

const session = (model_id: string, port = 3001) => ({ model_id, port, pid: 4242, is_embedding: false })

describe('readLegacyRuntime', () => {
  it('reports what a live app holds', async () => {
    await publish(liveApp([session('demo', 3311)]))
    const state = await readLegacyRuntime(data.layout)
    expect(state?.pid).toBe(process.pid)
    expect(state?.sessions).toEqual([{ model_id: 'demo', port: 3311, pid: 4242, is_embedding: false }])
  })

  it('ignores a table left by an app that is gone', async () => {
    await publish({ ...liveApp([session('demo')]), pid: 999_999 })
    expect(await readLegacyRuntime(data.layout, { alive: () => false })).toBeUndefined()
  })

  it('rejects a reused PID but fails closed when start identity cannot be probed', async () => {
    await publish({ ...liveApp([session('demo')]), owner_start_id: 'epoch:10' })
    expect(
      await readLegacyRuntime(data.layout, { alive: () => true, startId: async () => 'epoch:11' })
    ).toBeUndefined()
    expect(
      await readLegacyRuntime(data.layout, { alive: () => true, startId: async () => undefined })
    ).toMatchObject({ owner_start_id: 'epoch:10' })
    expect(
      await readLegacyRuntime(data.layout, { alive: () => true, startId: async () => 'epoch:10' })
    ).toMatchObject({ owner_start_id: 'epoch:10' })
  })

  it('uses the production cross-language identity probe', async () => {
    const owner_start_id = await processStartEpoch(process.pid)
    await publish({ ...liveApp(), owner_start_id })
    await expect(readLegacyRuntime(data.layout)).resolves.toMatchObject({ owner_start_id })
  })

  it('treats a missing, malformed or foreign file as nothing held', async () => {
    expect(await readLegacyRuntime(data.layout)).toBeUndefined()
    await writeFile(join(data.layout.core.dir, LEGACY_RUNTIME_FILE), '{ not json')
    expect(await readLegacyRuntime(data.layout)).toBeUndefined()
    await publish({ sessions: [] })
    expect(await readLegacyRuntime(data.layout), 'no pid means nothing to trust').toBeUndefined()
  })

  it('drops session entries that are not sessions', async () => {
    await publish(liveApp([session('good'), 5, null, { port: 1 }]))
    const state = await readLegacyRuntime(data.layout)
    expect(state?.sessions.map((s) => s.model_id)).toEqual(['good'])
  })
})

describe('parseLegacyRuntimeState', () => {
  it('fills defaults for the fields it can do without', () => {
    expect(parseLegacyRuntimeState('{"pid":7}')).toEqual({
      pid: 7,
      updated_at: 0,
      provider: 'llamacpp-upstream',
      sessions: [],
    })
    expect(parseLegacyRuntimeState('[]')).toBeUndefined()
    expect(parseLegacyRuntimeState('null')).toBeUndefined()
  })
})

describe('assertNotLoadedByLegacy', () => {
  it('refuses a model the app already holds, naming where it is served', async () => {
    await publish(liveApp([session('demo', 3311)]))
    await expect(assertNotLoadedByLegacy(data.layout, 'demo')).rejects.toMatchObject({
      code: 'CORE_ALREADY_RUNNING',
      message: expect.stringContaining('"demo"') as unknown as string,
      details: expect.stringContaining('127.0.0.1:3311') as unknown as string,
    })
  })

  it('allows a different model, and anything at all once the app is gone', async () => {
    await publish(liveApp([session('demo')]))
    await expect(assertNotLoadedByLegacy(data.layout, 'other')).resolves.toBeUndefined()
    await expect(
      assertNotLoadedByLegacy(data.layout, 'demo', { alive: () => false })
    ).resolves.toBeUndefined()
  })

  it('allows everything when the app never published a table', async () => {
    await expect(assertNotLoadedByLegacy(data.layout, 'demo')).resolves.toBeUndefined()
  })
})

describe('legacySessionFor', () => {
  it('finds a model in a table and tolerates no table at all', () => {
    const state = { pid: 1, updated_at: 0, provider: 'x', sessions: [session('a'), session('b')] }
    expect(legacySessionFor(state, 'b')?.model_id).toBe('b')
    expect(legacySessionFor(state, 'c')).toBeUndefined()
    expect(legacySessionFor(undefined, 'a')).toBeUndefined()
  })
})
