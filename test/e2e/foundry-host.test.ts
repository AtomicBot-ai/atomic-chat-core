/**
 * The `foundry-host` mode of the compiled binaries against a real Foundry Local build (openspec change
 * `add-foundry-local`, task 5.1). Skipped unless FOUNDRY_LOCAL_TEST_LIB names an unpacked release
 * archive for this platform (the folder holding `lib/`), e.g. foundry-local-osx-arm64.tgz of v2.1.0.
 *
 * No imports from `src/`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_BIN, BIN } from '../helpers/compiled-core.js'

const LIB = process.env['FOUNDRY_LOCAL_TEST_LIB']
let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-foundry-host-e2e-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe.skipIf(!LIB || !existsSync(BIN))('foundry-host against a real Foundry Local library', () => {
  it.each([
    ['atomic-chat-core', BIN],
    ['atomic-chat-app-core', APP_BIN],
  ])('%s foundry-host probe loads the library, checks its C API and lists its accelerators', (_name, bin) => {
    const appData = join(dir, 'runtime')
    const run = spawnSync(
      bin,
      ['foundry-host', 'probe', '--lib', LIB as string, '--app-data', appData, '--logs', join(dir, 'logs')],
      { encoding: 'utf8', timeout: 60_000 }
    )
    expect(run.status, run.stderr).toBe(0)
    const answer = JSON.parse(run.stdout.trim().split('\n').at(-1) as string) as {
      c_api_version: number
      accelerators: Array<{ name: string; device: string; prepared: boolean }>
    }
    expect(answer.c_api_version).toBe(2)
    expect(Array.isArray(answer.accelerators)).toBe(true)
    for (const accelerator of answer.accelerators)
      expect(accelerator).toEqual({
        name: expect.any(String),
        device: expect.any(String),
        execution_provider: expect.anything(),
        prepared: false,
      })
  })

  it('keeps the library to the data folders core gives it', async () => {
    spawnSync(
      BIN,
      [
        'foundry-host',
        'probe',
        '--lib',
        LIB as string,
        '--app-data',
        join(dir, 'runtime'),
        '--logs',
        join(dir, 'logs'),
      ],
      {
        encoding: 'utf8',
        timeout: 60_000,
      }
    )
    expect((await readdir(dir)).sort()).toEqual(expect.arrayContaining(['logs']))
    expect((await readdir(dir)).every((name) => ['logs', 'runtime'].includes(name))).toBe(true)
  })

  it('refuses a folder that holds no Foundry Local library, naming it', () => {
    const run = spawnSync(
      BIN,
      ['foundry-host', 'probe', '--lib', dir, '--app-data', join(dir, 'r'), '--logs', join(dir, 'l')],
      {
        encoding: 'utf8',
        timeout: 60_000,
      }
    )
    expect(run.status).not.toBe(0)
    expect(run.stderr).toMatch(/foundry_local/)
  })
})
