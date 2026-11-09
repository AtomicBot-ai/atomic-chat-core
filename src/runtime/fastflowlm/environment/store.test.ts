import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { linuxManifest } from '../../../../test/helpers/flm-environment.js'
import { canonicalDigest } from '../../environment/index.js'
import { EnvironmentManifestStore } from './store.js'
it('keeps a consented manifest across conf updates, restart and offline recovery; overrides have separate histories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'flm-env-'))
  try {
    const file = join(dir, 'conf.json'),
      url = pathToFileURL(file).href
    const open = (source = url) =>
      new EnvironmentManifestStore({
        cache: dir,
        platform: 'linux',
        env: { ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL: source },
      })
    const first = linuxManifest()
    await writeFile(file, JSON.stringify(first))
    expect(await open().latest()).toEqual(first)
    const second = linuxManifest()
    second.manifest_id = 'fastflowlm-linux-r2'
    second.recipes[0]!.packages[0]!.version = '2.1'
    await writeFile(file, JSON.stringify(second))
    expect(await open().latest()).toEqual(first)
    second.recipes[0]!.revision = 2
    await writeFile(file, JSON.stringify(second))
    expect(await open().latest()).toEqual(second)
    await rm(file)
    expect(await open().latest()).toEqual(second)
    expect(await open().pinned(canonicalDigest(first))).toEqual(first)
    expect(await open(url + '-other').latest()).toBeNull()
    expect(await open('http://invalid').latest()).toBeNull()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
