import { afterEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { agentInput, makeAgentHome, type AgentHome } from '../../../test/helpers/agent-config-home.js'
import {
  configureHermes,
  hermesDir,
  patchModelSection,
  rebuildCustomProviders,
  replaceYamlScalarValue,
  splitCustomProviders,
  upsertAtomicProvider,
  upsertProviderRequestTimeout,
} from './hermes.js'

const CONFIG = '.hermes/config.yaml'
const BACKUP = '.hermes/config.yaml.atomic-chat-backup.json'
const URL = 'http://127.0.0.1:1337/v1'
const MODEL = 'unsloth/Qwen3_5-4B-GGUF-Qwen3_5-4B-IQ4_XS'
const ROUTE: Array<[string, string]> = [
  ['default', MODEL],
  ['provider', 'custom'],
  ['base_url', URL],
]

/** Hermes reads config.yaml with ruamel, which rejects duplicate keys; `yaml` does the same. */
function hermesView(text: string): Record<string, unknown> {
  return parseYaml(text, { uniqueKeys: true }) as Record<string, unknown>
}

/** The head of Hermes' shipped `cli-config.yaml.example` (v0.22.6), which its installer copies in. */
const UPSTREAM_EXAMPLE = `# Hermes Agent CLI Configuration
_config_version: 52

database:
  journal_mode: "wal"  # Supported values: "wal", "delete"

plugins:
  clone_timeout_seconds: 300

model:
  # Default model to use (can be overridden with --model flag)
  default: "anthropic/claude-opus-4.6"

  # Inference provider selection:
  #   "custom"       - Any other OpenAI-compatible endpoint. Set base_url below.
  provider: "auto"

  # api_key: "your-key-here"  # Uncomment to set here instead of .env
  base_url: "https://openrouter.ai/api/v1"

  # Azure Foundry keyless auth example:
  # provider: "azure-foundry"
  # default: "gpt-4o"          # Deployment/model name
# providers:
#   my-proxy:
#     base_url: "https://llm.internal.example.com/v1"

compression:
  enabled: true
`

/** The chat route Hermes would take: what its CLI reads from the top-level `model` mapping. */
function chatRoute(text: string): unknown {
  return hermesView(text)['model']
}

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
    for (const line of [
      'custom_providers: []',
      'custom_providers:[]',
      '  custom_providers: []',
      'custom_providers: []  # bridges',
    ]) {
      const { before, entries } = splitCustomProviders(`a: 1\n${line}\nb: 2\n`)
      expect(entries, line).toEqual([])
      expect(before, line).toEqual(['a: 1'])
    }
  })

  it('leaves an inline custom_providers list alone rather than adding a second key', () => {
    const inline = 'custom_providers: [{name: bridge, base_url: "http://localhost:9000"}]\n'
    expect(upsertAtomicProvider(inline, 'http://u', 'm', 64, '"atomic"')).toEqual([inline, false])
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
    const [out, added] = upsertAtomicProvider(
      'custom_providers:\n- name: "atomic-chat"\n  model: stale\n- name: keep\n',
      'http://u',
      'm',
      64,
      '"k"'
    )
    expect(out).toBe(
      'custom_providers:\n- name: keep\n- name: atomic-chat\n  base_url: http://u\n  api_key: "k"\n' +
        '  model: m\n  models:\n    m:\n      context_length: 64\n'
    )
    expect(added).toBe(false)
  })
})

