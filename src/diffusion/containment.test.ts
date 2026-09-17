import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isWithin, locate, samePath } from './containment.js'

let base: string
beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'atomic-core-containment-')))
  await mkdir(join(base, 'root', 'family'), { recursive: true })
  await mkdir(join(base, 'elsewhere'), { recursive: true })
  await writeFile(join(base, 'elsewhere', 'keep.gguf'), 'x')
})
afterAll(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('isWithin', () => {
  it('compares components, not prefixes', () => {
    expect(isWithin('/data/models/a.gguf', '/data/models')).toBe(true)
    expect(isWithin('/data/models', '/data/models')).toBe(true)
    expect(isWithin('/data/models-old/a.gguf', '/data/models')).toBe(false)
    expect(isWithin('/data/models/../secrets', '/data/models')).toBe(false)
    expect(isWithin('/data', '/data/models')).toBe(false)
    // A name that merely starts with two dots is an ordinary name.
    expect(isWithin('/data/models/..hidden/a', '/data/models')).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('folds case only where the file system does', () => {
    expect(isWithin('/Data/Models/a', '/data/models', 'linux')).toBe(false)
    expect(isWithin('/Data/Models/a', '/data/models', 'win32')).toBe(true)
  })
})

describe('locate', () => {
  it('tells inside from the root itself and from outside', async () => {
    const root = join(base, 'root')
    expect(await locate(join(root, 'family', 'z.gguf'), root)).toBe('inside')
    expect(await locate(join(root, 'not', 'there', 'yet.gguf'), root)).toBe('inside')
    expect(await locate(root, root)).toBe('root')
    expect(await locate(join(root, 'family', '..'), root)).toBe('root')
    expect(await locate(join(base, 'elsewhere', 'keep.gguf'), root)).toBe('outside')
    expect(await locate(join(root, 'family', '..', '..', 'elsewhere', 'keep.gguf'), root)).toBe('outside')
  })

  it.skipIf(process.platform === 'win32')('follows a symlink out of the root, and into it', async () => {
    const root = join(base, 'root')
    await symlink(join(base, 'elsewhere'), join(root, 'escape'))
    expect(await locate(join(root, 'escape', 'keep.gguf'), root)).toBe('outside')
    await symlink(root, join(base, 'alias'))
    expect(await locate(join(base, 'alias', 'family', 'z.gguf'), root)).toBe('inside')
    expect(await samePath(join(base, 'alias'), root)).toBe(true)
  })

  it('knows two spellings of one path', async () => {
    const root = join(base, 'root')
    expect(await samePath(join(root, 'family', '..', 'family'), join(root, 'family'))).toBe(true)
    expect(await samePath(join(root, 'family'), root)).toBe(false)
  })
})
