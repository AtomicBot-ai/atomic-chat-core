import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { it, expect, vi } from 'vitest'
import { loadHostModelCatalog } from './catalog-source.js'
it('reads the server catalog override from disk without network access', async () => {
  const network = vi.fn()
  const catalog = await loadHostModelCatalog(
    { ATOMIC_MODEL_CATALOG_URL: pathToFileURL(resolve('src/client/model-catalog-baseline.json')).href },
    network
  )
  expect(catalog.collections).toHaveProperty('recommended')
  expect(network).not.toHaveBeenCalled()
})
