/**
 * The `geniex-host` mode of the compiled binaries (openspec change `add-geniex-runtime`, task 5.1):
 * both binaries run the mode through the package's public entry, and the library lives in a Worker
 * bundled as its own entry (design D1) — without it the mode fails with "no Worker" or a module not
 * found instead of reaching the folder. No real library needed; the real one is
 * `test/integration/geniex-host.test.ts` on a Snapdragon X laptop.
 *
 * No imports from `src/`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { APP_BIN, BIN } from '../helpers/compiled-core.js'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-geniex-host-e2e-'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe.skipIf(!existsSync(BIN) || !existsSync(APP_BIN))('geniex-host through the public entry', () => {
  it.each([
    ['atomic-chat-core', BIN],
    ['atomic-chat-app-core', APP_BIN],
  ])(
    '%s reaches the folder through its bundled Worker and FFI module, and answers a wrong mode with usage',
    (_name, bin) => {
      const empty = spawnSync(bin, ['geniex-host', 'probe', '--lib', dir], {
        encoding: 'utf8',
        timeout: 60_000,
      })
      expect(empty.status, empty.stderr).toBe(3)
      expect(empty.stderr).toMatch(
        /^GenieX does not load from .*: load: .*geniex\.dll not found: no geniex\.dll in this build/
      )
      expect(empty.stderr).not.toMatch(/only inside a compiled binary|no Worker|ModuleNotFound/)
      expect(empty.stdout).toBe('')
      const usage = spawnSync(bin, ['geniex-host', 'nope'], { encoding: 'utf8', timeout: 60_000 })
      expect(usage.status).toBe(2)
      expect(usage.stderr).toBe('geniex-host: unknown mode "nope" (probe, inspect, serve)\n')
    }
  )

  it('inspect reads a model without any library: a missing path exits 4, naming it', () => {
    const run = spawnSync(BIN, ['geniex-host', 'inspect', join(dir, 'missing.gguf')], {
      encoding: 'utf8',
      timeout: 60_000,
    })
    expect(run.status).toBe(4)
    expect(run.stderr).toMatch(/missing\.gguf does not exist/)
    expect(run.stdout).toBe('')
  })
})
