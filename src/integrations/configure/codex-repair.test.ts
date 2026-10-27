import { chmod, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome } from '../../../test/helpers/agent-config-home.js'
import type { AgentHome } from '../../../test/helpers/agent-config-home.js'
import { ATOMIC_MANAGED_BEGIN as BEGIN, ATOMIC_MANAGED_END as END } from '../config-io.js'
import type { ConfigFs } from '../config-io.js'
import { configureCodex } from './codex.js'
import {
  codexBackupPath,
  planCodexConfigRepair,
  recogniseLegacyRegion,
  repairLegacyCodexConfig,
} from './codex-repair.js'

const CONFIG = '.codex/config.toml'
const BACKUP = '.codex/config.toml.atomic-chat-backup'

// What the V2 writers put around the user's content: the Rust one joined
// `head + "\n" + user.trim() + "\n" + tail`, the core one kept the user's leading blank lines.
const HEAD = `${BEGIN}\nmodel = "AtomicChat/Qwen3.5-9B-GGUF"\nmodel_provider = "atomic"\n${END}\n`
const TAIL =
  `${BEGIN}\n[model_providers.atomic]\nname = "Atomic Chat"\nbase_url = "http://127.0.0.1:1337/v1"\n` +
  `env_key = "ATOMIC_CHAT_API_KEY"\n${END}\n`
const KEYLESS_TAIL = `${BEGIN}\n[model_providers.atomic]\nname = "Atomic Chat"\nbase_url = "http://h/v1"\n${END}\n`
// V1: one region at the end, the provider table and a `[profiles.atomic]` that named it.
const V1_REGION =
  `${BEGIN}\n[model_providers.atomic]\nname = "Atomic Chat"\nbase_url = "http://127.0.0.1:1337/v1"\n\n` +
  `[profiles.atomic]\nmodel = "AtomicChat/Gemma-4"\nmodel_provider = "atomic"\n${END}\n`

/** The incident: the user's own root `model`, so the file as Atomic Chat left it had it twice. */
const USER = 'model = "gpt-5.5"\napproval_policy = "on-request"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n'
const INCIDENT = `${HEAD}\n${USER.trim()}\n${TAIL}`

const PATH = '/home/u/.codex/config.toml'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

const dirOf = (h: AgentHome) => join(h.path, '.codex')
const repair = (h: AgentHome, fs: ConfigFs = h.fs, platform: NodeJS.Platform = 'darwin') =>
  repairLegacyCodexConfig(fs, dirOf(h), platform)

