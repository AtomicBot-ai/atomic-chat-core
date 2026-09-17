import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeLogStream, openLogStream } from './log-stream.js'

describe('log stream', () => {
  it('appends to a file in a folder it creates, and closes idempotently', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-log-'))
    try {
      const path = join(dir, 'nested', 'serve.log')
      const stream = await openLogStream(path)
      stream.write('one\n')
      await closeLogStream(stream)
      await closeLogStream(stream)
      await closeLogStream(undefined)
      expect(await readFile(path, 'utf8')).toBe('one\n')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('names the engine when the log cannot be opened', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-log-'))
    try {
      await writeFile(join(dir, 'file'), '')
      await expect(openLogStream(join(dir, 'file', 'x.log'), 'MLX')).rejects.toMatchObject({
        code: 'IO_ERROR',
        message: expect.stringContaining('Cannot open MLX log file'),
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
