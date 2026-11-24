/**
 * History compaction through the compiled binary: the control API measures a chat against its
 * session's window and compacts it, and the public server compacts a chat that does not fit before
 * sending it, answering with `x-atomic-compacted`. The fake llama-server renders a chat as its
 * messages' JSON, counts whitespace-separated pieces as tokens and serves a 4096-token window.
 */
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
import type { ReadyLine } from '../helpers/compiled-core.js'

const POSIX = process.platform !== 'win32'

let dataFolder: string
const daemons: ChildProcess[] = []

beforeEach(async () => {
  dataFolder = await mkdtemp(join(tmpdir(), 'atomic-core-compaction-e2e-'))
})
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill('SIGKILL')
  core.reapJournalledChildren(dataFolder)
  await rm(dataFolder, { recursive: true, force: true })
})

const post = (ready: ReadyLine, path: string, body: unknown) =>
  core.control(dataFolder, ready, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

/** `turns` turns of 120 words each way, then a last question. */
function chat(turns: number): Array<{ role: string; content: string }> {
  const out = [{ role: 'system', content: 'You help with the project.' }]
  for (let i = 0; i < turns; i++) {
    const text = (who: string) => Array.from({ length: 60 }, (_, w) => `${who}${i}w${w}`).join(' ')
    out.push({ role: 'user', content: text('u') }, { role: 'assistant', content: text('a') })
  }
  out.push({ role: 'user', content: 'What is left to do?' })
  return out
}

describe.skipIf(!POSIX)('history compaction (compiled binary)', () => {
  it('measures and compacts over the control API, and compacts a public chat over the window', async () => {
    await core.writeModel(dataFolder, 'demo')
    await core.writeFakeBackend(dataFolder)
    const { ready } = await core.startDaemon(dataFolder, daemons)
    const loaded = await post(ready, '/models/llamacpp-upstream/demo/load', {})
    expect(loaded.status, await loaded.clone().text()).toBe(200)

    const small = chat(2)
    const measured = await post(ready, '/models/llamacpp-upstream/demo/context/measure', { messages: small })
    expect(measured.status, await measured.clone().text()).toBe(200)
    expect(await measured.json()).toEqual({
      promptTokens: JSON.stringify(small).split(/\s+/).length,
      exact: true,
      windowTokens: 4096,
      resize: 'reload',
      supportsPromptProgress: true,
    })
    const compacted = await post(ready, '/models/llamacpp-upstream/demo/compact', { messages: small })
    expect(compacted.status, await compacted.clone().text()).toBe(200)
    expect(await compacted.json()).toMatchObject({
      summary: 'hello from the fake backend',
      keepFrom: 3,
      summarizedCount: 2,
      cached: false,
    })

    const started = await post(ready, '/server/start', { port: 0 })
    expect(started.status).toBe(200)
    const { port } = (await started.json()) as { port: number }
    const send = (messages: unknown, headers: Record<string, string> = {}) =>
      fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'demo', messages }),
      })

    // About 3000 tokens of history against 4096 with 1024 kept free for the answer: compacted first.
    const long = chat(25)
    const res = await send(long)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(Number(res.headers.get('x-atomic-compacted'))).toBeGreaterThan(0)
    expect(await res.json()).toMatchObject({
      choices: [{ message: { content: 'hello from the fake backend' } }],
    })

    const off = await send(long, { 'x-atomic-compaction': 'off' })
    expect(off.status).toBe(200)
    expect(off.headers.get('x-atomic-compacted')).toBeNull()
  })
})
