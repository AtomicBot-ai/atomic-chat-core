/**
 * Hand-ported from `zcode_tests` in the app's `core/system/commands.rs` (commit `ec1fd3ea7`). The
 * agent-config fixture emitter was removed with the app's Rust CLI, so there are no golden files for
 * ZCode; these pin the merge rules and the file handling instead.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JsonValue } from '../config-io.js'
import { canonicalJson, nodeConfigFs } from '../config-io.js'
import { configureAgent } from './registry.js'
import {
  acquireZcodeLock,
  configureZcodeIn,
  ZCODE_CONTEXT_WINDOW,
  ZCODE_KEY_PLACEHOLDER,
  ZCODE_PROVIDER_ID,
  ZCODE_REASONING_MAP,
  zcodeConfigDir,
  zcodePatchProviderConfig,
} from './zcode.js'

const URL = 'http://127.0.0.1:1337/v1'
type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

const patch = (existing: JsonValue | undefined, model: string) =>
  zcodePatchProviderConfig(existing, URL, model, undefined) as Json
const providers = (root: Json) => root['config']['providerConfigRules']['providerRules'] as Json[]
const modelRules = (root: Json, list: string) => root['config']['modelConfigRules'][list] as Json[]
const ours = (rules: Json[]) => rules.filter((r) => r['providerId'] === ZCODE_PROVIDER_ID)

/** A user's own provider as ZCode's Model Settings writes it. */
const userFile = (): Json => ({
  schemaVersion: 1,
  config: {
    providerOrder: ['new-provider'],
    providerConfigRules: {
      providerRules: [
        {
          providerId: 'new-provider',
          providerName: 'OpenRouter',
          enabled: true,
          config: {
            group: 'standard-personal',
            access: { type: 'api-key', apiKey: 'sk-user' },
            api: { type: 'openai-chat-completions', baseUrl: 'https://openrouter.ai/api/v1' },
            personalModelIds: ['glm-5'],
          },
        },
      ],
    },
    modelConfigRules: {
      providerModelRules: [{ providerId: 'new-provider', modelId: 'glm-5', config: { enabled: true } }],
      manualProviderModelRules: [],
    },
    defaultModelSelection: { providerId: 'new-provider', modelId: 'glm-5' },
  },
})

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn()
    return undefined
  } catch (error) {
    return (error as { code?: string }).code
  }
}

