import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/manifest.json' with { type: 'json' }
import { dataLayout } from '../config/index.js'
import { EngineManifestSource, manifestKinds } from './manifest.js'
it('keeps local Strata overrides in their own cache and rejects immutable release reuse offline', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-strata-cache-'))
  try {
    const path = join(root, 'manifest.json')
    await writeFile(path, JSON.stringify(fixture))
    const kind = manifestKinds(dataLayout(root)).strata
    const offline = {
      fetchFor: () => async () => {
        throw new Error('network forbidden')
      },
    }
    const source = new EngineManifestSource(kind, {
      ...offline,
      env: { ATOMIC_STRATA_MANIFEST_URL: pathToFileURL(path).href },
    })
    expect((await source.read()).manifest?.releases[0]?.release_id).toBe('strata-0.1.59-r2')
    const changed = structuredClone(fixture)
    changed.releases[0]!.components[0]!.sha256 = '0'.repeat(64)
    await writeFile(path, JSON.stringify(changed))
    const rejected = await source.read({ force: true })
    expect(rejected.source).toBe('cache')
    expect(rejected.error).toMatch(/Immutable/)
    expect(rejected.manifest?.releases[0]?.components[0]?.sha256).not.toBe('0'.repeat(64))
    await rm(path)
    expect(
      (
        await new EngineManifestSource(kind, {
          ...offline,
          env: { ATOMIC_STRATA_MANIFEST_URL: pathToFileURL(path).href },
        }).read()
      ).source
    ).toBe('cache')
    expect((await new EngineManifestSource(kind, { ...offline, env: {} }).read()).manifest).toBeNull()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
