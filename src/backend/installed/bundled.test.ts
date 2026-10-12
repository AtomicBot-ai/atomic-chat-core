import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { bundledLlamacppDir, readBundledLlamacppPack } from './bundled.js'

let root: string
let resourcesDir: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'atomic-core-bundled-'))
  resourcesDir = join(root, 'resources', 'bin')
  await mkdir(resourcesDir, { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function bundle(folder: string, files: Record<string, string>): Promise<void> {
  const dir = join(root, 'resources', folder)
  await mkdir(dir, { recursive: true })
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text)
}

describe('readBundledLlamacppPack', () => {
  it("reads the installer's build of each provider beside --resources-dir, BOM and blanks stripped", async () => {
    await bundle('llamacpp-backend-upstream', {
      'version.txt': '﻿b11443\n',
      'backend.txt': ' win-cpu-x64 \n',
    })
    await bundle('llamacpp-backend', { 'version.txt': 'turboquant-1.2.0', 'backend.txt': 'win-cuda-12-x64' })
    expect(await readBundledLlamacppPack(resourcesDir, 'llamacpp-upstream')).toEqual({
      version: 'b11443',
      backend: 'win-cpu-x64',
    })
    expect(await readBundledLlamacppPack(resourcesDir, 'llamacpp')).toEqual({
      version: 'turboquant-1.2.0',
      backend: 'win-cuda-12-x64',
    })
  })

  it('is nothing without backend.txt, with an empty file, or for PrismML', async () => {
    await bundle('llamacpp-backend-upstream', { 'version.txt': 'b11443' })
    await bundle('llamacpp-backend', { 'version.txt': 'b1', 'backend.txt': '  ' })
    expect(await readBundledLlamacppPack(resourcesDir, 'llamacpp-upstream')).toBeNull()
    expect(await readBundledLlamacppPack(resourcesDir, 'llamacpp')).toBeNull()
    expect(await readBundledLlamacppPack(resourcesDir, 'atomic-prism')).toBeNull()
  })

  it('is nothing without --resources-dir (atc)', async () => {
    await bundle('llamacpp-backend-upstream', { 'version.txt': 'b11443', 'backend.txt': 'macos-arm64' })
    expect(await readBundledLlamacppPack(undefined, 'llamacpp-upstream')).toBeNull()
  })

  it('names the folder next to --resources-dir', () => {
    expect(bundledLlamacppDir(resourcesDir, 'llamacpp-upstream')).toBe(
      join(root, 'resources', 'llamacpp-backend-upstream')
    )
    expect(bundledLlamacppDir(resourcesDir, 'atomic-prism')).toBeNull()
  })
})
