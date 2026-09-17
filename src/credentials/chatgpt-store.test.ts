import { mkdtemp, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearTokens,
  loadTokens,
  parseStoredTokens,
  saveTokens,
  serializeStoredTokens,
} from './chatgpt-store.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-chatgpt-store-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const tokens = {
  version: 1,
  access_token: 'a',
  refresh_token: 'r',
  id_token: null,
  account_id: null,
  plan_type: null,
  email: null,
  expires_at: 5,
}

describe('chatgpt token file', () => {
  it('tightens the mode of an existing wider file when it rewrites it', async () => {
    const path = join(dir, 'nested', 'atomic-chatgpt-auth.json')
    await saveTokens(path, tokens)
    await chmod(path, 0o644)

    await saveTokens(path, tokens)

    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
  })

  it('reads as no session for a root that is not an object, a fractional expiry or a negative version', () => {
    expect(parseStoredTokens('[]')).toBeUndefined()
    expect(parseStoredTokens(serializeStoredTokens({ ...tokens, expires_at: 1.5 }))).toBeUndefined()
    expect(parseStoredTokens(JSON.stringify({ ...tokens, version: -1 }))).toBeUndefined()
    expect(parseStoredTokens(JSON.stringify({ ...tokens, email: 3 }))).toBeUndefined()
  })

  it('propagates a removal that fails for any reason other than the file being gone', async () => {
    await expect(clearTokens(dir)).rejects.toBeDefined()
    expect(await loadTokens(join(dir, 'missing.json'))).toBeUndefined()
    await writeFile(join(dir, 'x.json'), serializeStoredTokens(tokens))
    expect(await loadTokens(join(dir, 'x.json'))).toEqual(tokens)
  })
})
