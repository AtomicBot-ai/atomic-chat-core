import { describe, expect, it } from 'vitest'
import type { AtomicCoreError } from '../contracts/index.js'
import {
  isSplitGgufName,
  needsShortPath,
  validateBinaryPath,
  validateMmprojArgs,
  validateModelArgs,
} from './paths.js'

const deps = (
  existing: string[],
  platform: NodeJS.Platform = 'linux',
  short?: (p: string) => Promise<string | undefined>
) => ({
  platform,
  exists: async (p: string) => existing.includes(p),
  ...(short ? { shortPath: short } : {}),
})

describe('name helpers', () => {
  it.each([
    ['model-00001-of-00003.gguf', true],
    ['MODEL-00002-OF-00003.GGUF', true],
    ['model-0001-of-0003.gguf', false],
    ['model-00001-of-00003.bin', false],
    ['model.gguf', false],
    ['-00001-of-00003.gguf', true],
  ])('isSplitGgufName(%s) = %s', (n, e) => expect(isSplitGgufName(n)).toBe(e))
  it('needsShortPath only for non-ASCII', () => {
    expect(needsShortPath('C:\\models\\x.gguf')).toBe(false)
    expect(needsShortPath('C:\\модели\\x.gguf')).toBe(true)
  })
})

describe('validateBinaryPath', () => {
  it('returns the path or throws BINARY_NOT_FOUND with the Rust details', async () => {
    expect(await validateBinaryPath('/b/llama-server', deps(['/b/llama-server']))).toBe('/b/llama-server')
    try {
      await validateBinaryPath('/nope', deps([]))
      expect.unreachable()
    } catch (e) {
      expect((e as AtomicCoreError).code).toBe('BINARY_NOT_FOUND')
      expect((e as AtomicCoreError).details).toBe('Binary not found at "/nope"')
    }
  })
})

describe('validateModelArgs / validateMmprojArgs', () => {
  it('validates and keeps paths off Windows', async () => {
    const args = ['-m', '/m/model.gguf', '--mmproj', '/m/mmproj.gguf']
    expect(await validateModelArgs(args, deps(['/m/model.gguf', '/m/mmproj.gguf']))).toBe('/m/model.gguf')
    expect(await validateMmprojArgs(args, deps(['/m/model.gguf', '/m/mmproj.gguf']))).toBe('/m/mmproj.gguf')
    expect(args).toEqual(['-m', '/m/model.gguf', '--mmproj', '/m/mmproj.gguf'])
  })
  it('reports missing flags, values and files with the Rust codes', async () => {
    await expect(validateModelArgs(['--port', '1'], deps([]))).rejects.toMatchObject({
      code: 'MODEL_LOAD_FAILED',
    })
    await expect(validateModelArgs(['-m'], deps([]))).rejects.toMatchObject({ code: 'MODEL_LOAD_FAILED' })
    await expect(validateModelArgs(['-m', '/gone'], deps([]))).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
      details: 'Invalid or inaccessible model path: /gone',
    })
    expect(await validateMmprojArgs(['-m', 'x'], deps([]))).toBeUndefined()
    await expect(validateMmprojArgs(['--mmproj', '/gone'], deps([]))).rejects.toMatchObject({
      code: 'MODEL_FILE_NOT_FOUND',
    })
  })
  it('on Windows uses the short path only for non-ASCII, never for split shards', async () => {
    const short = async (p: string) => p.replace('модели', 'MODELI~1')
    const a = ['-m', 'C:\\модели\\model.gguf']
    await validateModelArgs(a, deps(['C:\\модели\\model.gguf'], 'win32', short))
    expect(a[1]).toBe('C:\\MODELI~1\\model.gguf')
    const b = ['-m', 'C:\\модели\\model-00001-of-00002.gguf']
    await validateModelArgs(b, deps(['C:\\модели\\model-00001-of-00002.gguf'], 'win32', short))
    expect(b[1]).toBe('C:\\модели\\model-00001-of-00002.gguf')
    const c = ['-m', 'C:\\ascii\\model.gguf']
    await validateModelArgs(c, deps(['C:\\ascii\\model.gguf'], 'win32', short))
    expect(c[1]).toBe('C:\\ascii\\model.gguf')
    const d = ['--mmproj', 'C:\\модели\\mm-00001-of-00002.gguf']
    await validateMmprojArgs(d, deps(['C:\\модели\\mm-00001-of-00002.gguf'], 'win32', short))
    expect(d[1]).toBe('C:\\MODELI~1\\mm-00001-of-00002.gguf')
  })
})
