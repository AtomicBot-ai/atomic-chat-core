/**
 * Stage 7a: cancelling a model load, through the compiled binary. The load is a real HTTP request
 * that stays open while a backend that never becomes ready hangs; the cancel is a second request.
 * What is asserted is what the app sees and what the machine is left with: the load answers 409 with
 * the app's code, the child is gone before it does, and no session, journal entry or model claim
 * survives.
 *
 * No imports from `src/`: a packaging change that breaks the route cannot pass by type-checking.
 */
import type { ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const { BIN } = core

let dataFolder: string
let pidFile: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-e2e-cancel-'))
  pidFile = join(dataFolder, 'fake-llama-pids')
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  // A fake that never became a session is in no journal; stop whatever this test started.
  for (const pid of startedPids()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone, which is the point of the test.
    }
  }
  await rm(dataFolder, { recursive: true, force: true })
})

const control = (ready: ReadyLine, path: string, init: RequestInit = {}) =>
  core.control(dataFolder, ready, path, init)

function startedPids(): number[] {
  try {
    return readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

/** What the owner journalled; the file is written on the first entry, so its absence means none. */
function journalled(): unknown[] {
  try {
    const journal = JSON.parse(readFileSync(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8')) as {
      processes?: unknown[]
    }
    return journal.processes ?? []
  } catch {
    return []
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const cancel = async (ready: ReadyLine, modelId: string) => {
  const res = await control(ready, `/models/llamacpp-upstream/${modelId}/load/cancel`, { method: 'POST' })
  expect(res.status, await res.clone().text()).toBe(200)
  return ((await res.json()) as { cancelled: boolean }).cancelled
}

describe.skipIf(!existsSync(BIN) || process.platform === 'win32')('cancelling a model load', () => {
  it('stops a load that is hanging: 409 with the app code, the child killed first, nothing left behind', async () => {
    await core.writeModel(dataFolder, 'Owner/Huge-GGUF')
    await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_MODE: 'hang', FAKE_LLAMA_PID_FILE: pidFile })
    const { ready } = await core.startDaemon(dataFolder, daemons)

    expect(await cancel(ready, 'Owner/Huge-GGUF')).toBe(false)

    const load = control(ready, '/models/llamacpp-upstream/Owner/Huge-GGUF/load', { method: 'POST' })
    await waitFor(() => startedPids().length === 1, 'the backend to start')
    const [pid] = startedPids() as [number]
    expect(alive(pid)).toBe(true)

    expect(await cancel(ready, 'Owner/Huge-GGUF')).toBe(true)
    const answer = await load
    expect(answer.status).toBe(409)
    expect(await answer.json()).toEqual({
      error: { code: 'MODEL_LOAD_CANCELLED', message: 'The model load was cancelled.' },
    })
    // The core answers only once the child's exit is confirmed.
    expect(alive(pid)).toBe(false)

    const sessions = (await (await control(ready, '/sessions')).json()) as { sessions: unknown[] }
    expect(sessions.sessions).toEqual([])
    expect(journalled()).toEqual([])
    expect(await readdir(join(dataFolder, 'atomic-core', 'model-claims')).catch(() => [])).toEqual([])
    expect(await cancel(ready, 'Owner/Huge-GGUF')).toBe(false)
  })

  it('cancels a load still waiting behind another one, and leaves the one ahead alone', async () => {
    await core.writeModel(dataFolder, 'first')
    await core.writeModel(dataFolder, 'queued')
    // Neither backend ever becomes ready: the first load holds the provider's queue for as long as
    // the test needs. (A delayed fake would not: it answers `/health` before it says "ready".)
    await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_MODE: 'hang', FAKE_LLAMA_PID_FILE: pidFile })
    const { ready } = await core.startDaemon(dataFolder, daemons)

    const first = control(ready, '/models/llamacpp-upstream/first/load', { method: 'POST' })
    await waitFor(() => startedPids().length === 1, 'the first backend to start')
    const [firstPid] = startedPids() as [number]
    const queued = control(ready, '/models/llamacpp-upstream/queued/load', { method: 'POST' })
    // Queued behind the first load: nothing new starts while it waits.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(startedPids()).toHaveLength(1)

    expect(await cancel(ready, 'queued')).toBe(true)
    const cancelled = await queued
    expect(cancelled.status).toBe(409)
    expect(((await cancelled.json()) as { error: { code: string } }).error.code).toBe('MODEL_LOAD_CANCELLED')
    // The cancelled load never spawned anything, and the load ahead of it is still going.
    expect(startedPids()).toHaveLength(1)
    expect(alive(firstPid)).toBe(true)

    expect(await cancel(ready, 'first')).toBe(true)
    expect((await first).status).toBe(409)
    expect(alive(firstPid)).toBe(false)
    expect(startedPids()).toHaveLength(1)
  })

  it('answers false once the model has loaded, which tells the caller to unload instead', async () => {
    await core.writeModel(dataFolder, 'ready-model')
    await core.writeFakeBackend(dataFolder, { FAKE_LLAMA_PID_FILE: pidFile })
    const { ready } = await core.startDaemon(dataFolder, daemons)

    const loaded = await control(ready, '/models/llamacpp-upstream/ready-model/load', { method: 'POST' })
    expect(loaded.status, await loaded.clone().text()).toBe(200)
    expect(await cancel(ready, 'ready-model')).toBe(false)
    const sessions = (await (await control(ready, '/sessions')).json()) as { sessions: unknown[] }
    expect(sessions.sessions).toHaveLength(1)
  })
})
