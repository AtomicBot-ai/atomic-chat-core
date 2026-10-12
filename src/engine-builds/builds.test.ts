import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import {
  listDownloadedMlx,
  mlxProbePassed,
  probeMlxServer,
  readBundledMlx,
  readMlxInstallRecord,
  removeOwnedBuild,
  writeMlxInstallRecord,
} from './builds.js'

/** Real child processes (the probes): under a loaded machine a first exec of a fresh script is slow. */
vi.setConfig({ testTimeout: 20_000 })

let data: TmpDataFolder
let root: string
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-engine-builds-disk-')
  root = data.layout.provider('mlx').backendsDir
})
afterEach(() => data.cleanup())

async function mlxBuild(
  tag: string,
  opts: { marker?: boolean; binary?: string; installedAtMs?: number } = {}
) {
  const dir = join(root, tag, 'macos-arm64')
  await mkdir(dir, { recursive: true })
  if (opts.marker !== false)
    await writeMlxInstallRecord(dir, {
      tag,
      backendId: 'macos-arm64',
      sha256: 'a'.repeat(64),
      installedAtMs: opts.installedAtMs ?? 1,
      publishedAt: '2026-10-02T00:00:00Z',
    })
  await writeFile(join(dir, 'mlx-server'), `#!/bin/sh\n${opts.binary ?? 'echo "usage: mlx-server [-h]"'}\n`)
  await chmod(join(dir, 'mlx-server'), 0o755)
  return dir
}

describe('MLX install records', () => {
  it('round-trips the record and lists marked builds with their binary, newest install first', async () => {
    const a = await mlxBuild('mlxvlm-macos-arm64-aaaaaaa', { installedAtMs: 5 })
    const b = await mlxBuild('mlxvlm-macos-arm64-bbbbbbb', { installedAtMs: 9 })
    await mlxBuild('mlxvlm-macos-arm64-ccccccc', { marker: false })
    expect(await readMlxInstallRecord(a)).toEqual({
      tag: 'mlxvlm-macos-arm64-aaaaaaa',
      backendId: 'macos-arm64',
      sha256: 'a'.repeat(64),
      installedAtMs: 5,
      publishedAt: '2026-10-02T00:00:00Z',
      dir: a,
    })
    expect((await listDownloadedMlx(root)).map((r) => r.dir)).toEqual([b, a])
  })

  it('reads a record with a broken date as unordered rather than not at all', async () => {
    const dir = await mlxBuild('mlxvlm-macos-arm64-aaaaaaa')
    await writeFile(
      join(dir, 'install.json'),
      JSON.stringify({
        tag: 't',
        backendId: 'macos-arm64',
        sha256: null,
        installedAtMs: 1,
        publishedAt: 'soon',
      })
    )
    expect((await readMlxInstallRecord(dir))?.publishedAt).toBeNull()
  })
})

describe('readBundledMlx', () => {
  it('describes the installer build by mlx-server.json, and as unordered without it', async () => {
    const resources = join(data.root, 'resources')
    expect(await readBundledMlx(undefined)).toBeNull()
    expect(await readBundledMlx(resources)).toBeNull()
    await mkdir(resources, { recursive: true })
    await writeFile(join(resources, 'mlx-server'), 'bin')
    expect(await readBundledMlx(resources)).toEqual({
      binary: join(resources, 'mlx-server'),
      tag: null,
      published_at: null,
    })
    await writeFile(
      join(resources, 'mlx-server.json'),
      JSON.stringify({ tag: 'mlxvlm-macos-arm64-07ba5a1', published_at: '2026-08-28T10:38:38Z' })
    )
    expect(await readBundledMlx(resources)).toMatchObject({
      tag: 'mlxvlm-macos-arm64-07ba5a1',
      published_at: '2026-08-28T10:38:38Z',
    })
  })
})

describe('removeOwnedBuild', () => {
  it('removes a marked build and its empty tag folder, and nothing else', async () => {
    const dir = await mlxBuild('mlxvlm-macos-arm64-aaaaaaa')
    expect(await removeOwnedBuild(root, dir)).toBe(true)
    expect(await readdir(root)).toEqual([])
    expect(await removeOwnedBuild(root, dir)).toBe(false)
  })

  it('refuses an unmarked folder and anything outside the root', async () => {
    const unmarked = await mlxBuild('mlxvlm-macos-arm64-bbbbbbb', { marker: false })
    await expect(removeOwnedBuild(root, unmarked)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(removeOwnedBuild(root, data.root)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(removeOwnedBuild(root, join(root, '..', '..', 'llamacpp'))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})

describe.skipIf(process.platform === 'win32')('probeMlxServer', () => {
  it('passes on argparse usage and exit 0', async () => {
    await expect(probeMlxServer(await mlxBuild('mlxvlm-macos-arm64-aaaaaaa'))).resolves.toBeUndefined()
  })

  it('fails with what the binary printed, and on a missing or hanging binary', async () => {
    const broken = await mlxBuild('mlxvlm-macos-arm64-bbbbbbb', {
      binary: 'echo "Library not loaded: libmlx.dylib" >&2; exit 134',
    })
    await expect(probeMlxServer(broken)).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      details: expect.stringMatching(/exit code 134[\s\S]*Library not loaded/),
    })
    await expect(probeMlxServer(join(root, 'nothing'))).rejects.toMatchObject({
      code: 'ENGINE_INSTALL_FAILED',
      message: expect.stringMatching(/did not contain mlx-server/),
    })
    const hanging = await mlxBuild('mlxvlm-macos-arm64-ccccccc', { binary: 'sleep 5' })
    await expect(probeMlxServer(hanging, { timeoutMs: 200 })).rejects.toMatchObject({
      message: expect.stringMatching(/did not respond/),
    })
  })
})

describe('mlxProbePassed', () => {
  it('needs both the usage line and a clean exit', () => {
    expect(mlxProbePassed('usage: mlx-server [-h]', { code: 0, signal: null })).toBe(true)
    expect(mlxProbePassed('usage: mlx-server [-h]', { code: 2, signal: null })).toBe(false)
    expect(mlxProbePassed('hello', { code: 0, signal: null })).toBe(false)
  })
})