describe('planCodexConfigRepair', () => {
  it('removes the V2 regions of the incident and keeps the user’s own root model', () => {
    expect(() => parseToml(INCIDENT), 'the file Codex refused to start with').toThrow(/redefine/)
    const plan = planCodexConfigRepair(INCIDENT, PATH)
    expect(plan).toEqual({
      kind: 'repair',
      text: USER,
      legacy: { model: 'AtomicChat/Qwen3.5-9B-GGUF', baseUrl: 'http://127.0.0.1:1337/v1', keyed: true },
    })
    const repaired = parseToml(plan.kind === 'repair' ? plan.text : '')
    expect(repaired['model']).toBe('gpt-5.5')
    expect(repaired).not.toHaveProperty('model_provider')
    expect(repaired).not.toHaveProperty('model_providers')
  })

  it('removes a V1 region and reads its model from the profile table', () => {
    expect(planCodexConfigRepair(`${USER}\n${V1_REGION}`, PATH)).toEqual({
      kind: 'repair',
      text: USER,
      legacy: { model: 'AtomicChat/Gemma-4', baseUrl: 'http://127.0.0.1:1337/v1', keyed: false },
    })
  })

  it('drops the blank lines a head block left at the top, but no other leading lines', () => {
    // The core writer kept every blank line a previous strip left behind.
    const core = `${HEAD}\n\n\n  approval_policy = "never"\n${KEYLESS_TAIL}`
    expect(planCodexConfigRepair(core, PATH)).toMatchObject({ text: '  approval_policy = "never"\n' })
    const notAtTop = `\n# mine\n${KEYLESS_TAIL}`
    expect(planCodexConfigRepair(notAtTop, PATH)).toMatchObject({ text: '\n# mine\n' })
  })

  it('leaves an empty file when the regions were all there was', () => {
    expect(planCodexConfigRepair(`${HEAD}\n${KEYLESS_TAIL}`, PATH)).toEqual({
      kind: 'repair',
      text: '',
      legacy: { model: 'AtomicChat/Qwen3.5-9B-GGUF', baseUrl: 'http://h/v1', keyed: false },
    })
    expect(planCodexConfigRepair(`${HEAD}\n \t\n\n`, PATH)).toMatchObject({
      text: '',
      legacy: { keyed: false },
    })
  })

  it('accepts CRLF files: markers match without their \\r, and the user’s lines keep theirs', () => {
    const crlf = (s: string) => s.replace(/\n/g, '\r\n')
    const user = 'model = "gpt-5.5"\r\n[tui]\r\nx = 1\r\n'
    const file = `${crlf(HEAD)}\r\n${user}${crlf(TAIL)}`
    expect(planCodexConfigRepair(file, PATH)).toMatchObject({
      kind: 'repair',
      text: 'model = "gpt-5.5"\r\n[tui]\r\nx = 1\n',
    })
  })

  it('needs no newline after the last line, the end marker included', () => {
    const tail = TAIL.slice(0, -1)
    expect(planCodexConfigRepair(`${HEAD}\nmodel = "gpt-5.5"\n${tail}`, PATH)).toMatchObject({
      kind: 'repair',
      text: 'model = "gpt-5.5"\n',
    })
    expect(planCodexConfigRepair(`${HEAD}\nmodel = "gpt-5.5"`, PATH)).toMatchObject({
      text: 'model = "gpt-5.5"\n',
    })
  })

  it('is clean for a file with no markers at all', () => {
    expect(planCodexConfigRepair('', PATH)).toEqual({ kind: 'clean' })
    expect(planCodexConfigRepair(USER, PATH)).toEqual({ kind: 'clean' })
    expect(
      planCodexConfigRepair('this is = not [valid toml\n', PATH),
      'never parsed without markers'
    ).toEqual({
      kind: 'clean',
    })
  })

  it('reports only the model or only the endpoint when that is all the regions held', () => {
    expect(planCodexConfigRepair(HEAD, PATH)).toMatchObject({
      legacy: { model: 'AtomicChat/Qwen3.5-9B-GGUF', keyed: false },
    })
    const tailOnly = planCodexConfigRepair(`${USER}${TAIL}`, PATH)
    expect(tailOnly).toMatchObject({
      text: USER,
      legacy: { baseUrl: 'http://127.0.0.1:1337/v1', keyed: true },
    })
    expect(tailOnly.kind === 'repair' && tailOnly.legacy).not.toHaveProperty('model')
  })

  const conflicts: Array<[string, string, RegExp]> = [
    ['a nested block', `${BEGIN}\n${HEAD}${END}\n`, /line 2 opens a block inside the one opened on line 1/],
    ['an unclosed block', `${USER}${BEGIN}\nmodel = "m"\n`, /block opened on line 6 is never closed/],
    ['a stray end marker', `${USER}${END}\n${HEAD}`, /line 6 closes a block that was never opened/],
    [
      'a marker inside a line',
      `# was: ${BEGIN}\n${HEAD}`,
      /line 1 has an Atomic Chat marker inside other text/,
    ],
    ['an indented marker', `  ${BEGIN}\nmodel = "m"\n${END}\n`, /line 1 has an Atomic Chat marker/],
    ['a marker with trailing text', `${HEAD}${END} \n`, /line 5 has an Atomic Chat marker/],
    [
      'a marker with a second \\r',
      `${HEAD}${BEGIN}\r\r\nmodel = "m"\n${END}\n`,
      /line 5 has an Atomic Chat marker/,
    ],
    [
      'an unknown key in a block',
      `${BEGIN}\nmodel = "m"\napproval_policy = "never"\n${END}\n`,
      /block 1 \(lines 1–4\) has settings Atomic Chat never writes/,
    ],
    [
      'invalid TOML in a block',
      `${USER}${BEGIN}\nmodel = = "m"\n${END}\n`,
      /block 1 \(lines 6–8\) is not valid TOML \(Invalid TOML document/,
    ],
    ['an empty block', `${BEGIN}\n# nothing\n${END}\n`, /block 1 .* never writes/],
  ]
  it.each(conflicts)('refuses %s and says which lines to remove', (_name, file, problem) => {
    const plan = planCodexConfigRepair(file, PATH)
    expect(plan.kind).toBe('conflict')
    const reason = plan.kind === 'conflict' ? plan.reason : ''
    expect(reason).toMatch(problem)
    expect(reason).toContain(PATH)
    expect(reason).toContain(`Remove the lines between "${BEGIN}" and "${END}" by hand`)
  })

  it('refuses when the file would still not parse, naming the line in the file as it is', () => {
    const file = `${HEAD}\n[tui]\nthis is = not [valid toml\n${TAIL}`
    const plan = planCodexConfigRepair(file, PATH)
    expect(plan.kind).toBe('conflict')
    const reason = plan.kind === 'conflict' ? plan.reason : ''
    expect(reason).toMatch(
      new RegExp(
        `^${PATH} would still not be valid TOML after removing Atomic Chat's settings: ` +
          'Invalid TOML document: [^(]+ \\(line 7\\)\\.'
      )
    )
    expect(reason).toContain('by hand')
    // An error at the very end has no line of the file to point at.
    expect(planCodexConfigRepair(`x = [\n${KEYLESS_TAIL}`, PATH)).toMatchObject({
      reason: expect.stringMatching(
        /not be valid TOML after removing Atomic Chat's settings: [^(]+\. Fix/
      ) as unknown as string,
    })
  })

  it('accepts the user’s own 64-bit integers as valid TOML', () => {
    expect(planCodexConfigRepair(`big = 9223372036854775807\n${KEYLESS_TAIL}`, PATH)).toMatchObject({
      kind: 'repair',
    })
  })
})

describe('recogniseLegacyRegion', () => {
  const provider = { name: 'Atomic Chat', base_url: 'http://h/v1' }
  it.each([
    ['the V2 head', { model: 'm', model_provider: 'atomic' }, { model: 'm', keyed: false }],
    ['a head without its provider line', { model: 'm' }, { model: 'm', keyed: false }],
    [
      'a keyless V2 tail',
      { model_providers: { atomic: provider } },
      { baseUrl: 'http://h/v1', keyed: false },
    ],
    [
      'a keyed V2 tail',
      { model_providers: { atomic: { ...provider, env_key: 'ATOMIC_CHAT_API_KEY' } } },
      { baseUrl: 'http://h/v1', keyed: true },
    ],
    [
      'a V1 region',
      {
        model_providers: { atomic: provider },
        profiles: { atomic: { model: 'p', model_provider: 'atomic' } },
      },
      { model: 'p', baseUrl: 'http://h/v1', keyed: false },
    ],
  ])('recognises %s', (_name, doc, settings) => {
    expect(recogniseLegacyRegion(doc)).toEqual(settings)
  })

  it.each([
    ['nothing at all', {}],
    ['a foreign root key', { model: 'm', approval_policy: 'never' }],
    ['a model that is not a string', { model: 5 }],
    ['another provider selected', { model: 'm', model_provider: 'openai' }],
    ['a provider beside ours', { model_providers: { atomic: provider, openai: provider } }],
    ['a provider table that is a value', { model_providers: { atomic: 'x' } }],
    ['model_providers that is not a table', { model_providers: [provider] }],
    ['a provider key we never wrote', { model_providers: { atomic: { ...provider, wire_api: 'chat' } } }],
    ['a renamed provider', { model_providers: { atomic: { ...provider, name: 'Mine' } } }],
    ['a provider without a URL', { model_providers: { atomic: { name: 'Atomic Chat' } } }],
    ['another key variable', { model_providers: { atomic: { ...provider, env_key: 'OPENAI_API_KEY' } } }],
    ['a profile beside ours', { profiles: { atomic: { model: 'p', model_provider: 'atomic' }, mine: {} } }],
    [
      'a profile key we never wrote',
      { profiles: { atomic: { model: 'p', model_provider: 'atomic', x: 1 } } },
    ],
    ['a profile on another provider', { profiles: { atomic: { model: 'p', model_provider: 'openai' } } }],
    ['a profile without a model', { profiles: { atomic: { model_provider: 'atomic' } } }],
    ['a date where a table belongs', { profiles: new Date(0) }],
  ])('does not recognise %s', (_name, doc) => {
    expect(recogniseLegacyRegion(doc as Record<string, unknown>)).toBeUndefined()
  })
})

describe('codexBackupPath', () => {
  it('numbers every backup after the first from 2', () => {
    expect(codexBackupPath('/c/config.toml', 1)).toBe('/c/config.toml.atomic-chat-backup')
    expect(codexBackupPath('/c/config.toml', 2)).toBe('/c/config.toml.atomic-chat-backup-2')
    expect(codexBackupPath('/c/config.toml', 3)).toBe('/c/config.toml.atomic-chat-backup-3')
  })
})

describe('repairLegacyCodexConfig', () => {
  it('is clean when there is no config.toml, and writes nothing', async () => {
    home = await makeAgentHome()
    expect(await repair(home)).toEqual({ kind: 'clean' })
    expect(await home.tree()).toEqual({})
  })

  it('is clean for a config with nothing of ours, which it leaves alone', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, USER)
    expect(await repair(home)).toEqual({ kind: 'clean' })
    expect(await home.tree()).toEqual({ [CONFIG]: USER })
  })

  it('repairs the incident: the result parses, the original bytes are in the backup', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    expect(await repair(home)).toEqual({
      kind: 'repaired',
      backupPath: join(home.path, BACKUP),
      legacy: { model: 'AtomicChat/Qwen3.5-9B-GGUF', baseUrl: 'http://127.0.0.1:1337/v1', keyed: true },
    })
    expect(await home.tree()).toEqual({ [CONFIG]: USER, [BACKUP]: INCIDENT })
    expect(parseToml((await home.read(CONFIG)) ?? '')['model']).toBe('gpt-5.5')
  })

  it('is clean the second time and never makes a second backup of its own work', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    await repair(home)
    expect(await repair(home)).toEqual({ kind: 'clean' })
    expect(Object.keys(await home.tree())).toEqual([CONFIG, BACKUP])
  })

  it('never overwrites an earlier backup: the next one is -2, then -3', async () => {
    home = await makeAgentHome()
    await home.seed(BACKUP, 'older\n')
    await home.seed(CONFIG, INCIDENT)
    expect(await repair(home)).toMatchObject({ backupPath: join(home.path, `${BACKUP}-2`) })
    await home.seed(CONFIG, `${USER}${TAIL}`)
    expect(await repair(home)).toMatchObject({ backupPath: join(home.path, `${BACKUP}-3`) })
    const tree = await home.tree()
    expect(tree[BACKUP]).toBe('older\n')
    expect(tree[`${BACKUP}-2`]).toBe(INCIDENT)
    expect(tree[`${BACKUP}-3`]).toBe(`${USER}${TAIL}`)
  })

  it.skipIf(process.platform === 'win32')('keeps the permission bits of the file it repairs', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    // Group-writable: a plain rewrite under the usual 022 umask would lose that bit.
    await chmod(join(home.path, CONFIG), 0o660)
    await repair(home)
    expect((await stat(join(home.path, CONFIG))).mode & 0o777).toBe(0o660)
    expect(
      (await stat(join(home.path, BACKUP))).mode & 0o007,
      'the backup is no more open than the file'
    ).toBe(0)
  })

  it('does not ask for permission bits on Windows, where there are none to keep', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    const fs: ConfigFs = {
      ...home.fs,
      permissions: () => Promise.reject(new Error('must not be called on Windows')),
    }
    expect(await repair(home, fs, 'win32')).toMatchObject({ kind: 'repaired' })
    expect(await home.read(CONFIG)).toBe(USER)
  })

  it.each([
    ['nested', `${BEGIN}\n${HEAD}${END}\n`],
    ['unclosed', `${USER}${BEGIN}\nmodel = "m"\n`],
    ['stray end', `${USER}${END}\n`],
    ['marker inside a line', `# ${END}\n${HEAD}`],
    ['unknown key in a block', `${BEGIN}\nmodel = "m"\nsandbox_mode = "danger-full-access"\n${END}\n${USER}`],
    ['invalid TOML in a block', `${HEAD}${BEGIN}\n[model_providers.atomic\n${END}\n`],
    ['user TOML still broken', `${HEAD}\nthis is = not [valid toml\n`],
  ])('leaves the file byte-identical on a conflict (%s)', async (_name, file) => {
    home = await makeAgentHome()
    await home.seed(CONFIG, file)
    const result = await repair(home)
    expect(result.kind).toBe('conflict')
    expect(await home.tree()).toEqual({ [CONFIG]: file })
  })

  it('is an error, not "absent", when the file cannot be read', async () => {
    home = await makeAgentHome()
    await home.seed(`${CONFIG}/not-a-file`, '')
    await expect(repair(home)).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: `Failed to read ${join(home.path, CONFIG)}`,
    })
  })

  it('is an error for a file that is not UTF-8, which it leaves as it was', async () => {
    home = await makeAgentHome()
    const fs: ConfigFs = { ...home.fs, readStrict: () => Promise.reject(new TypeError('not valid utf-8')) }
    await expect(repair(home, fs)).rejects.toMatchObject({ code: 'IO_ERROR', details: 'not valid utf-8' })
  })

  it('is an error when the permission bits cannot be read, and writes nothing', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    const fs: ConfigFs = { ...home.fs, permissions: () => Promise.reject(new Error('EACCES')) }
    await expect(repair(home, fs)).rejects.toMatchObject({ code: 'IO_ERROR', details: 'EACCES' })
    expect(await home.tree()).toEqual({ [CONFIG]: INCIDENT })
  })

  it('backs off when the file changed while it was deciding', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    let reads = 0
    const fs: ConfigFs = {
      ...home.fs,
      readStrict: async (path) => {
        // Someone saves the file between the first read and the check before the backup.
        if (++reads === 2) await home.seed(CONFIG, `${INCIDENT}# edited\n`)
        return home.fs.readStrict(path)
      },
    }
    const result = await repair(home, fs)
    expect(result).toMatchObject({ kind: 'conflict', reason: expect.stringContaining('it changed while') })
    expect(await home.tree()).toEqual({ [CONFIG]: `${INCIDENT}# edited\n` })
  })

  it('writes nothing when the backup cannot be made', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    const fs: ConfigFs = { ...home.fs, createNew: () => Promise.reject(new Error('ENOSPC')) }
    await expect(repair(home, fs)).rejects.toMatchObject({
      code: 'IO_ERROR',
      message: expect.stringContaining('so it was left as it was') as unknown as string,
      details: 'ENOSPC',
    })
    expect(await home.tree()).toEqual({ [CONFIG]: INCIDENT })
  })

  it('reports a failed write, leaving the original in place beside its backup', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    const fs: ConfigFs = { ...home.fs, write: () => Promise.reject(new Error('EROFS')) }
    await expect(repair(home, fs)).rejects.toMatchObject({ code: 'IO_ERROR', details: 'EROFS' })
    expect(await home.tree()).toEqual({ [CONFIG]: INCIDENT, [BACKUP]: INCIDENT })
  })

  it('runs as the first step of connecting Codex', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, INCIDENT)
    await configureCodex(agentInput(home.fs))
    const tree = await home.tree()
    expect(tree[CONFIG]).toBe(USER)
    expect(tree[BACKUP]).toBe(INCIDENT)
    expect(tree['.codex/atomic-chat.config.toml']).toContain('model_provider = "atomic-chat"')
  })
})
