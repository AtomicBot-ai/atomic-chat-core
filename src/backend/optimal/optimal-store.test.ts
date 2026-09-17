import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { OptimalBackendStore } from './optimal-store.js'
import type { OptimalBackendCacheRecord } from '../types.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-optimal-')
})
afterEach(() => data.cleanup())

const record: OptimalBackendCacheRecord = {
  schemaVersion: 1,
  provider: 'llamacpp-upstream',
  detectedAt: 1,
  detectionKind: 'cpu-optimal',
  currentBackend: 'b1/macos-arm64',
  recommendedCategory: 'CPU',
}

describe('OptimalBackendStore', () => {
  it('starts empty and publishes only a durable update', async () => {
    const changes: unknown[] = []
    const store = await OptimalBackendStore.open(data.layout.core.optimalBackend, (_provider, state) =>
      changes.push(state)
    )
    expect(store.get('llamacpp-upstream')).toEqual({ revision: 0, optimal: null })
    expect(await store.set('llamacpp-upstream', record, 0)).toEqual({
      status: 'updated',
      current: { revision: 1, optimal: record },
    })
    expect(changes).toEqual([{ revision: 1, optimal: record }])
    expect(store.snapshot()['llamacpp-upstream']).toEqual({ revision: 1, optimal: record })
    expect(
      (await OptimalBackendStore.open(data.layout.core.optimalBackend)).get('llamacpp-upstream')
    ).toEqual({ revision: 1, optimal: record })
  })

  it('serializes simultaneous writes and refuses an obsolete revision', async () => {
    const store = await OptimalBackendStore.open(data.layout.core.optimalBackend)
    const outcomes = await Promise.all([
      store.set('llamacpp-upstream', record, 0),
      store.set('llamacpp-upstream', null, 0),
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['conflict', 'updated'])
    expect(store.get('llamacpp-upstream')).toEqual({ revision: 1, optimal: record })
    expect(
      (await OptimalBackendStore.open(data.layout.core.optimalBackend)).get('llamacpp-upstream')
    ).toEqual(store.get('llamacpp-upstream'))
  })

  it('reads the stage-3c bare record and upgrades it on the first write', async () => {
    const path = data.layout.core.optimalBackend
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, JSON.stringify({ 'llamacpp-upstream': record, 'llamacpp': { bad: true } }))
    const store = await OptimalBackendStore.open(path)
    expect(store.get('llamacpp-upstream')).toEqual({ revision: 0, optimal: record })
    expect(store.get('llamacpp')).toEqual({ revision: 0, optimal: null })
    await store.set('llamacpp-upstream', null, 0)
    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({
      schemaVersion: 2,
      providers: { 'llamacpp-upstream': { revision: 1, optimal: null } },
    })
  })

  it('does not let an invalid record or expected revision overwrite the file', async () => {
    const store = await OptimalBackendStore.open(data.layout.core.optimalBackend)
    await expect(
      store.set('llamacpp-upstream', { ...record, provider: 'llamacpp' } as never, 0)
    ).rejects.toThrow()
    await expect(store.set('llamacpp-upstream', record, -1)).rejects.toThrow()
    expect(store.get('llamacpp-upstream').revision).toBe(0)
  })
})
