import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { expect, it } from 'vitest'
import { flmRelease } from '../../test/helpers/fastflowlm-manifest.js'
import { assertFastFlowLmPath, fastFlowLmHostPlatform, fastFlowLmDescriptor } from './fastflowlm.js'
import { parseFastFlowLmManifest } from './fastflowlm-manifest.js'

it.each([
  ['linux', 'x64', '6.1', 'linux-x64-npu'],
  ['win32', 'x64', '10.0.22631', 'win-x64-npu'],
  ['win32', 'x64', '10.0.19045', null],
  ['win32', 'arm64', '10.0.22631', null],
  ['darwin', 'arm64', '23', null],
] as const)(
  'selects the engine archive without a driver on %s %s %s',
  (platform, arch, osRelease, expected) => {
    expect(fastFlowLmHostPlatform({ platform, arch, osRelease }).platform).toBe(expected)
  }
)

it('offers an older compatible release or no build when only incompatible releases exist', () => {
  const releases = [flmRelease(3), flmRelease(2), flmRelease()]
  releases[0]!.local_only_protocol = 2
  releases[1]!.min_core_version = '99.0.0'
  const manifest = parseFastFlowLmManifest({ schema_version: 1, releases })
  expect(fastFlowLmDescriptor.release(manifest)?.tag).toBe(releases[2]!.version)
  expect(fastFlowLmDescriptor.archives(manifest, 'win-x64-npu')).toEqual([
    { ...releases[2]!.assets[0], platform: undefined, name: releases[2]!.version + '-win-x64-npu.zip' },
  ])
  manifest.releases.pop()
  expect(fastFlowLmDescriptor.release(manifest)).toBeNull()
})

it.skipIf(process.platform === 'win32')(
  'refuses a build path redirected into models and a replacement of an unowned directory',
  async () => {
    const data = await makeTmpDataFolder('atomic-flm-ownership-')
    try {
      const root = data.layout.provider('fastflowlm').backendsDir
      const tag = join(root, 'flm-1.0.11-r1')
      const target = join(tag, 'linux-x64-npu')
      await mkdir(root, { recursive: true })
      await mkdir(data.layout.provider('fastflowlm').modelsDir, { recursive: true })
      await symlink(data.layout.provider('fastflowlm').modelsDir, tag)
      await expect(assertFastFlowLmPath(data.root, target)).rejects.toMatchObject({
        code: 'ENGINE_INSTALL_FAILED',
      })
      await rm(tag)
      await mkdir(target, { recursive: true })
      await expect(assertFastFlowLmPath(data.root, target, true)).rejects.toMatchObject({
        code: 'ENGINE_INSTALL_FAILED',
      })
    } finally {
      await data.cleanup()
    }
  }
)
