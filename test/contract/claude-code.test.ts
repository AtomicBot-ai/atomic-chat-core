/** Rust-emitted IPC payloads replayed through the core's official-CLI adapter. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { ClaudeCodeRuntime } from '../../src/claude-code/index.js'
import type {
  ClaudeCodeEvent,
  ClaudeCodeRequest,
  ClaudeCodeResult,
  ClaudeCodeStatus,
} from '../../src/contracts/index.js'
import { loadFixtureSet } from './fixtures.js'

it('replays the app request and produces the exact Rust result, delta, and credential-free status shapes', async () => {
  const fixtures = loadFixtureSet<unknown, unknown>('claude-code')
  expect(fixtures.index.source.commit).toMatch(/^[a-f0-9]{40}$/)
  const sample = <T>(name: string): T => fixtures.cases.find((item) => item.name === name)!.expected as T
  const dir = await mkdtemp(join(tmpdir(), 'atomic-claude-contract-'))
  const runtime = new ClaudeCodeRuntime({
    cwd: dir,
    executable: process.execPath,
    prefixArgs: [resolve('test/helpers/fake-claude-code.mjs')],
    env: { ...process.env, ATOMIC_FAKE_CLAUDE_MODE: '' },
  })
  try {
    const events: ClaudeCodeEvent[] = []
    const result = await runtime.chat(sample<ClaudeCodeRequest>('request'), async (event) => {
      events.push(event)
    })
    expect(result).toEqual(sample<ClaudeCodeResult>('result'))
    expect(events).toContainEqual(sample<ClaudeCodeEvent>('delta'))
    const status = await runtime.status()
    const expected = sample<ClaudeCodeStatus>('status')
    expect({
      ...status,
      models: status.models.filter((model) => model.id === expected.models[0]!.id),
    }).toEqual(expected)
  } finally {
    runtime.shutdown()
    await rm(dir, { recursive: true, force: true })
  }
})
