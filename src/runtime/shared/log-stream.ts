/** The per-session backend log a CLI `--log` / `--detach` asks for, shared by every runtime. */

import { createWriteStream } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { AtomicCoreError } from '../../contracts/index.js'

export async function openLogStream(path: string, engine = 'llama.cpp'): Promise<WriteStream> {
  try {
    await mkdir(dirname(path), { recursive: true })
    const stream = createWriteStream(path, { flags: 'a' })
    await new Promise<void>((resolve, reject) => {
      stream.once('open', () => resolve())
      stream.once('error', reject)
    })
    // A later disk error cannot retroactively fail a running model, but it must not become an
    // unhandled EventEmitter error either.
    stream.on('error', () => {})
    return stream
  } catch (error) {
    throw new AtomicCoreError(
      'IO_ERROR',
      `Cannot open ${engine} log file "${path}".`,
      (error as Error).message
    )
  }
}

export function closeLogStream(stream: WriteStream | undefined): Promise<void> {
  if (!stream || stream.closed) return Promise.resolve()
  return new Promise((resolve) => stream.end(resolve))
}
