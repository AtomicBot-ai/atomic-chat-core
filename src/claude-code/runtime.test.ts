import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ClaudeCodeRuntime } from './runtime.js'
import type { ClaudeCodeEvent } from '../contracts/index.js'
let dir: string
const runtimes: ClaudeCodeRuntime[] = []
const request = {
  requestId: '684286da-7283-4e22-9436-c6f6c3c03015',
  model: 'claude-fable-5-1[1m]',
  prompt: 'hello',
  system: 'Private test instructions',
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-claude-runtime-test-'))
})
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.shutdown()
  await rm(dir, { recursive: true, force: true })
})
function runtime(mode = '') {
  const value = new ClaudeCodeRuntime({
    cwd: dir,
    home: dir,
    platform: process.platform,
    executable: process.execPath,
    prefixArgs: [resolve('test/helpers/fake-claude-code.mjs')],
    env: { ...process.env, ATOMIC_FAKE_CLAUDE_MODE: mode, ATOMIC_FAKE_CLAUDE_LOG: join(dir, 'runs.jsonl') },
  })
  runtimes.push(value)
  return value
}
describe('core-owned Claude Code', () => {
  it('discovers the catalog without inference, and never returns account secrets', async () => {
    const status = await runtime().status()
    expect(status).toMatchObject({ installed: true, loggedIn: true, subscription: true, plan: 'max' })
    expect(status.models[1]?.name).toBe('Claude Fable 5.1 · 1M')
    expect(JSON.stringify(status)).not.toContain('private@example')
    expect(JSON.stringify(status)).not.toContain('must-not-leave')
    expect(await readFile(join(dir, 'runs.jsonl'), 'utf8')).not.toContain('"input"')
  })
  it('reports logged-out and API sessions without offering subscription models', async () => {
    expect(await runtime('logged-out').status()).toMatchObject({
      installed: true,
      loggedIn: false,
      subscription: false,
      models: [],
    })
    const api = runtime('api')
    expect(await api.status()).toMatchObject({ loggedIn: true, subscription: false, models: [] })
    await expect(api.chat(request, async () => {})).rejects.toMatchObject({ code: 'AUTH_REQUIRED' })
  })
  it('runs official sign-in without returning the login code', async () => {
    expect(await runtime().login()).toBeUndefined()
  })
  it('streams, resumes exactly the supplied session, and deletes the private system-prompt file', async () => {
    const events: ClaudeCodeEvent[] = []
    const result = await runtime().chat({ ...request, sessionId: request.requestId }, async (event) => {
      events.push(event)
    })
    expect(events).toEqual([{ type: 'ready' }, { type: 'delta', text: 'OK' }])
    expect(result).toEqual({ sessionId: request.requestId, text: 'OK', inputTokens: 17, outputTokens: 3 })
    const rows = (await readFile(join(dir, 'runs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const call = rows.find((row) => row.input)
    expect(call.system).toBe(request.system)
    expect(call.args).toContain('--resume')
    expect(call.args).toContain(request.requestId)
    expect(call.args).not.toContain(request.system)
    await expect(access(call.args[call.args.indexOf('--system-prompt-file') + 1])).rejects.toThrow()
  })
  it('propagates model failures and kills an in-flight run on shutdown', async () => {
    await expect(runtime('error').chat(request, async () => {})).rejects.toThrow('Usage limit reached')
    const hanging = runtime('hang')
    const result = hanging.chat(request, async (event) => {
      if (event.type === 'delta') hanging.shutdown()
    })
    await expect(result).rejects.toThrow()
    const rows = (await readFile(join(dir, 'runs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    const last = rows.at(-1)
    expect(() => process.kill(last.pid, 0)).toThrow()
  })
})
