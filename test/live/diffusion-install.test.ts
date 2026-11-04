/**
 * Live checks of a real stable-diffusion.cpp build installed the way a user gets it: from a manifest
 * of conf's shape (ATOMIC_SDCPP_MANIFEST_URL), the core picks this host's archive, downloads it,
 * checks its size and sha256, unpacks it and probes it, then the build answers `--version` with the
 * commit its tag names. The engine candidate check points the manifest at the release under test
 * (scripts/lib/sdcpp-fixtures.mjs writes it); by hand, conf's own manifest works as well.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_SD_MANIFEST=/path/to/manifest.json   (or an https:// URL, such as conf's
 *                                                     backends/sdcpp-manifest.json on raw.githubusercontent.com)
 *
 * Downloads the archive twice (once refused): a few tens of MB on a CPU host. Nothing is written
 * outside the temporary data folders.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CoreClient } from '../../src/client/index.js'
import { AtomicCore } from '../../src/core/index.js'
import { readInstallRecord, serverBinaryName } from '../../src/diffusion/install.js'
import { parseSdcppManifest } from '../../src/engine-builds/index.js'
import type { SdcppManifest } from '../../src/engine-builds/index.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'

const MANIFEST = process.env['ATOMIC_LIVE_SD_MANIFEST'] ?? ''
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && MANIFEST !== ''
const manifestUrl = /^https?:\/\//.test(MANIFEST) ? MANIFEST : pathToFileURL(MANIFEST).href

async function readManifest(): Promise<SdcppManifest> {
  const text = manifestUrl.startsWith('file:')
    ? await readFile(MANIFEST, 'utf8')
    : await (await fetch(manifestUrl)).text()
  return parseSdcppManifest(JSON.parse(text))
}

/** A core on its own data folder, reading sd.cpp's manifest from `url`. */
async function coreReading(url: string, prefix: string) {
  const data = await makeTmpDataFolder(prefix)
  const core = await AtomicCore.create({
    dataFolder: data.root,
    controlPort: 0,
    env: { ...process.env, ATOMIC_SDCPP_MANIFEST_URL: url },
  })
  return { data, core, client: new CoreClient({ baseUrl: core.control.url, token: core.controlToken }) }
}

describe.skipIf(!ENABLED)('a real stable-diffusion.cpp build installed from its manifest', () => {
  let manifest: SdcppManifest
  let data: TmpDataFolder
  let core: AtomicCore
  let client: CoreClient

  beforeAll(async () => {
    manifest = await readManifest()
    ;({ data, core, client } = await coreReading(manifestUrl, 'atomic-core-live-sd-install-'))
    // As the app does at startup: image generation then reports the engine it can load from.
    await client.configureDiffusion({ dataFolder: data.root, idleUnloadSecs: 0 })
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it(
    'is refused when its sha256 does not match the manifest',
    async () => {
      // The same manifest with other bytes pinned: the download is checked and nothing is installed.
      const dir = await mkdtemp(join(tmpdir(), 'atomic-core-live-sd-tampered-manifest-'))
      const tampered = join(dir, 'manifest.json')
      await writeFile(
        tampered,
        JSON.stringify({
          ...manifest,
          assets: manifest.assets.map((a) => ({ ...a, sha256: 'f'.repeat(64) })),
        })
      )
      const other = await coreReading(pathToFileURL(tampered).href, 'atomic-core-live-sd-tampered-')
      try {
        await expect(
          other.client.installEngineBuild('sd-cpp', { task_id: 'live-sd-tampered' })
        ).rejects.toMatchObject({
          code: 'ENGINE_INSTALL_FAILED',
          message: 'The downloaded engine archive does not match the manifest.',
        })
        expect((await other.client.engineBuildCatalog('sd-cpp')).installed).toEqual([])
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
      const catalog = await client.engineBuildCatalog('sd-cpp', { force: true })
      expect(catalog.manifest_error).toBeNull()
      expect(catalog.manifest?.tag).toBe(manifest.tag_name)
      const backendId = catalog.host_backend_id
      expect(backendId, catalog.host_reason ?? '').not.toBeNull()

      // The probe (`sd-cli --help` naming stable-diffusion.cpp) runs inside the install.
      const result = await client.installEngineBuild('sd-cpp', { task_id: 'live-sd-install' })
      expect(result).toMatchObject({
        installed: true,
        build: { tag: manifest.tag_name, backend_id: backendId, origin: 'downloaded' },
      })
      expect(result.failed_backend_ids ?? []).toEqual([])
      const after = await client.engineBuildCatalog('sd-cpp')
      expect(after.active).toMatchObject({ tag: manifest.tag_name, backend_id: backendId, active: true })

      const dir = join(data.layout.diffusion.backendsDir, manifest.tag_name, backendId as string)
      const record = await readInstallRecord(dir)
      expect(record).toMatchObject({ tag: manifest.tag_name, backendId, engine: 'sd-cpp' })
      expect(record?.sha256).toBe(manifest.assets.find((a) => a.backend === backendId)?.sha256)
      expect((await client.diffusionStatus()).install).toMatchObject({ state: 'installed', backendId, dir })

      // Asked again, nothing is downloaded.
      expect(await client.installEngineBuild('sd-cpp', { task_id: 'live-sd-install-2' })).toMatchObject({
        installed: false,
        reason: 'already-installed',
      })
    },
    10 * 60_000
  )

  it('names the commit of its tag', async () => {
    const active = (await client.engineBuildCatalog('sd-cpp')).active
    expect(active).not.toBeNull()
    const dir = join(data.layout.diffusion.backendsDir, active?.tag as string, active?.backend_id as string)
    const out = spawnSync(join(dir, serverBinaryName(process.platform)), ['--version'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
    })
    const text = `${out.stdout}\n${out.stderr}`
    expect(out.status, text).toBe(0)
    const sha7 = /^master-\d+-([0-9a-f]{7})/.exec(manifest.tag_name)?.[1]
    expect(text).toMatch(new RegExp(`stable-diffusion\\.cpp version \\S+, commit ${sha7}`))
  })
})