describe('pointing the model section at Atomic Chat', () => {
  const ours = { default: MODEL, provider: 'custom', base_url: URL }

  it('patches the upstream example in place, comments and all', () => {
    const out = patchModelSection(UPSTREAM_EXAMPLE, ROUTE)
    expect(chatRoute(out)).toEqual(ours)
    expect(out).toBe(
      UPSTREAM_EXAMPLE.replace('  default: "anthropic/claude-opus-4.6"', `  default: ${MODEL}`)
        .replace('  provider: "auto"', '  provider: custom')
        .replace('  base_url: "https://openrouter.ai/api/v1"', `  base_url: ${URL}`)
    )
  })

  it('leaves the same keys alone in every block before or after model:', () => {
    // The old first-match patch rewrote auxiliary and moa here (breaking the YAML) and left model on
    // an empty default and provider auto: either way Hermes sent an empty model to OpenRouter.
    const before =
      'auxiliary:\n  vision:\n    provider: auto\n    model: ""\n    base_url: ""\n' +
      'cron:\n  provider: ""\n' +
      'moa:\n  presets:\n    default:\n      aggregator: {provider: openrouter, model: x}\n'
    const after = 'delegation:\n  provider: openrouter\n  base_url: https://openrouter.ai/api/v1\n'
    const out = patchModelSection(
      `${before}model:\n  default: ""\n  provider: auto\n  base_url: ""\n${after}`,
      ROUTE
    )
    expect(out).toBe(`${before}model:\n  default: ${MODEL}\n  provider: custom\n  base_url: ${URL}\n${after}`)
  })

  it('turns a scalar model: (valid Hermes) into a block that can name the endpoint', () => {
    for (const scalar of ['anthropic/claude-opus-4.6', '""', '{}', "'' # picked by setup"]) {
      const out = patchModelSection(`model: ${scalar}\ndelegation:\n  provider: openrouter\n`, ROUTE)
      expect(out, scalar).toBe(
        `model:\n  default: ${MODEL}\n  provider: custom\n  base_url: ${URL}\n` +
          'delegation:\n  provider: openrouter\n'
      )
    }
  })

  it('appends a model section to a config that has none', () => {
    const out = patchModelSection('_config_version: 52\ntts:\n  provider: edge\n\n', ROUTE)
    expect(out).toBe(
      `_config_version: 52\ntts:\n  provider: edge\nmodel:\n  default: ${MODEL}\n  provider: custom\n` +
        `  base_url: ${URL}\n`
    )
  })

  it("adds missing keys at the block's own indent and drops a nested default it replaces", () => {
    const out = patchModelSection(
      'model:\n    # picked in the wizard\n    default:\n      model: old\n      provider: openrouter\n' +
        '    api_mode: chat_completions\n    model: alias\n',
      ROUTE
    )
    expect(out).toBe(
      `model:\n    provider: custom\n    base_url: ${URL}\n    # picked in the wizard\n` +
        `    default: ${MODEL}\n    api_mode: chat_completions\n    model: alias\n`
    )
    // `default` wins over the `model` alias in Hermes, so the stale alias is harmless.
    expect(chatRoute(out)).toMatchObject(ours)
  })

  it('fills an empty model: block', () => {
    expect(patchModelSection('model:\nother: 1\n', ROUTE)).toBe(
      `model:\n  default: ${MODEL}\n  provider: custom\n  base_url: ${URL}\nother: 1\n`
    )
  })
})

describe('seeding the provider timeout', () => {
  it('rewrites an empty `providers: {}` into a real block, and says so', () => {
    expect(upsertProviderRequestTimeout('a: 1\nproviders: {}\nb: 2\n', 'custom', 180)).toEqual([
      'a: 1\nproviders:\n  custom:\n    request_timeout_seconds: 180\nb: 2\n',
      ['providers:{}', 'providers.custom', 'providers.custom.request_timeout_seconds'],
    ])
  })

  it('inserts a missing provider at the top of an existing providers block', () => {
    expect(
      upsertProviderRequestTimeout(
        'providers:\n  openai:\n    request_timeout_seconds: 60\n',
        'custom',
        180
      )[0]
    ).toBe(
      'providers:\n  custom:\n    request_timeout_seconds: 180\n  openai:\n    request_timeout_seconds: 60\n'
    )
  })

  it('ignores a `providers:` key that is not at column 0', () => {
    const [out, created] = upsertProviderRequestTimeout('nested:\n  providers:\n    x: 1\n', 'custom', 180)
    expect(out).toBe(
      'nested:\n  providers:\n    x: 1\nproviders:\n  custom:\n    request_timeout_seconds: 180\n'
    )
    expect(created).toEqual(['providers', 'providers.custom', 'providers.custom.request_timeout_seconds'])
  })

  it('never adds a second top-level `providers:` (Hermes would reject the whole file)', () => {
    expect(upsertProviderRequestTimeout('providers:  # named endpoints\n  x: {}\n', 'custom', 180)[0]).toBe(
      'providers:  # named endpoints\n  custom:\n    request_timeout_seconds: 180\n  x: {}\n'
    )
    const inline = 'providers: {openai: {request_timeout_seconds: 60}}\n'
    expect(upsertProviderRequestTimeout(inline, 'custom', 180)).toEqual([inline, []])
  })

  it('records nothing when the user already set a timeout', () => {
    const own = 'providers:\n  custom:\n    request_timeout_seconds: 60\n'
    expect(upsertProviderRequestTimeout(own, 'custom', 180)).toEqual([own, []])
  })
})

