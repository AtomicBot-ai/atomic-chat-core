import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { configureOpencode } from './opencode.js'
import { writerFor } from './registry.js'

const PATH = '.config/opencode/opencode.json'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('configureOpencode', () => {
  it('is the writer the registry hands out for "opencode"', () => {
    expect(writerFor('opencode')).toBe(configureOpencode)
  })

  it("writes only opencode.json, and seeds OpenCode's own $schema", async () => {
    home = await makeAgentHome()
    await configureOpencode(agentInput(home.fs))
    const tree = await home.tree()
    expect(Object.keys(tree)).toEqual([PATH])
    expect(JSON.parse(tree[PATH] ?? '')['$schema']).toBe('https://opencode.ai/config.json')
  })

  it('reads comments and trailing commas as OpenCode does, and drops them on write', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{\n  // a comment\n  "theme": "nord",\n}\n')
    await configureOpencode(agentInput(home.fs))
    const written = (await home.read(PATH)) ?? ''
    expect(written).not.toContain('// a comment')
    expect(JSON.parse(written).theme).toBe('nord')
  })

  it('writes the opencode.jsonc that would override opencode.json, and clears ours from the latter', async () => {
    home = await makeAgentHome()
    await home.seed(
      PATH,
      '{"theme":"x","model":"atomic/old","provider":{"atomic":{"name":"Atomic Chat"},"ollama":{}}}'
    )
    await home.seed(
      '.config/opencode/opencode.jsonc',
      '{\n  // seeded\n  "$schema": "https://opencode.ai/config.json",\n}\n'
    )
    await configureOpencode(agentInput(home.fs))
    const tree = await home.tree()
    expect(JSON.parse(tree['.config/opencode/opencode.jsonc'] ?? '').model).toBe(
      'atomic/AtomicChat/Qwen3.5-9B-GGUF'
    )
    expect(JSON.parse(tree[PATH] ?? '')).toEqual({ theme: 'x', provider: { ollama: {} } })
  })

  it('writes where $OPENCODE_CONFIG_DIR or $OPENCODE_CONFIG points', async () => {
    home = await makeAgentHome()
    const dir = `${home.path}/oc-dir`
    await configureOpencode(
      agentInput(home.fs, { env: { OPENCODE_CONFIG_DIR: dir, OPENCODE_CONFIG: `${home.path}/x.json` } })
    )
    await configureOpencode(agentInput(home.fs, { env: { OPENCODE_CONFIG: `${home.path}/custom.json` } }))
    await configureOpencode(agentInput(home.fs, { env: { XDG_CONFIG_HOME: `${home.path}/xdg` } }))
    expect(Object.keys(await home.tree())).toEqual([
      'custom.json',
      'oc-dir/opencode.json',
      'xdg/opencode/opencode.json',
    ])
  })

  it('reports a truncated file and writes nothing', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '{"provider":')
    await expect(configureOpencode(agentInput(home.fs))).rejects.toThrow(/Failed to parse/)
    expect(await home.tree()).toEqual({ [PATH]: '{"provider":' })
  })

  it('rejects a config whose root is not an object', async () => {
    home = await makeAgentHome()
    await home.seed(PATH, '"just a string"')
    await expect(configureOpencode(agentInput(home.fs))).rejects.toThrow('opencode.json is not a JSON object')
  })

  it('works from a home directory whose path contains a space', async () => {
    home = await makeAgentHome('atomic opencode home-')
    await configureOpencode(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([PATH])
  })
})