describe('zcodePatchProviderConfig', () => {
  it('seeds a complete file from nothing', () => {
    const out = patch(undefined, 'qwen3-4b')
    expect(out['schemaVersion']).toBe(1)
    const provider = providers(out)[0] as Json
    expect(provider['providerId']).toBe(ZCODE_PROVIDER_ID)
    expect(provider['enabled']).toBe(true)
    const config = provider['config']
    expect(config['group']).toBe('standard-personal')
    expect(config['access']).toEqual({ type: 'api-key', apiKey: ZCODE_KEY_PLACEHOLDER })
    expect(config['api']).toEqual({ type: 'openai-chat-completions', baseUrl: URL, headers: null })
    expect(config['personalModelIds']).toEqual(['qwen3-4b'])

    expect(modelRules(out, 'manualProviderModelRules')).toEqual([])
    const rule = modelRules(out, 'providerModelRules')[0] as Json
    expect(rule['modelId']).toBe('qwen3-4b')
    expect(rule['config']['properties']['contextWindow']).toBe(ZCODE_CONTEXT_WINDOW)
    expect(rule['config']['optionSpecs']['reasoningLevel']['map']).toBe(ZCODE_REASONING_MAP)
    expect(out['config']['defaultModelSelection']).toEqual({
      providerId: ZCODE_PROVIDER_ID,
      modelId: 'qwen3-4b',
      options: { reasoningLevel: 'enabled' },
    })
    // A file ZCode never had gets no order list invented for it.
    expect(out['config']).not.toHaveProperty('providerOrder')
  })

  it("uses the server's key when there is one", () => {
    const out = zcodePatchProviderConfig(undefined, URL, 'm', ' sk-local ') as Json
    expect((providers(out)[0] as Json)['config']['access']['apiKey']).toBe('sk-local')
  })

  it("keeps the user's providers and rules, and puts ours first in an existing order", () => {
    const original = userFile()
    const out = patch(original, 'qwen3-4b')
    expect(original).toEqual(userFile())
    const all = providers(out)
    expect(all).toHaveLength(2)
    expect(all[0]).toEqual(userFile()['config']['providerConfigRules']['providerRules'][0])
    expect(modelRules(out, 'providerModelRules').some((r) => r['providerId'] === 'new-provider')).toBe(true)
    expect(out['config']['providerOrder']).toEqual([ZCODE_PROVIDER_ID, 'new-provider'])
    // Run means "use this model": the default moves to ours.
    expect(out['config']['defaultModelSelection']['providerId']).toBe(ZCODE_PROVIDER_ID)
  })

  it('leaves one entry of ours after running again or switching the model', () => {
    const once = patch(userFile(), 'qwen3-4b')
    const twice = patch(once, 'qwen3-4b')
    expect(twice, 'a repeated Run must not change the file').toEqual(once)
    const switched = patch(twice, 'gemma-4')
    expect(ours(providers(switched))).toHaveLength(1)
    expect((ours(providers(switched))[0] as Json)['config']['personalModelIds']).toEqual(['gemma-4'])
    const rules = ours(modelRules(switched, 'providerModelRules'))
    expect(rules.map((r) => r['modelId'])).toEqual(['gemma-4'])
    expect(
      (switched['config']['providerOrder'] as string[]).filter((id) => id === ZCODE_PROVIDER_ID)
    ).toHaveLength(1)
  })

  it('drops our manual rule so the file stays valid', () => {
    const file = userFile()
    file['config']['modelConfigRules']['manualProviderModelRules'] = [
      { providerId: ZCODE_PROVIDER_ID, modelId: 'qwen3-4b', config: {} },
      { providerId: 'new-provider', modelId: 'glm-5', config: {} },
    ]
    const manual = modelRules(patch(file, 'qwen3-4b'), 'manualProviderModelRules')
    expect(manual.map((r) => r['providerId'])).toEqual(['new-provider'])
  })

  it('refuses files it does not understand, and a blank model', () => {
    for (const bad of [
      { schemaVersion: 2, config: {} },
      { config: {} },
      [],
      { schemaVersion: 1, config: { providerConfigRules: { providerRules: {} } } },
      { schemaVersion: 1, config: { providerOrder: 'atomic-chat' } },
    ] as JsonValue[])
      expect(
        codeOf(() => zcodePatchProviderConfig(bad, URL, 'm', undefined)),
        JSON.stringify(bad)
      ).toBe('IO_ERROR')
    expect(() => zcodePatchProviderConfig({ schemaVersion: 2 }, URL, 'm', undefined)).toThrow(
      'uses schemaVersion 2, which this version of Atomic Chat does not know'
    )
    expect(() => zcodePatchProviderConfig({}, URL, 'm', undefined)).toThrow('has no schemaVersion')
    expect(codeOf(() => zcodePatchProviderConfig(undefined, URL, '  ', undefined))).toBe('INVALID_ARGUMENT')
  })
})

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'atomic-core-zcode-'))
})
afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('zcodeConfigDir', () => {
  it("follows ZCode's own resolution order", async () => {
    const fs = nodeConfigFs(home)
    const v2 = join(home, '.zcode', 'v2')
    expect(await zcodeConfigDir(fs, undefined)).toBe(v2)
    expect(await zcodeConfigDir(fs, ' ')).toBe(v2)
    expect(await zcodeConfigDir(fs, '/data')).toBe(join('/data', '.zcode', 'v2'))

    await mkdir(v2, { recursive: true })
    await writeFile(join(v2, 'setting.json'), '{"dataBaseDir":"  "}')
    expect(await zcodeConfigDir(fs, undefined)).toBe(v2)
    await writeFile(join(v2, 'setting.json'), '{ not json')
    expect(await zcodeConfigDir(fs, '/data')).toBe(join('/data', '.zcode', 'v2'))
    await writeFile(join(v2, 'setting.json'), '{"dataBaseDir":"/moved"}')
    expect(await zcodeConfigDir(fs, '/data')).toBe(join('/moved', '.zcode', 'v2'))
  })
})

