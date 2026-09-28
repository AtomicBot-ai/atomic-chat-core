/**
 * A core started by a CLI command outlives it: the launcher reads the handshake and closes the
 * daemon's pipes (`launchDaemon` in `src/cli/owner.ts`). Anything the core logs afterwards is written
 * to a pipe nobody reads, and must not take the core down with it.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'

const { BIN } = core

let dataFolder: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-detached-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await rm(dataFolder, { recursive: true, force: true })
})

describe.skipIf(!existsSync(BIN))('a core whose launcher closed its pipes', () => {
  it('keeps running when it logs a warning nobody reads', async () => {
    const { ready, child } = await core.startDaemon(dataFolder, daemons, [])
    const exited = new Promise<string>((resolve) =>
      child.once('exit', (code, signal) => resolve(`exit ${String(code ?? signal)}`))
    )
    // What `detachChild` does once the handshake is read.
    child.stdout?.destroy()
    child.stderr?.destroy()

    // A manifest that cannot be fetched is logged as a warning; the proxy leads nowhere.
    for (let i = 0; i < 3; i++) {
      const catalog = await core.control(dataFolder, ready, '/backends/llamacpp-upstream/catalog', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ force: true, proxy: { url: 'http://127.0.0.1:1', ignore_ssl: true } }),
      })
      expect(catalog.status, await catalog.clone().text()).toBe(200)
      expect(((await catalog.json()) as { source: string }).source).toBe('bundled-baseline')
    }

    const alive = await Promise.race([
      exited,
      new Promise<string>((resolve) => setTimeout(() => resolve('alive'), 1500)),
    ])
    expect(alive).toBe('alive')
    expect((await core.control(dataFolder, ready, '/health')).status).toBe(200)
  })
})
