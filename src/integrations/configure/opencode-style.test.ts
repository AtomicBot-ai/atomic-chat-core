import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { writeOpencodeStyleConfig } from './opencode-style.js'

const SPEC = {
  dir: '.config/demo',
  file: 'demo.json',
  schema: 'https://demo.example/config.json',
  lenient: false,
}
const LENIENT = { ...SPEC, lenient: true }

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

async function fresh(prefix?: string): Promise<AgentHome> {
  home = await makeAgentHome(prefix)
  return home
}

describe('writeOpencodeStyleConfig', () => {
  it('keeps an existing $schema, including an explicit null', async () => {
    // serde's `entry(..).or_insert_with(..)` only fills an *absent* key; a present `null` stays.
    const h = await fresh()
    await h.seed('.config/demo/demo.json', '{"$schema": null}')
    await writeOpencodeStyleConfig(agentInput(h.fs), SPEC)
    expect(JSON.parse((await h.read('.config/demo/demo.json')) ?? '')['$schema']).toBeNull()
  })

  it.each([
    ['a string', '"nonsense"'],
    ['an array', '[1, 2, 3]'],
    ['a number', '42'],
    ['null', 'null'],
  ])('refuses a root that is %s and writes nothing', async (_label, body) => {
    const h = await fresh()
    await h.seed('.config/demo/demo.json', body)
    await expect(writeOpencodeStyleConfig(agentInput(h.fs), SPEC)).rejects.toThrow(
      'demo.json is not a JSON object'
    )
    expect(await h.read('.config/demo/demo.json')).toBe(body)
  })

  it('creates the config directory on a fresh home before it reads anything', async () => {
    // The Rust writers call `create_dir_all` above the read, which is why a later parse failure
    // still leaves the directory behind.
    const h = await fresh()
    expect(await h.hasDir('.config/demo')).toBe(false)
    await writeOpencodeStyleConfig(agentInput(h.fs), SPEC)
    expect(await h.hasDir('.config/demo')).toBe(true)
  })

  it('touches nothing at all when parsing fails — no partial write, no temp file left', async () => {
    const h = await fresh()
    await h.seed('.config/demo/demo.json', '{ "provider": ')
    await expect(writeOpencodeStyleConfig(agentInput(h.fs), SPEC)).rejects.toThrow(/Failed to parse/)
    expect(await h.tree()).toEqual({ '.config/demo/demo.json': '{ "provider": ' })
  })

  it('rejects comments under a strict spec but accepts them under a lenient one', async () => {
    const withComment = '{\n  // hello\n  "theme": "dracula",\n}\n'
    const strict = await fresh()
    await strict.seed('.config/demo/demo.json', withComment)
    await expect(writeOpencodeStyleConfig(agentInput(strict.fs), SPEC)).rejects.toThrow(/Failed to parse/)
    await strict.cleanup()

    const lenient = await fresh()
    await lenient.seed('.config/demo/demo.json', withComment)
    await writeOpencodeStyleConfig(agentInput(lenient.fs), LENIENT)
    const parsed = JSON.parse((await lenient.read('.config/demo/demo.json')) ?? '')
    expect(parsed.theme).toBe('dracula')
    expect(parsed.provider.atomic.name).toBe('Atomic Chat')
  })

  it('addresses a home directory whose path contains a space and non-ASCII characters', async () => {
    const h = await fresh('atomic agent ǝɯoɥ-')
    expect(h.path).toContain(' ')
    await writeOpencodeStyleConfig(agentInput(h.fs), SPEC)
    expect(Object.keys(await h.tree())).toEqual(['.config/demo/demo.json'])
  })

  it('names the active model even when the model id is empty', async () => {
    // Only Claude Code and Zed treat an empty model as "none"; here it is just an empty id.
    const h = await fresh()
    await writeOpencodeStyleConfig(agentInput(h.fs, { model: '' }), SPEC)
    const parsed = JSON.parse((await h.read('.config/demo/demo.json')) ?? '')
    expect(parsed.model).toBe('atomic/')
    expect(parsed.provider.atomic.models).toEqual({ '': { name: '' } })
  })

  it('replaces a provider map that is not an object and keeps unrelated top-level keys', async () => {
    const h = await fresh()
    await h.seed('.config/demo/demo.json', '{"provider": "nope", "theme": "nord", "keep": [1]}')
    await writeOpencodeStyleConfig(agentInput(h.fs), SPEC)
    const parsed = JSON.parse((await h.read('.config/demo/demo.json')) ?? '')
    expect(Object.keys(parsed.provider)).toEqual(['atomic'])
    expect(parsed.theme).toBe('nord')
    expect(parsed.keep).toEqual([1])
  })
})
