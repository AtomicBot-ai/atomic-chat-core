import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import { knownWindow, outputCap, readSidecar, sameJson, sidecarPath, writeSidecar } from './backup.js'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('the backup sidecar', () => {
  it('sits next to the config and round-trips with sorted keys', async () => {
    home = await makeAgentHome()
    expect(sidecarPath('.factory/settings.json')).toBe('.factory/settings.json.atomic-chat-backup.json')
    expect(await readSidecar(home.fs, 'a.json')).toBeUndefined()
    await writeSidecar(home.fs, 'a.json', { written: { b: 1 }, previous: null }, 'darwin')
    expect(await home.read('a.json.atomic-chat-backup.json')).toBe(
      '{\n  "previous": null,\n  "written": {\n    "b": 1\n  }\n}\n'
    )
    expect(await readSidecar(home.fs, 'a.json')).toEqual({ previous: null, written: { b: 1 } })
  })

  it.skipIf(process.platform === 'win32')('is owner-only off Windows', async () => {
    home = await makeAgentHome()
    await writeSidecar(home.fs, 'a.json', {}, 'linux')
    expect((await stat(join(home.path, 'a.json.atomic-chat-backup.json'))).mode & 0o777).toBe(0o600)
    await writeSidecar(home.fs, 'b.json', {}, 'win32')
    expect(await home.read('b.json.atomic-chat-backup.json')).toBe('{}\n')
  })

  it('treats one it cannot parse, or that is not an object, as absent', async () => {
    home = await makeAgentHome()
    await home.seed('a.json.atomic-chat-backup.json', '{ broken')
    expect(await readSidecar(home.fs, 'a.json')).toBeUndefined()
    await home.seed('a.json.atomic-chat-backup.json', '[1]')
    expect(await readSidecar(home.fs, 'a.json')).toBeUndefined()
  })
})

describe('the window', () => {
  it('is known only when positive, and caps the reply at a quarter of it up to 8192', () => {
    expect(knownWindow(undefined)).toBeUndefined()
    expect(knownWindow(0)).toBeUndefined()
    expect(knownWindow(16384)).toBe(16384)
    expect(outputCap(16384)).toBe(4096)
    expect(outputCap(32768)).toBe(8192)
    expect(outputCap(262144)).toBe(8192)
    expect(outputCap(1001)).toBe(250)
  })
})

describe('sameJson', () => {
  it('compares values regardless of key order', () => {
    expect(sameJson({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true)
    expect(sameJson({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(sameJson({ a: 1 }, { b: 1 })).toBe(false)
    expect(sameJson([1, 2], [1])).toBe(false)
    expect(sameJson([1], { 0: 1 })).toBe(false)
    expect(sameJson('a', 'a')).toBe(true)
    expect(sameJson('a', 1)).toBe(false)
    expect(sameJson(null, null)).toBe(true)
    expect(sameJson(null, {})).toBe(false)
    expect(sameJson(undefined, 'x')).toBe(false)
  })
})
