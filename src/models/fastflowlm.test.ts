import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
  lstat,
  rename,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { dataLayout } from '../config/index.js'
import { writeFlmInstallation } from '../../test/helpers/fastflowlm-installation.js'
import { FastFlowLmRegistry, readFastFlowLmBlock } from './fastflowlm.js'

let root: string, registry: FastFlowLmRegistry, fixture: Awaited<ReturnType<typeof writeFlmInstallation>>
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'flm-model-')))
  registry = new FastFlowLmRegistry(dataLayout(root))
  fixture = await writeFlmInstallation(root)
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await rm(root, { recursive: true, force: true })
})

async function snapshot() {
  const files = await readdir(fixture.dir, { recursive: true })
  return Promise.all(
    files.sort().map(async (f) => {
      const path = join(fixture.dir, f)
      const info = await lstat(path)
      return [f, info.mtimeMs, info.isFile() ? await readFile(path, 'hex') : null]
    })
  )
}
it('resolves the one committed installation and its launch inputs without network or writes', async () => {
  const fetch = vi.fn(() => {
    throw Error('Unexpected download')
  })
  vi.stubGlobal('fetch', fetch)
  const before = await snapshot()
  const { dir, metadata } = fixture
  expect(readFastFlowLmBlock(metadata)).toEqual(metadata)
  const model = await registry.get(metadata.variant_id)
  expect(model.dir).toBe(dir)
  expect(model.env).toEqual({
    FLM_MODEL_PATH: registry.modelsDir,
    FLM_CONFIG_PATH: join(dir, metadata.model_list_path),
    FLM_MODELINFO_PATH: join(dir, metadata.model_info_path),
  })
  expect(await registry.byPath(dir)).toEqual(model)
  expect(await registry.list()).toEqual([model])
  expect(await snapshot()).toEqual(before)
  expect(fetch).not.toHaveBeenCalled()
})
it.each([
  'missing marker',
  'missing kernel',
  'wrong weight size',
  'foreign file',
  'wrong model_path',
  'double models',
  'extra checkpoint',
  'wrong info hash',
  'bad marker',
] as const)('rejects %s and leaves the failed installation untouched', async (fault) => {
  const { dir, metadata, marker, modelList, modelInfo } = fixture
  switch (fault) {
    case 'missing marker':
      await rm(join(dir, 'model.yml'))
      break
    case 'missing kernel':
      await rm(join(dir, 'attn.xclbin'))
      break
    case 'wrong weight size':
      await writeFile(join(dir, 'model.q4nx'), 'short')
      break
    case 'foreign file':
      await writeFile(join(dir, 'unplanned.xclbin'), 'x')
      break
    case 'wrong model_path':
      await writeFile(join(dir, 'model.yml'), JSON.stringify({ ...marker, model_path: root }))
      break
    case 'double models':
      await writeFile(
        join(dir, metadata.model_list_path),
        JSON.stringify({ ...modelList, model_path: 'models' })
      )
      break
    case 'extra checkpoint':
      await writeFile(
        join(dir, metadata.model_list_path),
        JSON.stringify({ ...modelList, models: { ...modelList.models, other: {} } })
      )
      break
    case 'wrong info hash':
      modelInfo[metadata.checkpoint]![0]!.sha256 = '0'.repeat(64)
      await writeFile(join(dir, metadata.model_info_path), JSON.stringify(modelInfo))
      break
    case 'bad marker':
      await writeFile(
        join(dir, 'model.yml'),
        JSON.stringify({ ...marker, fastflowlm: { ...metadata, catalog_digest: 'latest' } })
      )
  }
  const before = await snapshot()
  await expect(registry.get(metadata.variant_id)).rejects.toMatchObject({
    code: 'FASTFLOWLM_INVALID_INSTALLATION',
  })
  expect(await registry.scan()).toMatchObject({ entries: [], skipped: [{ dir }] })
  expect(await snapshot()).toEqual(before)
})
it('rejects foreign, relative and traversing lookup paths', async () => {
  for (const path of [
    root,
    fixture.metadata.variant_id,
    registry.modelsDir + '/../models/' + fixture.metadata.variant_id,
  ])
    await expect(registry.byPath(path)).rejects.toMatchObject({ code: 'FASTFLOWLM_INVALID_INSTALLATION' })
  await expect(registry.get('../other')).rejects.toMatchObject({ code: 'FASTFLOWLM_INVALID_INSTALLATION' })
})
it.skipIf(process.platform === 'win32')(
  'rejects symlinked model files and directories even with matching bytes',
  async () => {
    const { dir, metadata } = fixture
    const path = join(dir, 'model.q4nx')
    await rename(path, join(root, 'weights'))
    await symlink(join(root, 'weights'), path)
    await expect(registry.get(metadata.variant_id)).rejects.toThrow()
    await rename(dir, join(root, 'external'))
    await symlink(join(root, 'external'), dir, 'dir')
    await expect(registry.byPath(dir)).rejects.toThrow()
    expect(await registry.list()).toEqual([])
  }
)

it.skipIf(process.platform === 'win32')(
  'accepts both spellings of the selected data root but rejects a foreign alias of a variant',
  async () => {
    const selected = join(root, 'selected')
    const physical = join(root, 'physical')
    await mkdir(physical)
    await rename(join(root, 'fastflowlm'), join(physical, 'fastflowlm'))
    await symlink(physical, selected, 'dir')
    const aliased = new FastFlowLmRegistry(dataLayout(selected))
    const id = fixture.metadata.variant_id
    const dir = join(physical, 'fastflowlm', 'models', id)
    await writeFile(join(dir, 'model.yml'), JSON.stringify({ ...fixture.marker, model_path: dir }))
    expect((await aliased.list()).map((m) => m.dir)).toEqual([dir])
    expect((await aliased.byPath(dir)).id).toBe(id)
    expect((await aliased.byPath(join(aliased.modelsDir, id))).dir).toBe(dir)
    const alias = join(root, id)
    await symlink(dir, alias, 'dir')
    await expect(aliased.byPath(alias)).rejects.toThrow()
  }
)
it('distinguishes an absent model after removal from a partial installation on load', async () => {
  await expect(registry.forLoad('removed-model')).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' })
  await rm(join(fixture.dir, 'model.yml'))
  await expect(registry.forLoad(fixture.metadata.variant_id)).rejects.toMatchObject({
    code: 'FASTFLOWLM_INVALID_INSTALLATION',
  })
})

it('releases verified file handles before the client publishes or removes the installation', async () => {
  await registry.get(fixture.metadata.variant_id)
  const moved = fixture.dir + '-published'
  await rename(fixture.dir, moved)
  await rename(moved, fixture.dir)
  await registry.get(fixture.metadata.variant_id)
  await rm(fixture.dir, { recursive: true })
})

// Integrity belongs to the downloader; browsing and loading only inspect installation metadata.
it('does not rehash installed payloads during lookup, listing, checks or load preparation', async () => {
  const { dir, metadata } = fixture
  for (const file of metadata.files) {
    if (file.path !== 'config.json') await writeFile(join(dir, file.path), Buffer.alloc(file.size, 33))
  }
  const config = join(dir, 'config.json')
  await writeFile(config, (await readFile(config, 'utf8')).replace('40960', '40961'))
  const model = await registry.get(metadata.variant_id)
  expect((await registry.forLoad(metadata.variant_id)).id).toBe(model.id)
  expect((await registry.byPath(dir)).id).toBe(model.id)
  expect((await registry.scan()).skipped).toEqual([])
  expect((await registry.list()).map((entry) => entry.id)).toEqual([model.id])
})
