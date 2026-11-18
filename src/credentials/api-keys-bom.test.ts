import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ApiKeyStore } from './api-keys.js'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-api-keys-bom-'))
  path = join(dir, 'atomic-core', 'credentials.json')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('ApiKeyStore and documents written by other programs', () => {
  it('reads a credentials file saved with a leading UTF-8 BOM', async () => {
    await mkdir(join(dir, 'atomic-core'), { recursive: true })
    const document = {
      version: 1,
      providers: { openai: { api_key: 'dummy-key', updated_at: '2026-01-01T00:00:00.000Z' } },
    }
    // Windows Notepad and PowerShell 5.1 `-Encoding UTF8` put this mark before the document.
    await writeFile(path, `\uFEFF${JSON.stringify(document, null, 2)}\n`)

    const store = await ApiKeyStore.open(path)

    expect(store.get('openai')).toBe('dummy-key')
  })
})
