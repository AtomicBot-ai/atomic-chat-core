/**
 * Live checks of a real `mlx-server` build installed the way a user gets it: from a manifest of conf's
 * shape (ATOMIC_MLX_MANIFEST_URL), the core picks the Apple Silicon archive, downloads it, checks its
 * size and sha256, unpacks it and probes it (`--help`), and orders it by the release date the manifest
 * names, the only order MLX builds have. The engine candidate check points the manifest at the release
 * under test (scripts/lib/mlx-fixtures.mjs writes it); by hand, conf's own manifest works as well.
 *
 * A fork release named by its upstream tag (`v0.7.12`) is skipped: cores install only
 * `mlxvlm-macos-arm64-<hex>`, the name conf's mirror gives the same bytes, so no core can install it
 * under its own name. The check requires these tests only of builds named the way cores install them.
 *
 * Opt in with (macOS on Apple Silicon):
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_MLX_MANIFEST=/path/to/manifest.json   (or an https:// URL, such as conf's
 *                                                      backends/mlx-manifest.json on raw.githubusercontent.com)
 *
 * Downloads the archive twice (once refused): about 210 MB each. Nothing is written outside the
 * temporary data folders.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CoreClient } from '../../src/client/index.js'
import { AtomicCore } from '../../src/core/index.js'
import { MLX_SERVER_BINARY, parseMlxManifest, readMlxInstallRecord } from '../../src/engine-builds/index.js'
import type { MlxManifest } from '../../src/engine-builds/index.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'

const MANIFEST = process.env['ATOMIC_LIVE_MLX_MANIFEST'] ?? ''
const ENABLED =
  process.env['ATOMIC_LIVE'] === '1' &&
  process.platform === 'darwin' &&
  process.arch === 'arm64' &&
  MANIFEST !== ''
const manifestUrl = /^https?:\/\//.test(MANIFEST) ? MANIFEST : pathToFileURL(MANIFEST).href

async function readRaw(): Promise<unknown> {
  const text = manifestUrl.startsWith('file:')
    ? await readFile(MANIFEST, 'utf8')
    : await (await fetch(manifestUrl)).text()
  return JSON.parse(text)
}

/** The manifest names a fork release by its upstream tag: a build no core installs by that name. */
const RAW = ENABLED ? await readRaw() : undefined
const NAMED_BY_UPSTREAM_TAG = /^v\d+\.\d+\.\d+$/.test(String((RAW as { tag_name?: unknown })?.tag_name ?? ''))

/** A core on its own data folder, reading MLX's manifest from `url`. */
async function coreReading(url: string, prefix: string) {
  const data = await makeTmpDataFolder(prefix)
  const core = await AtomicCore.create({
    dataFolder: data.root,
    controlPort: 0,
    env: { ...process.env, ATOMIC_MLX_MANIFEST_URL: url },
  })
  return { data, core, client: new CoreClient({ baseUrl: core.control.url, token: core.controlToken }) }
}

describe.skipIf(!ENABLED || NAMED_BY_UPSTREAM_TAG)(
  'a real mlx-server build installed from its manifest',
  () => {
    let manifest: MlxManifest
    let data: TmpDataFolder
    let core: AtomicCore
    let client: CoreClient

    beforeAll(async () => {
      manifest = parseMlxManifest(RAW)
      ;({ data, core, client } = await coreReading(manifestUrl, 'atomic-core-live-mlx-install-'))
    }, 120_000)

    afterAll(async () => {
      await core?.shutdown()
      await data?.cleanup()
    })

    it(
      'is refused when its sha256 does not match the manifest',
      async () => {
        // The same manifest with other bytes pinned: the download is checked and nothing is installed.
        const dir = await mkdtemp(join(tmpdir(), 'atomic-core-live-mlx-tampered-manifest-'))
        const tampered = join(dir, 'manifest.json')
        await writeFile(
          tampered,
          JSON.stringify({
            ...manifest,
            assets: manifest.assets.map((a) => ({ ...a, sha256: 'f'.repeat(64) })),
          })
        )
        const other = await coreReading(pathToFileURL(tampered).href, 'atomic-core-live-mlx-tampered-')
        try {
          await expect(
            other.client.installEngineBuild('mlx', { task_id: 'live-mlx-tampered' })
          ).rejects.toMatchObject({
            code: 'ENGINE_INSTALL_FAILED',
            message: 'The downloaded engine archive does not match the manifest.',
          })
          expect((await other.client.engineBuildCatalog('mlx')).installed).toEqual([])
        } finally {
          await other.core.shutdown()
          await other.data.cleanup()
          await rm(dir, { recursive: true, force: true })
        }
      },
      10 * 60_000
    )

    it(
      'is picked for this host, downloaded, checked, unpacked and probed',
      async () => {
        const catalog = await client.engineBuildCatalog('mlx', { force: true })
        expect(catalog.manifest_error).toBeNull()
        expect(catalog.manifest).toMatchObject({
          tag: manifest.tag_name,
          published_at: manifest.published_at,
        })
        expect(catalog.host_backend_id, catalog.host_reason ?? '').toBe('macos-arm64')

        // The probe (`mlx-server --help`: exit 0 and argparse's usage line) runs inside the install.
        const result = await client.installEngineBuild('mlx', { task_id: 'live-mlx-install' })
        expect(result).toMatchObject({
          installed: true,
          build: { tag: manifest.tag_name, backend_id: 'macos-arm64', origin: 'downloaded' },
        })
        expect(result.failed_backend_ids ?? []).toEqual([])

        const dir = join(data.layout.provider('mlx').backendsDir, manifest.tag_name, 'macos-arm64')
        const record = await readMlxInstallRecord(dir)
        expect(record).toMatchObject({ tag: manifest.tag_name, backendId: 'macos-arm64' })
        expect(record?.sha256).toBe(manifest.assets.find((a) => a.backend === 'macos-arm64')?.sha256)
        expect(existsSync(join(dir, MLX_SERVER_BINARY))).toBe(true)

        // Asked again, nothing is downloaded.
        expect(await client.installEngineBuild('mlx', { task_id: 'live-mlx-install-2' })).toMatchObject({
          installed: false,
          reason: 'already-installed',
        })
      },
      10 * 60_000
    )

    it('is ordered by the release date its manifest names', async () => {
      const after = await client.engineBuildCatalog('mlx')
      // The only build on this data folder (no installer's build beside it): the one the next load starts.
      expect(after.active).toMatchObject({
        tag: manifest.tag_name,
        backend_id: 'macos-arm64',
        origin: 'downloaded',
        published_at: manifest.published_at,
        active: true,
      })
      const record = await readMlxInstallRecord(
        join(data.layout.provider('mlx').backendsDir, manifest.tag_name, 'macos-arm64')
      )
      expect(record?.publishedAt).toBe(manifest.published_at)
      // Nothing newer to offer: the manifest's build is the one installed.
      expect(await client.checkEngineBuildUpdates('mlx')).toMatchObject({ update_needed: false })
    })
  }
)
