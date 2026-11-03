import { describe, expect, it } from 'vitest'
import {
  AGENTS,
  apiUrlFor,
  childEnv,
  CONFLICTING_PROVIDER_ENV,
  findAgent,
  HERMES_CONTEXT_LENGTH,
  offPathCandidates,
  poolsideStandaloneBaseUrl,
  runArgsFor,
} from './catalog.js'

const agent = (id: string) => {
  const found = findAgent(id)
  if (!found) throw new Error(`no agent ${id}`)
  return found
}

describe('the catalog', () => {
  it('lists the 20 agents the Launch page configures, in order', () => {
    expect(AGENTS.map((a) => a.id)).toEqual([
      'kilo',
      'claude-code',
      'pi',
      'codex',
      'opencode',
      'openclaude',
      'cline',
      'dsh',
      'zed',
      'zcode',
      'mimo',
      'droid',
      'copilot',
      'openhands',
      'poolside',
      'goose',
      'muse',
      'atomic-agent',
      'hermes',
      'openclaw',
    ])
  })

  it('has unique lowercase ids and aliases, and no GUI editors', () => {
    const ids = new Set<string>()
    for (const a of AGENTS) {
      expect(ids.has(a.id), `duplicate id ${a.id}`).toBe(false)
      ids.add(a.id)
      expect(a.id).toBe(a.id.toLowerCase())
      for (const alias of a.aliases) expect(alias).toBe(alias.toLowerCase())
      expect(a.detectBin.length).toBeGreaterThan(0)
      expect(a.docsUrl.startsWith('https://')).toBe(true)
    }
    for (const editor of ['vscode', 'jetbrains', 'xcode']) expect(ids.has(editor)).toBe(false)
  })

  it('remembers the launchers that need arguments to be useful', () => {
    expect(agent('dsh').runArgs).toEqual(['web'])
    expect(agent('goose').runArgs).toEqual(['session'])
    expect(agent('openhands').runArgs).toEqual(['--override-with-envs'])
    expect(agent('openclaw').runArgs).toEqual(['chat'])
    expect(agent('codex').runArgs, 'Codex runs on our profile, not its shared config').toEqual([
      '--profile',
      'atomic-chat',
    ])
    expect(agent('zed').runMode).toBe('gui')
    expect(agent('zcode').runMode).toBe('gui')
    expect(agent('codex').runMode).toBe('terminal')
    expect(HERMES_CONTEXT_LENGTH).toBe(65_536)
  })
})

describe('findAgent', () => {
  it('accepts an id, the binary name, and an alias, case-insensitively', () => {
    expect(findAgent('claude-code')?.id).toBe('claude-code')
    expect(findAgent('claude')?.id).toBe('claude-code')
    expect(findAgent('CLAUDE')?.id).toBe('claude-code')
    expect(findAgent('  claudecode ')?.id).toBe('claude-code')
    expect(findAgent('pool')?.id).toBe('poolside')
    expect(findAgent('poolside')?.id).toBe('poolside')
    expect(findAgent('atag')?.id).toBe('atomic-agent')
    expect(findAgent('definitely-not-an-agent')).toBeUndefined()
    expect(findAgent('')).toBeUndefined()
  })
})

describe('apiUrlFor', () => {
  it('adds the prefix only for agents that do not append their own', () => {
    expect(apiUrlFor(agent('codex'), 'http://127.0.0.1:1337', '/v1')).toBe('http://127.0.0.1:1337/v1')
    expect(apiUrlFor(agent('claude-code'), 'http://127.0.0.1:1337', '/v1')).toBe('http://127.0.0.1:1337')
    expect(apiUrlFor(agent('goose'), 'http://127.0.0.1:1337', '/v1')).toBe('http://127.0.0.1:1337')
    expect(apiUrlFor(agent('codex'), 'http://127.0.0.1:1337', '')).toBe('http://127.0.0.1:1337')
  })
})

