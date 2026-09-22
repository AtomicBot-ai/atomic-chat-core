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
    expect(childEnv(agent('copilot'), 'http://h/v1', 'm', 'k')).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'http://h/v1',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_MODEL: 'm',
      COPILOT_OFFLINE: 'true',
      COPILOT_PROVIDER_API_KEY: 'k',
    })
    expect(childEnv(agent('goose'), 'http://h', 'm', '')).toEqual({
      GOOSE_PROVIDER: 'openai',
      GOOSE_MODEL: 'm',
      OPENAI_HOST: 'http://h',
      OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'atomic',
    })
    expect(childEnv(agent('openhands'), 'http://h/v1', 'm', 'k')).toEqual({
      LLM_MODEL: 'openai/m',
      LLM_BASE_URL: 'http://h/v1',
      LLM_API_KEY: 'k',
    })
    expect(childEnv(agent('poolside'), 'http://h/v1', 'm', '')).toEqual({
      POOLSIDE_STANDALONE_BASE_URL: 'http://h',
      POOLSIDE_API_KEY: 'atomic',
      POOLSIDE_STANDALONE_MODEL: 'm',
    })
    expect(childEnv(agent('muse'), 'http://h/v1', 'm', 'k')).toEqual({ META_API_KEY: 'k' })
    expect(childEnv(agent('codex'), 'http://h/v1', 'm', 'k')).toEqual({})
  })

  it('omits the Copilot key when there is none, instead of sending the word "atomic"', () => {
    expect(childEnv(agent('copilot'), 'http://h/v1', 'm', '')).not.toHaveProperty('COPILOT_PROVIDER_API_KEY')
  })

  it('lists the ambient credentials that must be cleared on the child', () => {
    expect(CONFLICTING_PROVIDER_ENV).toContain('OPENAI_API_KEY')
    expect(CONFLICTING_PROVIDER_ENV).toContain('ANTHROPIC_API_KEY')
    expect(CONFLICTING_PROVIDER_ENV).toContain('OPENROUTER_API_KEY')
    expect(new Set(CONFLICTING_PROVIDER_ENV).size).toBe(CONFLICTING_PROVIDER_ENV.length)
  })
})

describe('poolsideStandaloneBaseUrl', () => {
  it('strips the API prefix and any trailing slashes', () => {
    expect(poolsideStandaloneBaseUrl('http://127.0.0.1:1337/v1')).toBe('http://127.0.0.1:1337')
    expect(poolsideStandaloneBaseUrl('http://127.0.0.1:1337/v1/')).toBe('http://127.0.0.1:1337')
    expect(poolsideStandaloneBaseUrl('  http://127.0.0.1:1337//  ')).toBe('http://127.0.0.1:1337')
    expect(poolsideStandaloneBaseUrl('http://127.0.0.1:1337')).toBe('http://127.0.0.1:1337')
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

  // `zcode_app_candidates` (`core/system/commands.rs`, app commit ec1fd3ea7).
  it("knows where ZCode's installers put the desktop app", () => {
    expect(offPathCandidates('zcode', '/Users/u', {}, 'darwin')).toEqual([
      '/Applications/ZCode.app/Contents/MacOS/ZCode',
      '/Users/u/Applications/ZCode.app/Contents/MacOS/ZCode',
    ])
    expect(offPathCandidates('zcode', undefined, {}, 'darwin')).toEqual([
      '/Applications/ZCode.app/Contents/MacOS/ZCode',
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
      'C:\\Program Files\\ZCode\\ZCode.exe',
    ])
    expect(offPathCandidates('zcode', 'C:\\Users\\u', {}, 'win32')).toEqual([])
    expect(offPathCandidates('zcode', '/home/u', {}, 'linux')).toEqual(['/opt/ZCode/zcode'])
  })

  it('guesses nothing for the agents that install onto PATH', () => {
    for (const bin of ['codex', 'claude', 'zed'])
      expect(offPathCandidates(bin, '/home/u', {}, 'linux')).toEqual([])
  })
})
