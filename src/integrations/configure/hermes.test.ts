import { afterEach, describe, expect, it } from 'vitest'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import {
  configureHermes,
  hermesDir,
  rebuildCustomProviders,
  replaceYamlScalarValue,
  splitCustomProviders,
  upsertAtomicProvider,
  upsertProviderRequestTimeout,
} from './hermes.js'

const CONFIG = '.hermes/config.yaml'

let home: AgentHome
afterEach(async () => {
  await home?.cleanup()
})

describe('the line-level YAML edits', () => {
  it('rewrites everything after the first colon, and leaves a colon-less line alone', () => {
    expect(replaceYamlScalarValue('  base_url: "http://old"  # note', 'http://new')).toBe(
      '  base_url: http://new'
    )
    expect(replaceYamlScalarValue('not a mapping line', 'x')).toBe('not a mapping line')
  })

  it('recognises every spelling of an empty custom_providers list', () => {
    for (const line of ['custom_providers: []', 'custom_providers:[]', '  custom_providers: []']) {
      expect(splitCustomProviders(`a: 1\n${line}\nb: 2\n`).entries, line).toEqual([])
    }
  })

  it('drops blank lines inside the block and re-emits items at column 0', () => {
    const { before, entries, after } = splitCustomProviders(
      'a: 1\ncustom_providers:\n- name: one\n\n  model: m\n\n- name: two\ntools: {}\n'
    )
    expect(before).toEqual(['a: 1'])
    expect(entries).toEqual([['- name: one', '  model: m'], ['- name: two']])
    expect(after).toEqual(['tools: {}'])
  })

  it('collapses to the empty-list form when the last entry is removed', () => {
    expect(rebuildCustomProviders(['a: 1', '', ''], [], ['b: 2'])).toBe('a: 1\ncustom_providers: []\nb: 2\n')
  })

  it('replaces our entry wherever it sits, quoted name included, and appends it last', () => {
    const out = upsertAtomicProvider(
      'custom_providers:\n- name: "atomic-chat"\n  model: stale\n- name: keep\n',
      'http://u',
      'm',
      64
    )
    expect(out).toBe(
      'custom_providers:\n- name: keep\n- name: atomic-chat\n  base_url: http://u\n  model: m\n' +
        '  models:\n    m:\n      context_length: 64\n'
    )
  })
})

describe('seeding the provider timeout', () => {
  it('rewrites an empty `providers: {}` into a real block', () => {
    expect(upsertProviderRequestTimeout('a: 1\nproviders: {}\nb: 2\n', 'custom', 180)).toBe(
      'a: 1\nproviders:\n  custom:\n    request_timeout_seconds: 180\nb: 2\n'
    )
  })

  it('inserts a missing provider at the top of an existing providers block', () => {
    expect(
      upsertProviderRequestTimeout('providers:\n  openai:\n    request_timeout_seconds: 60\n', 'custom', 180)
    ).toBe(
      'providers:\n  custom:\n    request_timeout_seconds: 180\n  openai:\n    request_timeout_seconds: 60\n'
    )
  })

  it('ignores a `providers:` key that is not at column 0', () => {
    const out = upsertProviderRequestTimeout('nested:\n  providers:\n    x: 1\n', 'custom', 180)
    expect(out).toBe(
      'nested:\n  providers:\n    x: 1\nproviders:\n  custom:\n    request_timeout_seconds: 180\n'
    )
  })
})

describe('resolving the Hermes home', () => {
  it('is always ~/.hermes off Windows, and HERMES_HOME on it', async () => {
    home = await makeAgentHome()
    expect(hermesDir({ HERMES_HOME: 'C:/elsewhere' }, 'darwin', home.fs)).toBe('.hermes')
    expect(hermesDir({ HERMES_HOME: 'C:/elsewhere' }, 'win32', home.fs)).toBe('C:/elsewhere')
    expect(hermesDir({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32', home.fs)).toBe(
      'C:/Users/u/AppData/Local/hermes'
    )
  })
})

describe('configuring Hermes', () => {
  it('patches only the first default:/provider:/base_url: line', async () => {
    home = await makeAgentHome()
    await home.seed(
      CONFIG,
      'model:\n  default: old\n  provider: auto\n  base_url: https://x\n' +
        'other:\n  default: untouched\ncustom_providers: []\n'
    )
    await configureHermes(agentInput(home.fs, { model: 'm', apiUrl: 'http://u' }))
    const out = (await home.read(CONFIG)) as string
    expect(out).toContain('  default: m\n')
    expect(out).toContain('  default: untouched\n')
  })

  it('never creates a .env, only patches one that already exists', async () => {
    home = await makeAgentHome()
    await configureHermes(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([CONFIG])
  })
})