describe('childEnv', () => {
  it('sets what each env-configured agent reads, and nothing for the rest', () => {
    // Copilot's endpoint and key live in providers.json; the run only selects our model there.
    expect(childEnv(agent('copilot'), 'http://h/v1', 'm', 'k')).toEqual({ COPILOT_MODEL: 'atomic-chat/m' })
    expect(childEnv(agent('goose'), 'http://h', 'm', '')).toEqual({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'm',
      OPENAI_BASE_URL: 'http://h/v1',
      OPENAI_API_KEY: 'atomic',
    })
    expect(childEnv(agent('openhands'), 'http://h/v1', 'm', 'k')).toEqual({
      LLM_MODEL: 'openai/m',
      LLM_BASE_URL: 'http://h/v1',
      LLM_API_KEY: 'k',
    })
    expect(childEnv(agent('poolside'), 'http://h/v1', 'm', '')).toEqual({
      POOLSIDE_STANDALONE_BASE_URL: 'http://h/v1',
      POOLSIDE_API_KEY: 'atomic',
      POOLSIDE_STANDALONE_MODEL: 'm',
    })
    expect(childEnv(agent('poolside'), 'http://h/v1', 'm', 'k', { contextLength: 32768 })).toMatchObject({
      POOLSIDE_STANDALONE_CONTEXT_LENGTH: '32768',
    })
    expect(childEnv(agent('muse'), 'http://h/v1', 'm', 'k')).toEqual({ META_API_KEY: 'k' })
    expect(childEnv(agent('codex'), 'http://h/v1', 'm', 'k')).toEqual({ ATOMIC_CHAT_API_KEY: 'k' })
    expect(childEnv(agent('kilo'), 'http://h/v1', 'm', 'k')).toEqual({})
  })

  it('gives Goose the server prefix, and its window and output cap when known', () => {
    expect(
      childEnv(agent('goose'), 'http://h', 'm', 'k', { contextLength: 16384, apiPrefix: '/api/v1' })
    ).toEqual({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'm',
      OPENAI_BASE_URL: 'http://h/api/v1',
      OPENAI_API_KEY: 'k',
      GOOSE_CONTEXT_LIMIT: '16384',
      GOOSE_MAX_TOKENS: '4096',
    })
    expect(
      childEnv(agent('goose'), 'http://h', 'm', 'k', { contextLength: 262144 })['GOOSE_MAX_TOKENS']
    ).toBe('8192')
  })

  it('starts Kilo on our model, and every other agent on its fixed arguments', () => {
    expect(runArgsFor(agent('kilo'), 'org/m')).toEqual(['--model', 'atomic/org/m'])
    expect(runArgsFor(agent('kilo'), '')).toEqual([])
    expect(runArgsFor(agent('goose'), 'm')).toEqual(['session'])
  })

  it('gives Codex no key variable for a keyless server, whose profile names none', () => {
    expect(childEnv(agent('codex'), 'http://h/v1', 'm', '')).toEqual({})
  })

  it('never puts the Copilot key in the environment', () => {
    expect(childEnv(agent('copilot'), 'http://h/v1', 'm', 'k')).not.toHaveProperty('COPILOT_PROVIDER_API_KEY')
  })

  it('lists the ambient credentials that must be cleared on the child', () => {
    expect(CONFLICTING_PROVIDER_ENV).toContain('OPENAI_API_KEY')
    expect(CONFLICTING_PROVIDER_ENV).toContain('ANTHROPIC_API_KEY')
    expect(CONFLICTING_PROVIDER_ENV).toContain('OPENROUTER_API_KEY')
    expect(new Set(CONFLICTING_PROVIDER_ENV).size).toBe(CONFLICTING_PROVIDER_ENV.length)
  })
})

describe('poolsideStandaloneBaseUrl', () => {
  it('keeps the API prefix Poolside documents, and drops trailing slashes', () => {
    expect(poolsideStandaloneBaseUrl('http://127.0.0.1:1337/v1')).toBe('http://127.0.0.1:1337/v1')
    expect(poolsideStandaloneBaseUrl('http://127.0.0.1:1337/v1/')).toBe('http://127.0.0.1:1337/v1')
    expect(poolsideStandaloneBaseUrl('  http://127.0.0.1:1337//  ')).toBe('http://127.0.0.1:1337')
  })
})

