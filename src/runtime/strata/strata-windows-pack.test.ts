import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { stageStrataWindowsPack } from './strata-windows-pack.js'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(modelDir: string) {
  const root = await mkdtemp(join(tmpdir(), 'atomic-strata-win-pack-'))
  dirs.push(root)
  const prepared = join(root, 'prepared')
  const pack = join(prepared, 'pack')
  const runtime = join(root, 'runtime')
  const metadata = 'format gguf\r\nmodel_dir ' + modelDir + '\r\n'
  await mkdir(join(pack, 'tokenizer'), { recursive: true })
  await writeFile(join(pack, 'ds4.txt'), metadata)
  await writeFile(join(pack, 'tokenizer', 'tokenizer.json'), '{}')
  return { prepared, pack, runtime, metadata }
}

it.each([
  [String.raw`\\?\C:\Atomic Chat\モデル`, String.raw`C:\Atomic Chat\モデル`],
  [String.raw`\\?\UNC\server\models\DeepSeek`, String.raw`\\server\models\DeepSeek`],
])('uses a normal Windows directory in the launch copy of %s', async (modelDir, ordinary) => {
  const { prepared, pack, runtime, metadata } = await fixture(modelDir)

  expect(await stageStrataWindowsPack(prepared, runtime)).toBe(true)
  expect(await readFile(join(runtime, 'pack', 'ds4.txt'), 'utf8')).toBe(
    'format gguf\r\nmodel_dir ' + ordinary + '\r\n'
  )
  expect(await readFile(join(runtime, 'pack', 'tokenizer', 'tokenizer.json'), 'utf8')).toBe('{}')
  expect(await readFile(join(pack, 'ds4.txt'), 'utf8')).toBe(metadata)
})

it('reuses an ordinary Windows pack directly', async () => {
  const { prepared, runtime } = await fixture(String.raw`C:\Atomic Chat\DeepSeek`)
  expect(await stageStrataWindowsPack(prepared, runtime)).toBe(false)
  await expect(stat(runtime)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('refuses namespace paths that are neither drive paths nor UNC shares', async () => {
  const { prepared, runtime } = await fixture(String.raw`\\?\GLOBALROOT\Device\HarddiskVolume1`)
  await expect(stageStrataWindowsPack(prepared, runtime)).rejects.toMatchObject({
    code: 'MODEL_INCOMPATIBLE',
  })
  await expect(stat(runtime)).rejects.toMatchObject({ code: 'ENOENT' })
})
