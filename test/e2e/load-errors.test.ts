/**
 * Stage 7m through the compiled binary: the same engine output means two different things depending
 * on which llama.cpp provider ran it. A tensor-count mismatch is an unsupported architecture on the
 * TurboQuant fork (its tensor layouts differ; the file is fine) and a corrupt file upstream.
 *
 * No imports from `src/`. POSIX only: the fake backend is a shell script.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { BIN } = core

let dataFolder: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-load-errors-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })

function journalled(): unknown[] {
  try {
    return (
      (
        JSON.parse(readFileSync(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8')) as {
          processes?: unknown[]
        }
      ).processes ?? []
    )
  } catch {
    return []
  }
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('load failures per provider', () => {
  it('reads a tensor-count mismatch as an unsupported architecture on the TurboQuant fork and as a corrupt file upstream', async () => {
    await core.writeModel(dataFolder, 'demo')
    await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_MODE: 'tensor-count' })
    await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_MODE: 'tensor-count' }, { provider: 'llamacpp' })
    const { ready } = await core.startDaemon(dataFolder, daemons)
    // No backend chosen for the fork yet: the core picks the installed build with the TurboQuant matrix.
    const chosen = await control(ready, '/settings/llamacpp', {
      method: 'PATCH',
      body: JSON.stringify({ values: { version_backend: '', fit: false } }),
    })
    expect(chosen.status, await chosen.clone().text()).toBe(200)

    const fork = await control(ready, '/models/llamacpp/demo/load', { method: 'POST', body: '{}' })
    expect(fork.status).toBe(500)
    const forkBody = (await fork.json()) as { error: { code: string; message: string; details?: string } }
    expect(forkBody.error.code).toBe('MODEL_ARCH_NOT_SUPPORTED')
    expect(forkBody.error.details).toContain('wrong number of tensors')

    const upstream = await control(ready, '/models/llamacpp-upstream/demo/load', {
      method: 'POST',
      body: '{}',
    })
    expect(upstream.status).toBe(500)
    const upstreamBody = (await upstream.json()) as { error: { code: string; details?: string } }
    expect(upstreamBody.error.code).toBe('MODEL_FILE_CORRUPT')
    expect(upstreamBody.error.details).toContain('wrong number of tensors')

    // Neither load left a session or a journalled process.
    expect((await (await control(ready, '/sessions')).json()) as object).toMatchObject({ sessions: [] })
    expect(journalled()).toEqual([])
  }, 60_000)
})
