import { readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import {
  bearerToken,
  controlTokenIsPrivate,
  controlTokenMatches,
  generateControlToken,
  readControlToken,
  writeControlToken,
} from './control-token.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-token-')
})
afterEach(() => data.cleanup())

describe('control token file', () => {
  it('writes an unguessable token readable only by its owner and reads it back', async () => {
    const token = await writeControlToken(data.layout)
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(await readControlToken(data.layout)).toBe(token)
    expect(await controlTokenIsPrivate(data.layout)).toBe(true)
    expect(await readFile(data.layout.core.controlToken, 'utf8')).toBe(`${token}\n`)
    expect(generateControlToken()).not.toBe(generateControlToken())
  })

  it('replaces a previous owner token instead of appending to it', async () => {
    const first = await writeControlToken(data.layout)
    const second = await writeControlToken(data.layout)
    expect(second).not.toBe(first)
    expect(await readControlToken(data.layout)).toBe(second)
  })

  it('reports a missing token as CORE_NOT_RUNNING and an empty one as IO_ERROR', async () => {
    await expect(readControlToken(data.layout)).rejects.toMatchObject({ code: 'CORE_NOT_RUNNING' })
    await writeFile(data.layout.core.controlToken, '   \n')
    await expect(readControlToken(data.layout)).rejects.toMatchObject({ code: 'IO_ERROR' })
  })

  it('treats a world-readable token as not private on Unix', async () => {
    await writeControlToken(data.layout)
    const { chmod } = await import('node:fs/promises')
    await chmod(data.layout.core.controlToken, 0o644)
    expect(await controlTokenIsPrivate(data.layout, 'linux')).toBe(false)
    expect(await controlTokenIsPrivate(data.layout, 'win32')).toBe(true)
  })
})

describe('token comparison and header parsing', () => {
  it('accepts only the exact token', () => {
    const token = generateControlToken()
    expect(controlTokenMatches(token, token)).toBe(true)
    expect(controlTokenMatches(`${token}x`, token)).toBe(false)
    expect(controlTokenMatches(token.slice(0, -1), token)).toBe(false)
    expect(controlTokenMatches('', token)).toBe(false)
    expect(controlTokenMatches(undefined, token)).toBe(false)
    expect(controlTokenMatches(null, token)).toBe(false)
  })

  it('reads Bearer in any case and rejects other schemes', () => {
    expect(bearerToken('Bearer abc')).toBe('abc')
    expect(bearerToken('bearer  abc  ')).toBe('abc')
    expect(bearerToken('Basic abc')).toBeUndefined()
    expect(bearerToken('abc')).toBeUndefined()
    expect(bearerToken(undefined)).toBeUndefined()
    expect(bearerToken('')).toBeUndefined()
  })
})
