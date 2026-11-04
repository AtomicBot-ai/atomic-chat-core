import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiKeyStore } from '../credentials/index.js'
import { SettingsStore } from '../settings/index.js'
import { CloudRegistry, readStoredMedia } from './registry.js'

let dir: string
let settings: SettingsStore
let keys: ApiKeyStore
let registry: CloudRegistry

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-cloud-'))
  settings = await SettingsStore.open(join(dir, 'settings.json'))
  keys = await ApiKeyStore.open(join(dir, 'credentials.json'))
  registry = new CloudRegistry(settings, keys)
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('CloudRegistry', () => {
  it('serializes concurrent registrations and removals without losing another provider', async () => {
    await Promise.all([
      registry.upsert({ provider: 'a', api_key: 'ka', models: ['ma'] }),
      registry.upsert({ provider: 'b', api_key: 'kb', models: ['mb'] }),
      registry.upsert({ provider: 'c', models: ['mc'] }),
    ])
    await Promise.all([registry.remove('a'), registry.upsert({ provider: 'd', models: ['md'] })])
    expect(registry.list().map((p) => p.provider)).toEqual(['b', 'c', 'd'])
    expect(keys.get('a')).toBeUndefined()
    expect(keys.get('b')).toBe('kb')
  })

  it('restores the key when persistence of a registration or removal fails', async () => {
    await registry.upsert({ provider: 'p', api_key: 'old', models: ['original'] })
    vi.spyOn(settings, 'setCloudProviders').mockRejectedValueOnce(new Error('disk full'))
    await expect(registry.upsert({ provider: 'p', api_key: 'new', models: ['lost'] })).rejects.toThrow(
      'disk full'
    )
    expect(registry.get('p')?.models).toEqual(['original'])
    expect(keys.get('p')).toBe('old')
    vi.spyOn(settings, 'setCloudProviders').mockRejectedValueOnce(new Error('disk full'))
    await expect(registry.remove('p')).rejects.toThrow('disk full')
    expect(registry.get('p')?.has_api_key).toBe(true)
    expect(keys.get('p')).toBe('old')
  })
  it('never routes a key to the old URL while the new settings write is pending or after a crash', async () => {
    await registry.upsert({
      provider: 'p',
      api_key: 'new-secret',
      base_url: 'https://old.test',
      models: ['m'],
    })
    const original = settings.setCloudProviders.bind(settings)
    let release!: () => void
    let entered!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    vi.spyOn(settings, 'setCloudProviders').mockImplementationOnce(async (providers) => {
      entered()
      await pending
      return original(providers)
    })
    const update = registry.upsert({
      provider: 'p',
      api_key: 'next-secret',
      base_url: 'https://new.test',
      models: ['m'],
    })
    await started
    expect(registry.routing().has('p')).toBe(false)
    const restarted = new CloudRegistry(
      await SettingsStore.open(settings.path),
      await ApiKeyStore.open(keys.path)
    )
    expect(restarted.routing().has('p')).toBe(false)
    release()
    await update
    expect(registry.routing().get('p')).toMatchObject({ apiKey: 'next-secret', baseUrl: 'https://new.test' })
  })

  it('fails closed when a settings write and the key rollback both fail', async () => {
    await registry.upsert({
      provider: 'p',
      api_key: 'old-secret',
      base_url: 'https://old.test',
      models: ['m'],
    })
    vi.spyOn(settings, 'setCloudProviders').mockRejectedValueOnce(new Error('settings failed'))
    vi.spyOn(keys, 'restore').mockRejectedValueOnce(new Error('rollback failed'))
    await expect(
      registry.upsert({ provider: 'p', api_key: 'new-secret', base_url: 'https://new.test', models: ['m'] })
    ).rejects.toThrow('rollback failed')
    expect(registry.routing().has('p')).toBe(false)
  })

  it('keeps pre-binding credentials readable and binds them on the first edit', async () => {
    await keys.set('p', 'legacy-secret')
    await settings.setCloudProviders([
      { provider: 'p', base_url: 'https://old.test', custom_headers: [], models: ['m'] },
    ])
    expect(registry.routing().get('p')?.apiKey).toBe('legacy-secret')
    await registry.upsert({ provider: 'p', base_url: 'https://new.test', models: ['m'] })
    expect(keys.record('p')?.bound_to).toMatch(/^[0-9a-f]{64}$/)
    expect(registry.routing().get('p')).toMatchObject({
      apiKey: 'legacy-secret',
      baseUrl: 'https://new.test',
    })
  })
  it('keeps the key in credentials and everything else in settings, and never shows the key', async () => {
    const view = await registry.upsert({
      provider: 'openai',
      api_key: 'sk-secret',
      base_url: ' https://api.openai.com/v1 ',
      custom_headers: [{ header: 'X-Org', value: 'o' }],
      models: ['gpt-4o'],
    })

    expect(view).toEqual({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      custom_headers: [{ header: 'X-Org', value: 'o' }],
      models: ['gpt-4o'],
      has_api_key: true,
    })
    expect(await readFile(settings.path, 'utf8')).not.toContain('sk-secret')
    expect(await readFile(keys.path, 'utf8')).toContain('sk-secret')
    expect(registry.routing().get('openai')).toEqual({
      provider: 'openai',
      apiKey: 'sk-secret',
      baseUrl: 'https://api.openai.com/v1',
      customHeaders: [{ header: 'X-Org', value: 'o' }],
      models: ['gpt-4o'],
    })
  })

  it('replaces a registration wholesale but keeps the key when none is given, and clears it on null', async () => {
    await registry.upsert({ provider: 'p', api_key: 'k', base_url: 'https://a', models: ['m1', 'm2'] })

    await registry.upsert({ provider: 'p', models: ['m3'] })
    expect(registry.get('p')).toEqual({
      provider: 'p',
      base_url: null,
      custom_headers: [],
      models: ['m3'],
      has_api_key: true,
    })

    await registry.upsert({ provider: 'p', api_key: null })
    expect(registry.get('p')?.has_api_key).toBe(false)
  })

  it('keeps registration order, which decides who serves a model two providers list', async () => {
    await registry.upsert({ provider: 'first', models: ['shared'] })
    await registry.upsert({ provider: 'second', models: ['shared'] })
    await registry.upsert({ provider: 'first', models: ['shared', 'own'] })

    expect([...registry.routing().keys()]).toEqual(['first', 'second'])
  })

  it('removes the registration and its key, and removing an unknown provider is fine', async () => {
    await registry.upsert({ provider: 'p', api_key: 'k' })
    await registry.remove('p')
    await registry.remove('never')

    expect(registry.list()).toEqual([])
    expect(keys.has('p')).toBe(false)
  })

  it('refuses a nameless provider, a local engine and malformed fields', async () => {
    await expect(registry.upsert({ provider: ' ' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(registry.upsert({ provider: 'llamacpp-upstream' })).rejects.toMatchObject({
      message: '"llamacpp-upstream" is a local engine, not a cloud provider',
    })
    await expect(registry.upsert({ provider: 'tensorrt-llm' })).rejects.toMatchObject({
      message: '"tensorrt-llm" is a local engine, not a cloud provider',
    })
    await expect(registry.upsert({ provider: 'vllm' })).rejects.toMatchObject({
      message: '"vllm" is a local engine, not a cloud provider',
    })
    await expect(registry.upsert({ provider: 'sglang' })).rejects.toMatchObject({
      message: '"sglang" is a local engine, not a cloud provider',
    })
    await expect(registry.upsert({ provider: 'foundry-local' })).rejects.toMatchObject({
      message: '"foundry-local" is a local engine, not a cloud provider',
    })
    await expect(registry.upsert({ provider: 'litert-lm' })).rejects.toMatchObject({
      message: '"litert-lm" is a local engine, not a cloud provider',
    })
    for (const bad of [
      { models: 'gpt' },
      { models: [1] },
      { custom_headers: [{ header: 'x' }] },
      { custom_headers: {} },
      { base_url: 5 },
      { api_key: 5 },
    ]) {
      await expect(registry.upsert({ provider: 'p', ...(bad as object) })).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    }
  })

  it('skips malformed entries a hand-edited settings file may hold', async () => {
    await settings.setCloudProviders([
      { provider: '' },
      { base_url: 'x' },
      {
        provider: 'ok',
        base_url: 7,
        custom_headers: [{ header: 'h' }, { header: 'a', value: 'b' }],
        models: ['m', 3],
      },
    ])

    expect(registry.list()).toEqual([
      {
        provider: 'ok',
        base_url: null,
        custom_headers: [{ header: 'a', value: 'b' }],
        models: ['m'],
        has_api_key: false,
      },
    ])
  })
})

describe('CloudRegistry media', () => {
  const media = {
    image_api: 'openai-images' as const,
    models: [{ id: 'gpt-image-2', kind: 'image' as const }],
  }

  it('keeps the key bound after a media-only change, and media out of chat routing', async () => {
    await registry.upsert({
      provider: 'openai',
      api_key: 'sk',
      base_url: 'https://api.openai.com/v1',
      models: ['gpt-5'],
    })
    await registry.upsert({
      provider: 'openai',
      base_url: 'https://api.openai.com/v1',
      models: ['gpt-5'],
      media,
    })
    const routed = registry.routing().get('openai')
    expect(routed?.apiKey).toBe('sk')
    expect(routed?.models).toEqual(['gpt-5'])
    expect(routed?.media).toEqual(media)
  })

  it('keeps stored media when a registration leaves it out, clears it on null', async () => {
    await registry.upsert({ provider: 'p', models: [], media })
    await registry.upsert({ provider: 'p', models: ['m'] })
    expect(registry.get('p')?.media).toEqual(media)
    await registry.upsert({ provider: 'p', models: ['m'], media: null })
    expect(registry.get('p')?.media).toBeUndefined()
  })

  it("does not touch another provider's media when one is registered", async () => {
    await registry.upsert({ provider: 'a', models: [], media })
    await registry.upsert({ provider: 'b', models: ['x'] })
    expect(registry.get('a')?.media).toEqual(media)
  })

  it('refuses malformed media, and an adapter of the wrong kind', async () => {
    await expect(
      registry.upsert({ provider: 'p', media: { models: [{ id: '', kind: 'image' }] } })
    ).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(
      registry.upsert({ provider: 'p', media: { video_api: 'openai-images', models: [] } })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})

describe('readStoredMedia', () => {
  it('drops what it cannot read and keeps the rest', () => {
    expect(
      readStoredMedia({
        image_api: 'some-future-api',
        video_api: 'gemini-veo',
        models: [
          { id: 'a', kind: 'image' },
          { id: 'a', kind: 'image' },
          { id: 'b', kind: 'audio' },
          { id: 'v', kind: 'video' },
        ],
      })
    ).toEqual({
      video_api: 'gemini-veo',
      models: [
        { id: 'a', kind: 'image' },
        { id: 'v', kind: 'video' },
      ],
    })
    expect(readStoredMedia('nope')).toBeUndefined()
    expect(readStoredMedia({ image_api: 'a1111', video_api: 'a1111' })).toEqual({
      image_api: 'a1111',
      models: [],
    })
  })

  it('refuses media that is not an object, or models that are not a list', async () => {
    await expect(registry.upsert({ provider: 'p', media: 'x' as never })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(registry.upsert({ provider: 'p', media: { models: 'x' } as never })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
    await expect(
      registry.upsert({ provider: 'p', media: { models: [{ id: 'a', kind: 'audio' }] } as never })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  })
})