describe('resolving the Hermes home', () => {
  it('honours HERMES_HOME on every platform, expanded the way Hermes does', async () => {
    home = await makeAgentHome()
    expect(await hermesDir({}, 'darwin', home.fs)).toBe('.hermes')
    expect(await hermesDir({ HERMES_HOME: '/opt/hermes' }, 'linux', home.fs)).toBe('/opt/hermes')
    expect(await hermesDir({ HERMES_HOME: '~/h' }, 'darwin', home.fs)).toBe(`${home.path}/h`)
    expect(await hermesDir({ HERMES_HOME: '$DATA/h', DATA: '/srv' }, 'linux', home.fs)).toBe('/srv/h')
    expect(await hermesDir({ HERMES_HOME: '${DATA}/h', DATA: '/srv' }, 'linux', home.fs)).toBe('/srv/h')
    expect(await hermesDir({ HERMES_HOME: '$UNSET/h' }, 'linux', home.fs)).toBe('$UNSET/h')
    expect(await hermesDir({ HERMES_HOME: 'C:/elsewhere' }, 'win32', home.fs)).toBe('C:/elsewhere')
    expect(await hermesDir({ HERMES_HOME: '%LOCALAPPDATA%/h', LOCALAPPDATA: 'C:/L' }, 'win32', home.fs)).toBe(
      'C:/L/h'
    )
    expect(await hermesDir({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' }, 'win32', home.fs)).toBe(
      'C:/Users/u/AppData/Local/hermes'
    )
  })

  it('writes to the profile `hermes profile use` made sticky', async () => {
    home = await makeAgentHome()
    await home.seed('.hermes/profiles/work/config.yaml', '')
    expect(await hermesDir({}, 'darwin', home.fs)).toBe('.hermes')
    await home.seed('.hermes/active_profile', 'work\n')
    expect(await hermesDir({}, 'darwin', home.fs)).toBe('.hermes/profiles/work')
    await home.seed('.hermes/active_profile', 'gone\n')
    expect(await hermesDir({}, 'darwin', home.fs)).toBe('.hermes')
    // A HERMES_HOME naming a profile is that profile, sticky or not.
    const pinned = `${home.path}/.hermes/profiles/coder`
    expect(await hermesDir({ HERMES_HOME: pinned }, 'darwin', home.fs)).toBe(pinned)
    // A custom root keeps its own profiles.
    await home.seed('custom/profiles/ops/config.yaml', '')
    await home.seed('custom/active_profile', 'ops')
    const custom = `${home.path}/custom`
    expect(await hermesDir({ HERMES_HOME: custom }, 'linux', home.fs)).toBe(`${custom}/profiles/ops`)
  })
})

describe('configuring Hermes', () => {
  it('patches only the top-level model: block', async () => {
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

  it.each([
    ['the upstream example', UPSTREAM_EXAMPLE],
    [
      'a model: block after other blocks with the same keys',
      'auxiliary:\n  vision:\n    provider: auto\n    base_url: ""\ndelegation:\n  default: fast\n' +
        '  provider: openrouter\nmodel:\n  default: ""\n  provider: auto\n',
    ],
    ['a scalar model:', 'model: anthropic/claude-opus-4.6\ncron:\n  provider: ""\n'],
    ['no model: at all', '_config_version: 52\nmemory:\n  provider: ""\n'],
    [
      'commented top-level keys',
      'model:  # main chat\n  default: x\ncustom_providers: []  # none\nproviders:  # named\n  x:\n    base_url: http://x\n',
    ],
    ['no config at all', undefined],
  ])('routes Hermes to the local endpoint from %s, idempotently', async (_shape, seed) => {
    home = await makeAgentHome()
    if (seed !== undefined) await home.seed(CONFIG, seed)
    const input = { ...agentInput(home.fs, { model: MODEL, apiUrl: URL }), contextLength: 32768 }
    await configureHermes(input)
    const first = (await home.read(CONFIG)) as string
    const view = hermesView(first)
    expect(view['model']).toMatchObject({
      default: MODEL,
      provider: 'custom',
      base_url: URL,
      api_key: 'sk-atomic-fixture-key',
      context_length: 32768,
    })
    expect(view['custom_providers']).toEqual([
      {
        name: 'atomic-chat',
        base_url: URL,
        api_key: 'sk-atomic-fixture-key',
        model: MODEL,
        models: { [MODEL]: { context_length: 32768 } },
      },
    ])
    expect(view['providers']).toMatchObject({ custom: { request_timeout_seconds: 180 } })

    await configureHermes(input)
    expect(await home.read(CONFIG)).toBe(first)
  })

  it('writes the 64K floor only when the served window is unknown, and a placeholder key', async () => {
    home = await makeAgentHome()
    await configureHermes(agentInput(home.fs, { apiKey: '' }))
    const view = hermesView((await home.read(CONFIG)) as string)
    expect(view['model']).toMatchObject({ context_length: 65536, api_key: 'atomic' })
  })

  it('records what Connect replaced, and keeps the first original across reconnects', async () => {
    home = await makeAgentHome()
    await home.seed(CONFIG, 'model:\n  default: opus  # mine\n  provider: openrouter\n')
    await configureHermes(agentInput(home.fs, { model: 'a', apiUrl: URL }))
    await configureHermes(agentInput(home.fs, { model: 'b', apiUrl: URL }))
    expect(JSON.parse((await home.read(BACKUP)) as string)).toEqual({
      created: [
        'custom_providers',
        'providers',
        'providers.custom',
        'providers.custom.request_timeout_seconds',
      ],
      model: {
        header: 'model:',
        keys: {
          default: { before: ['  default: opus  # mine'], ours: 'b' },
          provider: { before: ['  provider: openrouter'], ours: 'custom' },
          base_url: { ours: URL },
          api_key: { ours: '"sk-atomic-fixture-key"' },
          context_length: { ours: '65536' },
        },
      },
    })
  })

  it('never creates a .env, only patches one that already exists', async () => {
    home = await makeAgentHome()
    await configureHermes(agentInput(home.fs))
    expect(Object.keys(await home.tree())).toEqual([CONFIG, BACKUP])
  })
})
