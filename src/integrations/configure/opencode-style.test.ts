import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { readRoot, writeOpencodeStyleConfig } from './opencode-style.js'

const PATH = '.config/demo/demo.json'
const TARGET = { file: PATH, others: [] }
const SPEC = { schema: 'https://demo.example/config.json' }
const BACKUP = `${PATH}.atomic-chat-backup.json`
/** A `.jsonc` beside the `.json` wins, so Connect writes it and cleans our entries out of the `.json`. */
const JSONC = '.config/demo/demo.jsonc'
const JSONC_TARGET = { file: JSONC, others: [PATH] }
/** A config an earlier Connect left pointing at us. */
const CONNECTED = '{"model": "atomic/old", "provider": {"atomic": {"name": "Atomic Chat"}}}'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

async function fresh(prefix?: string): Promise<AgentHome> {
  home = await makeAgentHome(prefix)
  return home
}

const readJson = async (h: AgentHome, path: string) => JSON.parse((await h.read(path)) ?? '')

describe('writeOpencodeStyleConfig', () => {
  it('keeps an existing $schema, including an explicit null', async () => {
    // serde's `entry(..).or_insert_with(..)` only fills an *absent* key; a present `null` stays.
    const h = await fresh()
    await h.seed(PATH, '{"$schema": null}')
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)
    expect((await readJson(h, PATH))['$schema']).toBeNull()
  })

  it.each([
    ['a string', '"nonsense"'],
    ['an array', '[1, 2, 3]'],
    ['a number', '42'],
    ['null', 'null'],
  ])('refuses a root that is %s and writes nothing', async (_label, body) => {
    const h = await fresh()
    await h.seed(PATH, body)
    await expect(writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)).rejects.toThrow(
      'demo.json is not a JSON object'
    )
    expect(await h.tree()).toEqual({ [PATH]: body })
  })

  it('creates the config directory on a fresh home before it reads anything', async () => {
    // The Rust writer calls `create_dir_all` above the read, which is why a later parse failure
    // still leaves the directory behind.
    const h = await fresh()
    expect(await h.hasDir('.config/demo')).toBe(false)
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)
    expect(await h.hasDir('.config/demo')).toBe(true)
  })

  it('touches nothing at all when parsing fails — no partial write, no temp file left', async () => {
    const h = await fresh()
    await h.seed(PATH, '{ "provider": ')
    await expect(writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)).rejects.toThrow(/Failed to parse/)
    expect(await h.tree()).toEqual({ [PATH]: '{ "provider": ' })
  })

  it('accepts comments and trailing commas', async () => {
    const h = await fresh()
    await h.seed(PATH, '{\n  // hello\n  "theme": "dracula",\n}\n')
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)
    const parsed = await readJson(h, PATH)
    expect(parsed.theme).toBe('dracula')
    expect(parsed.provider.atomic.name).toBe('Atomic Chat')
  })

  it('addresses a home directory whose path contains a space and non-ASCII characters', async () => {
    const h = await fresh('atomic agent ǝɯoɥ-')
    expect(h.path).toContain(' ')
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)
    expect(Object.keys(await h.tree())).toEqual([PATH])
  })

  it('writes thinking, no timeouts, and the window with its output cap only when known', async () => {
    const h = await fresh()
    await writeOpencodeStyleConfig(
      { ...agentInput(h.fs, { model: 'm' }), contextLength: 16384 },
      TARGET,
      SPEC
    )
    const entry = (await readJson(h, PATH)).provider.atomic
    expect(entry.options).toEqual({
      apiKey: 'sk-atomic-fixture-key',
      baseURL: 'http://127.0.0.1:1337/v1',
      headerTimeout: false,
      timeout: false,
    })
    expect(entry.models).toEqual({
      m: {
        name: 'm',
        reasoning: true,
        interleaved: { field: 'reasoning_content' },
        limit: { context: 16384, output: 4096 },
      },
    })

    await writeOpencodeStyleConfig(
      { ...agentInput(h.fs, { model: 'm' }), contextLength: 131072 },
      TARGET,
      SPEC
    )
    expect((await readJson(h, PATH)).provider.atomic.models.m.limit).toEqual({
      context: 131072,
      output: 8192,
    })
    await writeOpencodeStyleConfig(agentInput(h.fs, { model: 'm' }), TARGET, SPEC)
    expect((await readJson(h, PATH)).provider.atomic.models.m.limit).toBeUndefined()
  })

  it('keeps what it replaces for Disconnect, and not its own values on a reconnect', async () => {
    const h = await fresh()
    await h.seed(
      PATH,
      '{"model": "openrouter/x", "provider": {"atomic": {"name": "Their own"}, "openrouter": {}}}'
    )
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)
    await writeOpencodeStyleConfig(agentInput(h.fs, { model: 'other' }), TARGET, SPEC)
    expect((await readJson(h, BACKUP)).previous).toEqual({
      model: 'openrouter/x',
      provider: { atomic: { name: 'Their own' } },
    })
    expect((await readJson(h, PATH)).model).toBe('atomic/other')
  })

  it('keeps nothing when nothing was replaced, and drops a backup that no longer applies', async () => {
    const h = await fresh()
    await h.seed(PATH, '{"model": "openrouter/x"}')
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)
    expect(await h.read(BACKUP)).toBeDefined()
    // The user removed our model since: there is nothing to put back any more.
    await h.seed(PATH, '{}')
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)
    expect(await h.read(BACKUP)).toBeUndefined()
  })

  it('names the active model even when the model id is empty', async () => {
    // Only Claude Code and Zed treat an empty model as "none"; here it is just an empty id.
    const h = await fresh()
    await writeOpencodeStyleConfig(agentInput(h.fs, { model: '' }), TARGET, SPEC)
    const parsed = await readJson(h, PATH)
    expect(parsed.model).toBe('atomic/')
    expect(Object.keys(parsed.provider.atomic.models)).toEqual([''])
  })

  it('replaces a provider map that is not an object and keeps unrelated top-level keys', async () => {
    const h = await fresh()
    await h.seed(PATH, '{"provider": "nope", "theme": "nord", "keep": [1]}')
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, SPEC)
    const parsed = await readJson(h, PATH)
    expect(Object.keys(parsed.provider)).toEqual(['atomic'])
    expect(parsed.theme).toBe('nord')
    expect(parsed.keep).toEqual([1])
  })

  it('replaces a $schema an earlier release wrote by mistake, and only that one', async () => {
    const h = await fresh()
    const spec = { ...SPEC, staleSchema: 'https://stale.example/config.json' }
    await h.seed(PATH, '{"$schema": "https://stale.example/config.json"}')
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, spec)
    expect((await readJson(h, PATH))['$schema']).toBe(SPEC.schema)
    await h.seed(PATH, '{"$schema": "https://own.example/config.json"}')
    await writeOpencodeStyleConfig(agentInput(h.fs), TARGET, spec)
    expect((await readJson(h, PATH))['$schema']).toBe('https://own.example/config.json')
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['an array', '[1, 2]'],
    ['a previous that is not an object', '{"previous": 5}'],
    ['no previous at all', '{"about": "x"}'],
  ])('treats a backup holding %s as empty, and drops it on a reconnect', async (_label, body) => {
    const h = await fresh()
    await h.seed(PATH, CONNECTED)
    await h.seed(BACKUP, body)
    await writeOpencodeStyleConfig(agentInput(h.fs, { model: 'm' }), TARGET, SPEC)
    expect(await h.read(BACKUP)).toBeUndefined()
    expect((await readJson(h, PATH)).model).toBe('atomic/m')
  })
})