describe('configureZcodeIn', () => {
  const dir = () => join(home, '.zcode', 'v2')

  it('waits for ZCode to import its legacy config first', async () => {
    const fs = nodeConfigFs(home)
    await mkdir(dir(), { recursive: true })
    await writeFile(join(dir(), 'config.json'), '{}')
    await expect(configureZcodeIn(fs, dir(), URL, 'm', undefined)).rejects.toThrow('Open ZCode once')
    expect(await readdir(dir())).toEqual(['config.json'])
    // Once ZCode has migrated, the legacy file is only a rollback copy.
    await writeFile(join(dir(), 'provider_config.json'), JSON.stringify(userFile()))
    await configureZcodeIn(fs, dir(), URL, 'm', undefined)
  })

  it("writes the file owner-only, sorted like the app's, and backs up the user's version once", async () => {
    const fs = nodeConfigFs(home)
    const path = join(dir(), 'provider_config.json')
    const original = JSON.stringify(userFile())
    await mkdir(dir(), { recursive: true })
    await writeFile(path, original)

    await configureZcodeIn(fs, dir(), URL, 'qwen3-4b', undefined)
    await configureZcodeIn(fs, dir(), URL, 'gemma-4', undefined)

    const text = await readFile(path, 'utf8')
    const written = JSON.parse(text) as Json
    expect(written['config']['defaultModelSelection']['modelId']).toBe('gemma-4')
    expect(text).toBe(canonicalJson(written))
    expect(await readFile(join(dir(), 'provider_config.json.atomic-backup'), 'utf8')).toBe(original)
    expect(await readdir(dir())).not.toContain('provider_config.json.lock')
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir(), 'provider_config.json.atomic-backup'))).mode & 0o777).toBe(0o600)
    }
  })

  it('creates the directory for a first write and keeps no backup of nothing', async () => {
    await configureZcodeIn(nodeConfigFs(home), dir(), URL, 'm', 'sk')
    expect((await readdir(dir())).sort()).toEqual(['provider_config.json'])
  })

  it('leaves an unparseable file alone', async () => {
    const path = join(dir(), 'provider_config.json')
    await mkdir(dir(), { recursive: true })
    await writeFile(path, '{ not json')
    await expect(configureZcodeIn(nodeConfigFs(home), dir(), URL, 'm', undefined)).rejects.toThrow(
      'ZCode ignores the file while it is invalid'
    )
    expect(await readFile(path, 'utf8')).toBe('{ not json')
    expect(await readdir(dir())).toEqual(['provider_config.json'])
  })

  it.skipIf(process.platform === 'win32')(
    'writes through a symlinked file instead of replacing the link',
    async () => {
      const real = join(home, 'dotfiles', 'provider_config.json')
      await mkdir(join(home, 'dotfiles'), { recursive: true })
      await writeFile(real, JSON.stringify(userFile()))
      await mkdir(dir(), { recursive: true })
      await symlink(real, join(dir(), 'provider_config.json'))
      await configureZcodeIn(nodeConfigFs(home), dir(), URL, 'm', undefined)
      const linked = JSON.parse(await readFile(real, 'utf8')) as Json
      expect(linked['config']['defaultModelSelection']['providerId']).toBe(ZCODE_PROVIDER_ID)
    }
  )

  it('is what `launch` runs for zcode, with $ZCODE_DATA_BASE_DIR honoured', async () => {
    const base = join(home, 'moved')
    await configureAgent('zcode', URL, 'qwen3-4b', '', {
      home,
      platform: 'linux',
      env: { ZCODE_DATA_BASE_DIR: base },
    })
    const written = JSON.parse(
      await readFile(join(base, '.zcode', 'v2', 'provider_config.json'), 'utf8')
    ) as Json
    expect(written['config']['defaultModelSelection']['modelId']).toBe('qwen3-4b')
  })
})

describe('acquireZcodeLock', () => {
  it('respects a live lock and reclaims an abandoned one', async () => {
    const file = join(home, 'provider_config.json')
    const lockDir = join(home, 'provider_config.json.lock')
    await mkdir(lockDir)
    await writeFile(join(lockDir, 'owner-1-2-x.json'), '{}')

    await expect(acquireZcodeLock(file, 60, 60_000)).rejects.toThrow('Try again in a moment')
    expect(await readdir(home)).toContain('provider_config.json.lock')

    const release = await acquireZcodeLock(file, 60, 0)
    const entries = await readdir(lockDir)
    expect(entries).toHaveLength(1)
    const owner = JSON.parse(await readFile(join(lockDir, entries[0] as string), 'utf8')) as Json
    expect(owner['pid']).toBe(process.pid)
    expect(owner['token']).toBe(`${process.pid}-${owner['createdAt']}-atomic-chat`)
    await release()
    expect(await readdir(home)).toEqual([])
  })

  it('backs off between attempts and gives up after the wait', async () => {
    const file = join(home, 'provider_config.json')
    await mkdir(`${file}.lock`)
    const clock = { now: 0 }
    const slept: number[] = []
    await expect(
      acquireZcodeLock(file, 1_000, 60_000, {
        now: () => clock.now,
        sleep: async (ms) => {
          slept.push(ms)
          clock.now += ms
        },
      })
    ).rejects.toThrow('ZCode is saving its model settings right now')
    expect(slept.slice(0, 6)).toEqual([25, 50, 100, 200, 400, 400])
  })

  it('reports a lock it cannot take for another reason', async () => {
    await expect(
      acquireZcodeLock(join(home, 'missing', 'provider_config.json'), 60, 60_000)
    ).rejects.toMatchObject({
      code: 'IO_ERROR',
    })
  })
})
