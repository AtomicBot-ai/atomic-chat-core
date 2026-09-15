/**
 * Read GGUF metadata from a file on disk. The parser in `reader.ts` stays pure (it takes bytes), so
 * this is the only place that opens a model file: it hands the chunked reader growing prefixes of
 * the file, which is how the app avoids mapping a 40 GB model to learn its context length.
 */

import { open } from 'node:fs/promises'
import { readGgufMetadataChunked } from './reader.js'
import type { GgufMetadata } from './reader.js'

export interface ReadGgufFileOptions {
  chunkSize?: number
  maxBytes?: number
}

export async function readGgufMetadataFromFile(
  path: string,
  options: ReadGgufFileOptions = {}
): Promise<GgufMetadata> {
  const handle = await open(path, 'r')
  try {
    return await readGgufMetadataChunked(async (byteLength: number) => {
      const buffer = Buffer.allocUnsafe(byteLength)
      const { bytesRead } = await handle.read(buffer, 0, byteLength, 0)
      return buffer.subarray(0, bytesRead)
    }, options)
  } finally {
    await handle.close().catch(() => {})
  }
}