describe('the file beside the one Connect writes', () => {
  it('takes our entries out of it, putting back what they replaced', async () => {
    const h = await fresh()
    await h.seed(
      PATH,
      '{"model": "atomic/old", "provider": {"atomic": {"name": "Atomic Chat"}, "openrouter": {}}, "theme": "nord"}'
    )
    await h.seed(BACKUP, '{"previous": {"model": "openrouter/x"}}')
    await writeOpencodeStyleConfig(agentInput(h.fs, { model: 'm' }), JSONC_TARGET, SPEC)
    expect(await readJson(h, PATH)).toEqual({
      model: 'openrouter/x',
      provider: { openrouter: {} },
      theme: 'nord',
    })
    const written = await readJson(h, JSONC)
    expect(written.model).toBe('atomic/m')
    expect(written.provider.atomic.name).toBe('Atomic Chat')
  })

  it('leaves it byte for byte when nothing in it is ours', async () => {
    const h = await fresh()
    // Rewriting would drop the comment, so an unchanged file proves it was not rewritten.
    const theirs =
      '{\n  // mine\n  "model": "openrouter/x",\n  "provider": {"atomic": {"name": "Their own"}}\n}\n'
    await h.seed(PATH, theirs)
    await writeOpencodeStyleConfig(agentInput(h.fs), JSONC_TARGET, SPEC)
    expect(await h.read(PATH)).toBe(theirs)
  })

  it.each([
    ['missing', undefined],
    ['unreadable', '{ "model": '],
  ])('leaves it as it is when it is %s, and still writes the config', async (_label, body) => {
    const h = await fresh()
    if (body !== undefined) await h.seed(PATH, body)
    await writeOpencodeStyleConfig(agentInput(h.fs, { model: 'm' }), JSONC_TARGET, SPEC)
    const tree = await h.tree()
    expect(Object.keys(tree)).toEqual(body === undefined ? [JSONC] : [PATH, JSONC])
    expect(tree[PATH]).toBe(body)
    expect(JSON.parse(tree[JSONC] as string).model).toBe('atomic/m')
  })
})

describe('readRoot', () => {
  it('reads a missing file as an empty object and refuses comments when strict', async () => {
    const h = await fresh()
    expect(await readRoot(h.fs, PATH, false)).toEqual({})
    await h.seed(PATH, '{\n  // hello\n  "a": 1\n}\n')
    expect(await readRoot(h.fs, PATH, true)).toEqual({ a: 1 })
    await expect(readRoot(h.fs, PATH, false)).rejects.toThrow(/Failed to parse/)
  })
})
