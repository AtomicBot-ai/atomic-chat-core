import { mkdtemp, open, readFile, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// The file-system calls the downloader and settings store rely on. Must pass under vitest (Node) and
// under `bun test`. PLAN.md §5.1 "Runtime-compat"; risk: `fs.statfs` availability under Bun.

describe('fs/promises', () => {
  it('statfs reports block size and available blocks', async () => {
    const s = await statfs(tmpdir())
    expect(s.bsize).toBeGreaterThan(0)
    expect(s.bavail).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(s.bsize * s.bavail)).toBe(true)
  })

  it('open with a mode, append via a file handle, then rename over an existing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-core-fs-'))
    try {
      const tmp = join(dir, 'a.tmp')
      const fh = await open(tmp, 'a', 0o600)
      await fh.write(Buffer.from('ab'))
      await fh.write(Buffer.from('cd'))
      await fh.close()
      expect((await stat(tmp)).size).toBe(4)
      const final = join(dir, 'a.json')
      await writeFile(final, 'old')
      await rename(tmp, final)
      expect(await readFile(final, 'utf8')).toBe('abcd')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
