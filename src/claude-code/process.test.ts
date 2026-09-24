import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findExecutable, runProcess } from './process.js'
import type { ClaudeProcessOptions } from './process.js'
let dir: string
let options: ClaudeProcessOptions
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-claude-process-test-'))
  options = {
    cwd: dir,
    home: dir,
    platform: process.platform,
    executable: process.execPath,
    prefixArgs: [resolve('test/helpers/fake-claude-code.mjs')],
    env: { ...process.env, ATOMIC_FAKE_CLAUDE_LOG: join(dir, 'runs.jsonl'), ANTHROPIC_API_KEY: 'test-key' },
  }
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})
describe('Claude subprocess boundary', () => {
  it('finds the explicitly configured executable and fails closed on a missing one', async () => {
    expect(await findExecutable(options)).toBe(process.execPath)
    expect(await findExecutable({ ...options, executable: join(dir, 'missing') })).toBeUndefined()
    await expect(
      runProcess({ ...options, executable: join(dir, 'missing') }, [], { timeoutMs: 1000 })
    ).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' })
  })
  it('passes text over stdin, strips credentials, and retains metacharacters as plain text', async () => {
    const input = 'hello; $(echo do-not-execute) `quoted`'
    const answer = await runProcess(options, ['-p'], { timeoutMs: 2000, input })
    expect(answer).toContain('"result":"OK"')
    const rows = (await readFile(join(dir, 'runs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(rows[0].hasApiKey).toBe(false)
    expect(rows[1].input).toBe(input)
    expect(rows[1].args).not.toContain(input)
  })
  it('kills a stuck child on timeout and bounds unterminated output', async () => {
    options.env['ATOMIC_FAKE_CLAUDE_MODE'] = 'hang'
    await expect(runProcess(options, ['-p'], { timeoutMs: 500, input: 'test' })).rejects.toThrow('timed out')
    const pid = JSON.parse((await readFile(join(dir, 'runs.jsonl'), 'utf8')).split('\n')[0] as string).pid
    expect(() => process.kill(pid, 0)).toThrow()
    options.env['ATOMIC_FAKE_CLAUDE_MODE'] = 'oversize'
    await expect(runProcess(options, ['-p'], { timeoutMs: 2000, input: 'test' })).rejects.toThrow(
      'size limit'
    )
  })
})
