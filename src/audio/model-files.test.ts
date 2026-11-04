import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { audioModelFilePath, deleteAudioModelFile, listAudioModelFiles } from './model-files.js'

let dir: string
let root: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-core-audio-models-'))
  root = join(dir, 'models')
  await mkdir(join(root, 'kokoro'), { recursive: true })
  await mkdir(join(root, 'ace'), { recursive: true })
  await writeFile(join(root, 'kokoro', 'kokoro-82m-q8_0.gguf'), 'GGUF 1')
  await writeFile(join(root, 'ace', 'ace-step.gguf'), 'GGUF 22')
  await writeFile(join(root, 'ace', 'ace-step-big.gguf.tmp'), 'partial')
  await writeFile(join(root, 'ace', 'ace-step-big.gguf.url'), 'https://x')
  await writeFile(join(root, '.DS_Store'), 'x')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('listAudioModelFiles', () => {
  it('lists the models recursively without downloads in flight or hidden files', async () => {
    expect(await listAudioModelFiles(root)).toEqual([
      { path: join(root, 'ace', 'ace-step.gguf'), relativePath: 'ace/ace-step.gguf', bytes: 7 },
      {
        path: join(root, 'kokoro', 'kokoro-82m-q8_0.gguf'),
        relativePath: 'kokoro/kokoro-82m-q8_0.gguf',
        bytes: 6,
      },
    ])
    expect(await listAudioModelFiles(join(dir, 'none'))).toEqual([])
  })
})

describe('audioModelFilePath', () => {
  it('resolves a relative path under the root', async () => {
    expect(await audioModelFilePath(root, 'kokoro/kokoro-82m-q8_0.gguf')).toBe(
      join(root, 'kokoro', 'kokoro-82m-q8_0.gguf')
    )
    expect(await audioModelFilePath(root, 'kokoro\\kokoro-82m-q8_0.gguf')).toBe(
      join(root, 'kokoro', 'kokoro-82m-q8_0.gguf')
    )
  })

  it.each([['../outside.gguf'], ['/etc/passwd'], ['C:\\x.gguf'], [''], ['kokoro/../..']])(
    'refuses %j',
    async (path) => {
      await expect(audioModelFilePath(root, path)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    }
  )

  // Creating a directory link needs privileges on Windows.
  it.skipIf(process.platform === 'win32')('refuses a link that leads out of the root', async () => {
    await writeFile(join(dir, 'secret.gguf'), 'x')
    await symlink(join(dir), join(root, 'out'))
    await expect(audioModelFilePath(root, 'out/secret.gguf')).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})

describe('deleteAudioModelFile', () => {
  it('deletes the file and the folder it leaves empty, never the root', async () => {
    await deleteAudioModelFile(root, join(root, 'kokoro', 'kokoro-82m-q8_0.gguf'))
    expect((await readdir(root)).sort()).toEqual(['.DS_Store', 'ace'])
    await deleteAudioModelFile(root, join(root, 'ace', 'ace-step.gguf'))
    expect((await readdir(join(root, 'ace'))).sort()).toEqual([
      'ace-step-big.gguf.tmp',
      'ace-step-big.gguf.url',
    ])
    await deleteAudioModelFile(root, join(root, 'kokoro', 'gone.gguf'))
    await expect(deleteAudioModelFile(root, join(root, 'ace'))).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    })
  })
})
