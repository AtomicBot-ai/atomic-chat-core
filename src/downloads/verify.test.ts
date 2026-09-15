import { createHash } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  HASH_MISMATCH_MESSAGE,
  sha256File,
  VALIDATION_CANCELLED_MESSAGE,
  verifyDownloadedFile,
} from './verify.js'

const body = Buffer.from('hello atomic'.repeat(1000))
const digest = createHash('sha256').update(body).digest('hex')

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'atomic-verify-'))
  const p = join(dir, 'model.gguf')
  await writeFile(p, body)
  return p
}

describe('sha256File', () => {
  it('hashes a file and aborts on signal', async () => {
    const p = await tmpFile()
    expect(await sha256File(p)).toBe(digest)
    const ac = new AbortController()
    ac.abort()
    await expect(sha256File(p, ac.signal)).rejects.toThrow(VALIDATION_CANCELLED_MESSAGE)
  })
})

describe('verifyDownloadedFile', () => {
  it('skips without expectations, checks size first, then hash', async () => {
    const p = await tmpFile()
    await expect(verifyDownloadedFile({}, p)).resolves.toBeUndefined()
    await expect(verifyDownloadedFile({ size: body.length, sha256: digest }, p)).resolves.toBeUndefined()
    await expect(verifyDownloadedFile({ size: 1 }, p)).rejects.toThrow(
      `Size verification failed. Expected 1 bytes but got ${body.length} bytes.`
    )
    await expect(verifyDownloadedFile({ sha256: 'deadbeef' }, p)).rejects.toThrow(HASH_MISMATCH_MESSAGE)
  })
  it('wraps I/O failures and honours cancellation before hashing', async () => {
    await expect(verifyDownloadedFile({ size: 1 }, '/nope/missing')).rejects.toThrow(
      /^Failed to verify file size: /
    )
    const p = await tmpFile()
    const ac = new AbortController()
    ac.abort()
    await expect(verifyDownloadedFile({ sha256: digest }, p, undefined, ac.signal)).rejects.toThrow(
      VALIDATION_CANCELLED_MESSAGE
    )
    await expect(
      verifyDownloadedFile({ sha256: digest }, p, {
        fileSize: async () => 0,
        sha256: async () => {
          throw new Error('io')
        },
      })
    ).rejects.toThrow('Failed to verify file integrity: io')
  })
})
