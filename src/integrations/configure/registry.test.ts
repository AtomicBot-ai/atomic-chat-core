import { describe, expect, it } from 'vitest'
import type { Agent } from '../catalog.js'
import { findAgent } from '../catalog.js'
import type { ConfigFs } from '../config-io.js'
import { configureAgent, registeredAgents, registerWriter, writerFor } from './registry.js'

/** A catalog entry that is not in the real catalog, so a test writer cannot shadow a real agent. */
const testAgent = (id: string): Agent => ({ ...(findAgent('codex') as Agent), id })

const memoryFs = (): ConfigFs => {
  const files = new Map<string, string>()
  return {
    home: '/home/test',
    absolute: (relative) => `/home/test/${relative}`,
    read: async (relative) => files.get(relative),
    write: async (relative, contents) => {
      files.set(relative, contents)
    },
    mkdirp: async () => {},
    exists: async (relative) => files.has(relative),
    remove: async (relative) => {
      files.delete(relative)
    },
  }
}

describe('the writer registry', () => {
  it('dispatches by agent id and hands the writer everything it needs', async () => {
    const seen: string[] = []
    registerWriter('__test-agent', async (input) => {
      seen.push(`${input.apiUrl}|${input.model}|${input.apiKey}|${input.shell}|${input.platform}`)
    })
    expect(writerFor('__test-agent')).toBeTypeOf('function')
    expect(registeredAgents()).toContain('__test-agent')

    await configureAgent(testAgent('__test-agent'), 'http://127.0.0.1:1337/v1', 'demo', 'k', {
      fs: memoryFs(),
      home: '/home/test',
      platform: 'linux',
      shell: '/bin/zsh',
      env: {},
    })
    expect(seen).toEqual(['http://127.0.0.1:1337/v1|demo|k|/bin/zsh|linux'])
  })

  it('refuses an unknown agent and an agent with no writer', async () => {
    await expect(configureAgent('not-an-agent', 'u', 'm', 'k', { fs: memoryFs() })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    const unported = testAgent('__never-registered')
    await expect(configureAgent(unported, 'u', 'm', 'k', { fs: memoryFs() })).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      details: expect.stringContaining('__never-registered') as unknown as string,
    })
  })

  it('needs a home directory when it has to build its own filesystem', async () => {
    registerWriter('__home-probe', async () => {})
    const agent = testAgent('__home-probe')
    await expect(configureAgent(agent, 'u', 'm', 'k', { platform: 'linux', env: {} })).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
  })
})
