import { it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { optionalJson, save } from './storage.js'
it('atomically replaces a binding and distinguishes a missing file from invalid JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adapter-binding-'))
  try {
    const path = join(dir, 'nested', 'index.json')
    expect(await optionalJson(path)).toBeUndefined()
    await save(path, { id: 'one' })
    await save(path, { id: null })
    expect(await optionalJson(path)).toEqual({ id: null })
    await writeFile(path, '{')
    await expect(optionalJson(path)).rejects.toThrow()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
