import { describe, expect, it } from 'vitest'
import { AGENTS, findAgent } from './catalog.js'
import { detectAgent, detectAgents } from './detect.js'

const agent = (id: string) => {
  const found = findAgent(id)
  if (!found) throw new Error(`no agent ${id}`)
  return found
}

const posix = { platform: 'linux' as NodeJS.Platform, home: '/home/u', env: {} }

describe('detectAgent', () => {
  it('prefers PATH and reports the bare name as the program', async () => {
    const detection = await detectAgent(agent('codex'), { ...posix, onPath: async () => true })
    expect(detection).toEqual({ installed: true, path: undefined, program: 'codex' })
  })

  it('falls back to a prefix install and executes it by absolute path', async () => {
    const detection = await detectAgent(agent('openclaw'), {
      ...posix,
      onPath: async () => false,
      isFile: async (p) => p === '/home/u/.local/bin/openclaw',
    })
    expect(detection).toEqual({
      installed: true,
      path: '/home/u/.local/bin/openclaw',
      program: '/home/u/.local/bin/openclaw',
    })
  })

  it('honours OPENCLAW_PREFIX before the default locations', async () => {
    const detection = await detectAgent(agent('openclaw'), {
      ...posix,
      env: { OPENCLAW_PREFIX: '/opt/oc' },
      onPath: async () => false,
      isFile: async () => true,
    })
    expect(detection.path).toBe('/opt/oc/bin/openclaw')
  })

  it('reports an agent that is nowhere as not installed, keeping the name for the error message', async () => {
    const detection = await detectAgent(agent('droid'), {
      ...posix,
      onPath: async () => false,
      isFile: async () => false,
    })
    expect(detection).toEqual({ installed: false, path: undefined, program: 'droid' })
  })

  it('probes the real PATH by default: this machine has a shell but no such agent', async () => {
    const fake = { ...agent('codex'), detectBin: 'definitely-not-an-installed-binary-xyz' }
    expect((await detectAgent(fake)).installed).toBe(false)
    const shell = { ...agent('codex'), detectBin: process.platform === 'win32' ? 'cmd' : 'sh' }
    expect((await detectAgent(shell)).installed).toBe(true)
  })
})

describe('detectAgents', () => {
  it('answers for every agent in the catalog', async () => {
    const found = await detectAgents(AGENTS, {
      ...posix,
      onPath: async (bin) => bin === 'codex',
      isFile: async () => false,
    })
    expect(found.size).toBe(AGENTS.length)
    expect(found.get('codex')?.installed).toBe(true)
    expect(found.get('droid')?.installed).toBe(false)
  })
})
