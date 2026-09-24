/** Compiled binary + a fake official CLI, with no account or network dependency. */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as core from '../helpers/compiled-core.js'
let dir: string
const daemons: ChildProcess[] = []
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-claude-e2e-'))
})
afterEach(async () => {
  for (const child of daemons.splice(0)) child.kill('SIGKILL')
  await rm(dir, { recursive: true, force: true })
})
describe.skipIf(!existsSync(core.BIN))('compiled Claude Code bridge', () => {
  it('discovers Fable, signs in without returning credentials, and streams a resumable reply', async () => {
    const { ready } = await core.startDaemon(dir, daemons, [], {
      ATOMIC_CLAUDE_CODE_EXECUTABLE: process.execPath,
      ATOMIC_TEST_CLAUDE_ENTRYPOINT: resolve('test/helpers/fake-claude-code.mjs'),
      ATOMIC_FAKE_CLAUDE_LOG: join(dir, 'claude-calls.jsonl'),
    })
    const status = (await (await core.control(dir, ready, '/claude-code/status')).json()) as {
      models: Array<{ name: string }>
    }
    expect(status.models.some((model) => model.name === 'Claude Fable 5.1 · 1M')).toBe(true)
    expect(JSON.stringify(status)).not.toContain('must-not-leave')
    const login = await core.control(dir, ready, '/claude-code/login', { method: 'POST' })
    expect(await login.json()).toEqual({ connected: true })
    const requestId = '684286da-7283-4e22-9436-c6f6c3c03015'
    const request = { requestId, model: 'claude-fable-5-1[1m]', prompt: 'hello' }
    const ask = async (body: unknown) => {
      const response = await core.control(dir, ready, '/claude-code/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      return (await response.text())
        .trim()
        .split('\n\n')
        .map((frame) => JSON.parse(frame.slice(6)))
    }
    const first = await ask(request)
    expect(first.map((event) => event.type)).toEqual(['ready', 'delta', 'result'])
    expect(first[2].result.text).toBe('OK')
    const second = await ask({ ...request, sessionId: first[2].result.sessionId, prompt: 'follow up' })
    expect(second[2].result.sessionId).toBe(requestId)
    const calls = (await readFile(join(dir, 'claude-calls.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(calls.some((call) => call.input === 'follow up' && call.args.includes('--resume'))).toBe(true)
    expect(calls.every((call) => !call.hasApiKey && !call.hasBaseUrl)).toBe(true)
    await core.control(dir, ready, '/shutdown', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"force":true}',
    })
  })
})