describe('offPathCandidates', () => {
  it('knows where the OpenClaw installer puts its launcher', () => {
    expect(offPathCandidates('openclaw', '/home/u', {}, 'linux')).toEqual([
      '/home/u/.openclaw/bin/openclaw',
      '/home/u/.local/bin/openclaw',
    ])
    expect(offPathCandidates('openclaw', '/home/u', { OPENCLAW_PREFIX: '/opt/oc' }, 'linux')).toEqual([
      '/opt/oc/bin/openclaw',
      '/home/u/.openclaw/bin/openclaw',
      '/home/u/.local/bin/openclaw',
    ])
    expect(offPathCandidates('openclaw', 'C:\\Users\\u', {}, 'win32')).toEqual([
      'C:\\Users\\u\\.openclaw\\bin\\openclaw.cmd',
      'C:\\Users\\u\\.openclaw\\bin\\openclaw.exe',
      'C:\\Users\\u\\.openclaw\\bin\\openclaw',
      'C:\\Users\\u\\.local\\bin\\openclaw.cmd',
      'C:\\Users\\u\\.local\\bin\\openclaw.exe',
      'C:\\Users\\u\\.local\\bin\\openclaw',
    ])
    expect(offPathCandidates('codex', '/home/u', {}, 'linux')).toEqual([])
    expect(offPathCandidates('openclaw', undefined, {}, 'linux')).toEqual([])
    expect(offPathCandidates('openclaw', '/home/u', { OPENCLAW_PREFIX: '   ' }, 'linux')).toHaveLength(2)
  })

  // `zcode_app_candidates_for` (`core/system/commands.rs`).
  it("knows where ZCode's installers put the desktop app, Preview build included", () => {
    expect(offPathCandidates('zcode', '/Users/u', {}, 'darwin')).toEqual([
      '/Applications/ZCode.app/Contents/MacOS/ZCode',
      '/Applications/ZCode Preview.app/Contents/MacOS/ZCode Preview',
      '/Users/u/Applications/ZCode.app/Contents/MacOS/ZCode',
      '/Users/u/Applications/ZCode Preview.app/Contents/MacOS/ZCode Preview',
    ])
    expect(offPathCandidates('zcode', undefined, {}, 'darwin')).toEqual([
      '/Applications/ZCode.app/Contents/MacOS/ZCode',
      '/Applications/ZCode Preview.app/Contents/MacOS/ZCode Preview',
    ])
    expect(
      offPathCandidates(
        'zcode',
        'C:\\Users\\u',
        { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
        'win32'
      )
    ).toEqual([
      'C:\\Users\\u\\AppData\\Local\\Programs\\ZCode\\ZCode.exe',
      'C:\\Users\\u\\AppData\\Local\\Programs\\ZCode Preview\\ZCode Preview.exe',
      'C:\\Program Files\\ZCode\\ZCode.exe',
      'C:\\Program Files\\ZCode Preview\\ZCode Preview.exe',
    ])
    expect(offPathCandidates('zcode', 'C:\\Users\\u', {}, 'win32')).toEqual([])
    expect(offPathCandidates('zcode', '/home/u', {}, 'linux')).toEqual([
      '/opt/ZCode/zcode',
      '/opt/ZCode Preview/zcode-preview',
      '/usr/bin/zcode-preview',
    ])
  })

  // `zed_cli_candidates` / `zed_app_candidates` (`core/system/commands.rs`).
  it("finds Zed's CLI, then the editor, where its installers put them", () => {
    expect(offPathCandidates('zed', '/Users/u', {}, 'darwin')).toEqual([
      '/Users/u/.local/bin/zed',
      '/Applications/Zed.app/Contents/MacOS/cli',
      '/Applications/Zed Preview.app/Contents/MacOS/cli',
      '/Users/u/Applications/Zed.app/Contents/MacOS/cli',
      '/Users/u/Applications/Zed Preview.app/Contents/MacOS/cli',
      '/Applications/Zed.app/Contents/MacOS/zed',
      '/Users/u/Applications/Zed.app/Contents/MacOS/zed',
    ])
    expect(offPathCandidates('zed', '/home/u', {}, 'linux')).toEqual([
      '/home/u/.local/bin/zed',
      '/home/u/.local/zed.app/bin/zed',
      '/home/u/.local/zed-preview.app/bin/zed',
    ])
    expect(offPathCandidates('zed', 'C:\\Users\\u', { ProgramFiles: 'C:\\Program Files' }, 'win32')).toEqual([
      'C:\\Users\\u\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe',
      'C:\\Program Files\\Zed\\bin\\zed.exe',
      'C:\\Users\\u\\AppData\\Local\\Programs\\Zed\\Zed.exe',
      'C:\\Program Files\\Zed\\Zed.exe',
    ])
    expect(offPathCandidates('zed', undefined, {}, 'linux')).toEqual([])
  })

  it('guesses nothing for the agents that install onto PATH', () => {
    for (const bin of ['codex', 'claude', 'opencode'])
      expect(offPathCandidates(bin, '/home/u', {}, 'linux')).toEqual([])
  })
})
