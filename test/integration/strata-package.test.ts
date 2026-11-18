import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractArchive } from '../../src/downloads/index.js'
import { expect, it } from 'vitest'
import fixture from '../fixtures/strata/manifest.json' with { type: 'json' }
import { strataDescriptor } from '../../src/engine-builds/strata.js'
import { parseStrataManifest } from '../../src/engine-builds/index.js'
const archive = process.env.ATOMIC_TEST_STRATA_BUNDLE
const legacy = process.env.ATOMIC_TEST_STRATA_LEGACY_BUNDLE
it.skipIf(!archive || process.platform !== 'darwin')(
  'probes the local macOS bundle with packaged Python, no weights and a poisoned inherited Python environment',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-strata-package-'))
    try {
      await extractArchive(archive!, dir, 'sibling-symlinks')
      const release = parseStrataManifest(fixture, '0.23.6').releases[0]!
      const variant = release.variants[0]!
      const inventory = await readFile(join(dir!, 'bundle.json'))
      const bundle = JSON.parse(inventory.toString()) as {
        release_id: string
        files: Array<{ size?: number }>
      }
      release.release_id = bundle.release_id
      variant.bundle.bundle_manifest_sha256 = createHash('sha256').update(inventory).digest('hex')
      variant.bundle.unpacked_bytes = bundle.files.reduce((n, file) => n + (file.size ?? 0), inventory.length)
      // Candidate metadata is used only by this explicit local probe, never as an install source.
      await expect(
        strataDescriptor.probe(
          dir!,
          {
            root: dir!,
            failedBackendsFile: undefined,
            platform: 'darwin',
            env: { PYTHONHOME: '/poison', PYTHONPATH: '/poison', STRATA_API_KEY: 'poison' },
            hardware: async () => ({ osType: 'macos', arch: 'arm64', cpuExtensions: [], gpus: [] }),
            hostPlatform: { platform: 'macos-arm64' },
          },
          variant.id,
          { tag: release.release_id, published_at: null, strataRelease: release }
        )
      ).resolves.toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  60000
)

it.skipIf(!legacy || process.platform !== 'darwin')(
  'rejects a bundle without the external-owner contract before activation',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-strata-legacy-'))
    try {
      await extractArchive(legacy!, dir, 'sibling-symlinks')
      const release = parseStrataManifest(fixture, '0.23.6').releases[0]!,
        variant = release.variants[0]!
      const inventory = await readFile(join(dir, 'bundle.json'))
      const bundle = JSON.parse(inventory.toString()) as {
        release_id: string
        files: Array<{ size?: number }>
      }
      release.release_id = bundle.release_id
      variant.bundle.bundle_manifest_sha256 = createHash('sha256').update(inventory).digest('hex')
      variant.bundle.unpacked_bytes = bundle.files.reduce((n, f) => n + (f.size ?? 0), inventory.length)
      await expect(
        strataDescriptor.probe(
          dir,
          {
            root: dir,
            failedBackendsFile: undefined,
            platform: 'darwin',
            env: {},
            hardware: async () => ({ osType: 'macos', arch: 'arm64', cpuExtensions: [], gpus: [] }),
            hostPlatform: { platform: 'macos-arm64' },
          },
          variant.id,
          { tag: release.release_id, published_at: null, strataRelease: release }
        )
      ).rejects.toThrow(/strata_control.atomic_owner|Atomic external-owner contract unavailable/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
  60000
)
