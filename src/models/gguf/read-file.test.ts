import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { readGgufMetadataFromFile } from './read-file.js'

let data: TmpDataFolder
beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-gguf-')
})
afterEach(() => data.cleanup())

/** Minimal GGUF v3: magic, version, tensor count, kv count, then one string key/value. */
function ggufWithArchitecture(arch: string): Buffer {
  const key = 'general.architecture'
  const parts: Buffer[] = []
  const u64 = (n: number) => {
    const b = Buffer.alloc(8)
    b.writeBigUInt64LE(BigInt(n))
    return b
  }
  const str = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)])
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  parts.push(Buffer.from('GGUF'), u32(3), u64(0), u64(1))
  parts.push(str(key), u32(8), str(arch)) // type 8 = string
  return Buffer.concat(parts)
}

describe('readGgufMetadataFromFile', () => {
  it('reads metadata without loading the whole file', async () => {
    const path = join(data.root, 'model.gguf')
    const padding = Buffer.alloc(4 * 1024 * 1024, 0)
    await writeFile(path, Buffer.concat([ggufWithArchitecture('llama'), padding]))
    const meta = await readGgufMetadataFromFile(path, { chunkSize: 4096 })
    expect(meta.metadata['general.architecture']).toBe('llama')
    expect(meta.version).toBe(3)
  })

  it('propagates a parse failure for a file that is not a GGUF', async () => {
    const path = join(data.root, 'not-a-model.gguf')
    await writeFile(path, Buffer.alloc(1024, 0x41))
    await expect(readGgufMetadataFromFile(path)).rejects.toThrow()
  })

  it('fails when the file is missing', async () => {
    await expect(readGgufMetadataFromFile(join(data.root, 'nope.gguf'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })
})
