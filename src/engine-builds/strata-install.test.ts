import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import fixture from '../../test/fixtures/strata/manifest.json' with { type: 'json' }
import { parseStrataManifest } from './strata-manifest.js'
import { verifyStrataBundle, writeStrataBuild, readStrataBuilds } from './strata-install.js'
import { installStaged } from './install.js'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
async function tree() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-strata-install-'))
  dirs.push(root)
  const release = parseStrataManifest(fixture, '0.23.6').releases[0]!
  const variant = release.variants[0]!
  const dir = join(root, release.release_id, variant.id)
  await mkdir(join(dir, 'control/python/bin'), { recursive: true })
  await writeFile(join(dir, variant.bundle.python), 'fake Python')
  const bundle = {
    schema_version: 1,
    release_id: release.release_id,
    variant: variant.id,
    platform: variant.platform,
    adapter_contract_version: 1,
    preparation_abi: 'strata-v1',
    python: variant.bundle.python,
    files: [{ path: variant.bundle.python, size: 11, sha256: hash('fake Python'), executable: true }],
  }
  for (const component of release.components) {
    const prefix = variant.bundle.component_roots[component.kind]!
    for (const exe of component.executable_paths) {
      const path = prefix + '/' + exe
      if (path === variant.bundle.python) continue
      await mkdir(dirname(join(dir, path)), { recursive: true })
      await writeFile(join(dir, path), 'fake compute')
      bundle.files.push({ path, size: 12, sha256: hash('fake compute'), executable: true })
    }
  }
  const body = JSON.stringify(bundle)
  variant.bundle.bundle_manifest_sha256 = hash(body)
  await writeFile(join(dir, 'bundle.json'), body)
  return { root, dir, release, variant }
}
it('verifies pinned bundle inventory before recording an offline-readable owned build', async () => {
  const t = await tree()
  await verifyStrataBundle(t.dir, t.release, t.variant)
  await writeStrataBuild(t.dir, t.release, t.variant, 42)
  await expect(verifyStrataBundle(t.dir, t.release, t.variant, true)).resolves.toBeUndefined()
  const builds = await readStrataBuilds(t.root, '0.23.6')
  expect(builds).toHaveLength(1)
  expect(builds[0]).toMatchObject({
    tag: t.release.release_id,
    backend_id: t.variant.id,
    installed_at_ms: 42,
  })
  expect(await readStrataBuilds(t.root, '0.1.0')).toEqual([])
  expect(await readFile(join(t.dir, '.atomic-owned'), 'utf8')).toContain('atomic-chat')
})
it.each(['payload', 'inventory', 'extra-file'])('refuses changed %s', async (mode) => {
  const t = await tree()
  if (mode === 'payload') await writeFile(join(t.dir, t.variant.bundle.python), 'poison data')
  if (mode === 'inventory') await writeFile(join(t.dir, 'bundle.json'), '{}')
  if (mode === 'extra-file') await writeFile(join(t.dir, 'poison.py'), 'execute me')
  await expect(verifyStrataBundle(t.dir, t.release, t.variant)).rejects.toThrow()
})
it('preflights declared unpacked bytes rather than assuming a threefold compression ratio', async () => {
  const t = await tree()
  await expect(
    installStaged({
      dataFolder: t.root,
      target: join(t.root, 'new'),
      archives: [
        {
          url: 'https://example.invalid/bundle.tar.gz',
          name: 'bundle.tar.gz',
          sha256: 'a'.repeat(64),
          size: 10,
          unpackedBytes: 1000,
        },
      ],
      taskId: 'disk',
      availableSpace: async () => 500,
      downloader: {
        download: async () => {
          throw new Error('download must not start')
        },
      },
      now: () => 123,
      verify: async () => {},
      record: async () => {},
    })
  ).rejects.toMatchObject({ code: 'BACKEND_INSUFFICIENT_DISK_SPACE' })
})

it('accepts only inventory-bound sibling symlinks to verified regular payloads', async () => {
  const t = await tree()
  const inventoryPath = join(t.dir, 'bundle.json')
  const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
  await symlink('python3', join(t.dir, 'control/python/bin/python'))
  inventory.files.push({ path: 'control/python/bin/python', link: 'python3' })
  const body = JSON.stringify(inventory)
  t.variant.bundle.bundle_manifest_sha256 = hash(body)
  await writeFile(inventoryPath, body)
  await verifyStrataBundle(t.dir, t.release, t.variant)
  await rm(join(t.dir, 'control/python/bin/python'))
  await symlink('/bin/sh', join(t.dir, 'control/python/bin/python'))
  await expect(verifyStrataBundle(t.dir, t.release, t.variant)).rejects.toThrow()
})
