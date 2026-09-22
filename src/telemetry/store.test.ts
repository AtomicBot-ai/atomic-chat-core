import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ensureInstallId, readTelemetryFile, writeTelemetryFile } from './store.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-telemetry-store-'))
  path = join(dir, 'atomic-core', 'telemetry.json')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('telemetry.json', () => {
  it('reads a missing or malformed file as empty', async () => {
    expect(await readTelemetryFile(path)).toEqual({})
    await writeTelemetryFile(path, {})
    await writeFile(path, '{not json')
    expect(await readTelemetryFile(path)).toEqual({})
  })

  it('round-trips the choice, the id and the notice, and drops what it does not know', async () => {
    const id = '3f0c9a52-5d0e-4a5f-9a4b-1f2e3d4c5b6a'
    expect(await writeTelemetryFile(path, { enabled: false, install_id: id, notice_shown: true })).toBe(true)
    expect(await readTelemetryFile(path)).toEqual({ enabled: false, install_id: id, notice_shown: true })
    await writeFile(path, JSON.stringify({ enabled: 'yes', install_id: '../../etc', notice_shown: 1, x: 1 }))
    expect(await readTelemetryFile(path)).toEqual({})
  })

  it('mints the install id once and keeps it', async () => {
    const first = await ensureInstallId(path, { enabled: true })
    expect(first).toMatch(/^[0-9a-f-]{36}$/)
    const stored = await readTelemetryFile(path)
    expect(stored).toEqual({ enabled: true, install_id: first })
    expect(await ensureInstallId(path, stored)).toBe(first)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ enabled: true, install_id: first })
  })

  it('reports a write it could not make instead of throwing', async () => {
    await writeFile(join(dir, 'blocker'), 'x')
    expect(await writeTelemetryFile(join(dir, 'blocker', 'telemetry.json'), {})).toBe(false)
  })
})
