/**
 * Live checks of a real audio.cpp build installed the way a user gets it: from a manifest of conf's
 * shape (ATOMIC_AUDIOCPP_MANIFEST_URL), the core picks this host's archive, downloads it, checks its
 * size and sha256, unpacks it and probes it (`--version`, and `--list-devices` for a GPU build), then
 * the build answers `--version` with the version its tag names. The engine candidate check points the
 * manifest at the release under test (scripts/lib/audiocpp-fixtures.mjs writes it); by default it is
 * conf's bootstrap staging manifest (test/fixtures/audiocpp/conf/audiocpp-manifest.staging.json:
 * upstream 0xShug0/audio.cpp v0.9.3, which has no Linux arm64 or Windows arm64 build).
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_AUDIO_MANIFEST=/path/to/manifest.json   (optional: a path or an https:// URL, such as
 *                                                        conf's backends/audiocpp-manifest.json on
 *                                                        raw.githubusercontent.com)
 *
 * Downloads this host's archive twice (once refused): 35 MB on an Apple Silicon Mac, 63 MB on Linux
 * x64. Nothing is written outside the temporary data folders.
 */
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { audioServerBinaryName, readAudioInstallRecord } from '../../src/audio/index.js'
import { CoreClient } from '../../src/client/index.js'
import { AtomicCore } from '../../src/core/index.js'
import { audiocppBuildKey, parseAudiocppManifest } from '../../src/engine-builds/index.js'
import type { AudiocppManifest } from '../../src/engine-builds/index.js'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'

const BOOTSTRAP = new URL('../fixtures/audiocpp/conf/audiocpp-manifest.staging.json', import.meta.url)
const MANIFEST = process.env['ATOMIC_LIVE_AUDIO_MANIFEST'] ?? ''
const ENABLED = process.env['ATOMIC_LIVE'] === '1'
const manifestUrl =
  MANIFEST === '' ? BOOTSTRAP.href : /^https?:\/\//.test(MANIFEST) ? MANIFEST : pathToFileURL(MANIFEST).href

async function readManifest(): Promise<AudiocppManifest> {
  const text = manifestUrl.startsWith('file:')
    ? await readFile(new URL(manifestUrl), 'utf8')
    : await (await fetch(manifestUrl)).text()
  return parseAudiocppManifest(JSON.parse(text))
}

/** A core on its own data folder, reading audio.cpp's manifest from `url`. */
async function coreReading(url: string, prefix: string) {
  const data = await makeTmpDataFolder(prefix)
  const core = await AtomicCore.create({
    dataFolder: data.root,
    controlPort: 0,
    env: { ...process.env, ATOMIC_AUDIOCPP_MANIFEST_URL: url },
  })
  return { data, core, client: new CoreClient({ baseUrl: core.control.url, token: core.controlToken }) }
}

describe.skipIf(!ENABLED)('a real audio.cpp build installed from its manifest', () => {
  let manifest: AudiocppManifest
  let data: TmpDataFolder
  let core: AtomicCore
  let client: CoreClient

  beforeAll(async () => {
    manifest = await readManifest()
    ;({ data, core, client } = await coreReading(manifestUrl, 'atomic-core-live-audio-install-'))
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it(
    'is refused when its sha256 does not match the manifest',
    async () => {
      // The same manifest with other bytes pinned: the download is checked and nothing is installed.
      const dir = await mkdtemp(join(tmpdir(), 'atomic-core-live-audio-tampered-manifest-'))
      const tampered = join(dir, 'manifest.json')
      await writeFile(
        tampered,
        JSON.stringify({
          ...manifest,
          assets: manifest.assets.map((a) => ({ ...a, sha256: 'f'.repeat(64) })),
        })
      )
      const other = await coreReading(pathToFileURL(tampered).href, 'atomic-core-live-audio-tampered-')
      try {
        await expect(
          other.client.installEngineBuild('audio-cpp', { task_id: 'live-audio-tampered' })
        ).rejects.toMatchObject({
          code: 'ENGINE_INSTALL_FAILED',
          message: 'The downloaded engine archive does not match the manifest.',
        })
        expect((await other.client.engineBuildCatalog('audio-cpp')).installed).toEqual([])
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
      const catalog = await client.engineBuildCatalog('audio-cpp', { force: true })
      expect(catalog.manifest_error).toBeNull()
      expect(catalog.manifest?.tag).toBe(manifest.tag_name)
      const backendId = catalog.host_backend_id
      expect(backendId, catalog.host_reason ?? '').not.toBeNull()

      // The probe (`--version` naming audio.cpp; `--list-devices` finding a GPU for a GPU build) runs
      // inside the install.
      const result = await client.installEngineBuild('audio-cpp', { task_id: 'live-audio-install' })
      expect(result).toMatchObject({
        installed: true,
        build: { tag: manifest.tag_name, backend_id: backendId, origin: 'downloaded' },
      })
      expect(result.failed_backend_ids ?? []).toEqual([])
      const after = await client.engineBuildCatalog('audio-cpp')
      expect(after.active).toMatchObject({ tag: manifest.tag_name, backend_id: backendId, active: true })

      const dir = join(data.layout.audio.backendsDir, manifest.tag_name, backendId as string)
      const record = await readAudioInstallRecord(dir)
      expect(record).toMatchObject({ tag: manifest.tag_name, backendId, engine: 'audio-cpp' })
      expect(record?.sha256).toBe(manifest.assets.find((a) => a.backend === backendId)?.sha256)

      // Asked again, nothing is downloaded.
      expect(await client.installEngineBuild('audio-cpp', { task_id: 'live-audio-install-2' })).toMatchObject(
        {
          installed: false,
          reason: 'already-installed',
        }
      )
    },
    10 * 60_000
  )

  it('names the version of its tag', async () => {
    const active = (await client.engineBuildCatalog('audio-cpp')).active
    expect(active).not.toBeNull()
    const dir = join(data.layout.audio.backendsDir, active?.tag as string, active?.backend_id as string)
    const out = spawnSync(join(dir, audioServerBinaryName(process.platform)), ['--version'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 120_000,
    })
    const text = `${out.stdout}\n${out.stderr}`
    expect(out.status, text).toBe(0)
    // `vX.Y.Z[-a<rev>]` → `X.Y.Z`, what AUDIOCPP_VERSION is set to when the build is made.
    const [major, minor, patch] = audiocppBuildKey(manifest.tag_name) ?? []
    expect(major, manifest.tag_name).toBeDefined()
    expect(text).toMatch(new RegExp(`^audio\\.cpp ${major}\\.${minor}\\.${patch}\\s*$`, 'm'))
  })
})
