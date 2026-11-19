import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/manifest.json' with { type: 'json' }
import { parseStrataManifest } from './strata-manifest.js'
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

it('rechecks compatibility from the full offline cache and rejects reuse of a skipped release ID', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-strata-cache-'))
  try {
    const path = join(root, 'manifest.json')
    const current = fixture.releases[0]!
    const future = { ...current, release_id: 'strata-0.1.59-r3', minimum_core_version: '99.0.0' }
    const manifest = { ...fixture, releases: [current, future] }
    await writeFile(path, JSON.stringify(manifest))
    const kind = manifestKinds(dataLayout(root)).strata
    const deps = {
      fetchFor: () => async () => {
        throw new Error('network forbidden')
      },
      env: { ATOMIC_STRATA_MANIFEST_URL: pathToFileURL(path).href },
    }
    expect((await new EngineManifestSource(kind, deps).read()).manifest?.releases).toEqual([current])
    const upgraded = { ...kind, parse: (raw: unknown) => parseStrataManifest(raw, '99.0.0') }
    expect((await new EngineManifestSource(upgraded, deps).cached())?.releases).toEqual([future, current])
    future.minimum_core_version = current.minimum_core_version
    await writeFile(path, JSON.stringify(manifest))
    const result = await new EngineManifestSource(kind, deps).read()
    expect(result.source).toBe('cache')
    expect(result.error).toMatch(/Immutable/)
    expect(result.manifest?.releases).toEqual([current])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
