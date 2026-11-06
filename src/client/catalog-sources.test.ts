import candidate from '../../test/fixtures/fastflowlm/qwen3-candidate.json' with { type: 'json' }
import { describe, it, expect, vi } from 'vitest'
import { fastFlowLmSources, readAtomicDocument, loadAtomicModelCatalog } from './catalog-sources.js'
import { ATOMIC_MODEL_CATALOG_URL } from './model-catalog.js'
import baseline from './model-catalog-baseline.json' with { type: 'json' }

describe('catalog sources', () => {
  it.each([
    ['win32', 'windows'],
    ['linux', 'linux'],
  ] as const)('keeps production defaults for %s', (platform, name) => {
    expect(fastFlowLmSources(platform)).toEqual({
      catalog: ATOMIC_MODEL_CATALOG_URL,
      builds: expect.stringMatching(/\/backends\/fastflowlm-manifest\.json$/),
      environment: expect.stringContaining('/environments/fastflowlm-' + name + '.json'),
    })
  })
  it('preserves each explicitly injected source independently', () => {
    expect(
      fastFlowLmSources('linux', {
        ATOMIC_MODEL_CATALOG_URL: 'file:///catalog',
        ATOMIC_FASTFLOWLM_MANIFEST_URL: 'https://fixture.test/build',
        ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL: 'file:///environment',
      })
    ).toEqual({
      catalog: 'file:///catalog',
      builds: 'https://fixture.test/build',
      environment: 'file:///environment',
    })
  })
  it.each([
    'http://test.invalid',
    'file://server/share',
    'file:////server/share',
    'javascript:alert(1)',
    'https://u:p@fixture.test',
  ])('rejects %s', async (url) => {
    await expect(readAtomicDocument(url)).rejects.toThrow()
  })
  it('delegates file URLs only to an explicit reader', async () => {
    const network = vi.fn()
    await expect(readAtomicDocument('file:///catalog', { fetch: network })).rejects.toThrow('reader')
    expect(
      await loadAtomicModelCatalog(
        { ATOMIC_MODEL_CATALOG_URL: 'file:///catalog' },
        { fetch: network, readLocal: async () => JSON.stringify(baseline) }
      )
    ).toHaveProperty('schema_version', 1)
    expect(network).not.toHaveBeenCalled()
  })
  it('validates HTTPS responses before exposing model data', async () => {
    const network = vi
      .fn()
      .mockResolvedValueOnce(Response.json(baseline))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({}))
    expect(await loadAtomicModelCatalog({}, { fetch: network })).toHaveProperty('updated_at')
    expect(network.mock.calls[0]?.[0]).toBe(ATOMIC_MODEL_CATALOG_URL)
    await expect(loadAtomicModelCatalog({}, { fetch: network })).rejects.toThrow('404')
    await expect(loadAtomicModelCatalog({}, { fetch: network })).rejects.toThrow('Invalid')
  })
})

it('rejects a staging candidate at the production URL and reads it from an explicit fixture', async () => {
  const variant = candidate.definition.variant_id
  const fixture = {
    ...baseline,
    models: { ...baseline.models, [variant]: candidate },
    collections: {
      ...baseline.collections,
      'fastflowlm-models': { header: { schema_version: 1 }, entries: [{ model: variant, variant }] },
    },
  }
  await expect(loadAtomicModelCatalog({}, { fetch: async () => Response.json(fixture) })).rejects.toThrow(
    'unqualified candidate'
  )
  const catalog = await loadAtomicModelCatalog(
    { ATOMIC_MODEL_CATALOG_URL: 'file:///staging.json' },
    { readLocal: async () => JSON.stringify(fixture) }
  )
  expect(catalog.models[variant]?.definition.checkpoint).toBe(candidate.definition.checkpoint)
})
