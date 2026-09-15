import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { describe, expect, it } from 'vitest'
import { extractArchive, normalizeBackendLayout, UNSUPPORTED_ARCHIVE_MESSAGE } from './archive.js'

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false
  )

/** Minimal stored (uncompressed) zip writer — enough for entries, dirs and unix modes. */
function makeZip(entries: Array<{ name: string; data?: Buffer; mode?: number }>): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc32 = (b: Buffer) => {
    let c = 0xffffffff
    for (const x of b) c = (crcTable[(c ^ x) & 0xff] as number) ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const data = e.data ?? Buffer.alloc(0)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, data)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(3 << 8, 4) // made by unix
    cd.writeUInt16LE(20, 6)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(((e.mode ?? 0o644) << 16) >>> 0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += local.length + name.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, eocd])
}

describe('extractArchive', () => {
  it('extracts zip entries, directories and unix modes, and refuses zip-slip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-zip-'))
    const zip = makeZip([
      { name: 'llama-b1/', mode: 0o755 },
      { name: 'llama-b1/llama-server', data: Buffer.from('#!bin'), mode: 0o755 },
      { name: 'llama-b1/lib.so', data: Buffer.from('lib') },
    ])
    await writeFile(join(dir, 'a.zip'), zip)
    const out = join(dir, 'out')
    await extractArchive(join(dir, 'a.zip'), out)
    expect(await readFile(join(out, 'llama-b1/llama-server'), 'utf8')).toBe('#!bin')
    if (process.platform !== 'win32')
      expect((await stat(join(out, 'llama-b1/llama-server'))).mode & 0o111).not.toBe(0)
    await writeFile(join(dir, 'slip.zip'), makeZip([{ name: '../evil', data: Buffer.from('x') }]))
    await expect(extractArchive(join(dir, 'slip.zip'), join(dir, 'out2'))).rejects.toThrow(
      'Invalid zip entry path'
    )
  })

  it('extracts tar.gz and rejects other formats', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-tar-'))
    await mkdir(join(dir, 'src', 'build', 'bin'), { recursive: true })
    await writeFile(join(dir, 'src', 'build', 'bin', 'llama-server'), 'bin')
    await tarCreate({ gzip: true, file: join(dir, 'a.tar.gz'), cwd: join(dir, 'src') }, ['build'])
    await extractArchive(join(dir, 'a.tar.gz'), join(dir, 'out'))
    expect(await readFile(join(dir, 'out/build/bin/llama-server'), 'utf8')).toBe('bin')
    await writeFile(join(dir, 'a.tar.xz'), 'x')
    await expect(extractArchive(join(dir, 'a.tar.xz'), join(dir, 'out3'))).rejects.toThrow(
      UNSUPPORTED_ARCHIVE_MESSAGE
    )
  })
})

describe('normalizeBackendLayout', () => {
  it('is a no-op when build/bin/<exe> exists and rejects empty arguments', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-norm-'))
    await mkdir(join(dir, 'build/bin'), { recursive: true })
    await writeFile(join(dir, 'build/bin/llama-server'), 'x')
    await expect(normalizeBackendLayout(dir, 'llama-server')).resolves.toBeUndefined()
    await expect(normalizeBackendLayout('', 'llama-server')).rejects.toThrow('Invalid argument')
  })
  it('moves a flat layout into build/bin, keeping build/version.txt/backend.txt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-flat-'))
    await writeFile(join(dir, 'llama-server'), 'x')
    await writeFile(join(dir, 'lib.so'), 'l')
    await writeFile(join(dir, 'version.txt'), 'b1')
    await normalizeBackendLayout(dir, 'llama-server')
    expect(await exists(join(dir, 'build/bin/llama-server'))).toBe(true)
    expect(await exists(join(dir, 'build/bin/lib.so'))).toBe(true)
    expect(await exists(join(dir, 'version.txt'))).toBe(true)
    expect(await exists(join(dir, 'llama-server'))).toBe(false)
  })
  it('relocates a nested llama-* directory and fails when the exe is nowhere', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-nested-'))
    await mkdir(join(dir, 'llama-b10405-bin'), { recursive: true })
    await writeFile(join(dir, 'llama-b10405-bin/llama-server'), 'x')
    await normalizeBackendLayout(dir, 'llama-server')
    expect(await exists(join(dir, 'build/bin/llama-server'))).toBe(true)
    expect(await exists(join(dir, 'llama-b10405-bin'))).toBe(false)
    const empty = await mkdtemp(join(tmpdir(), 'atomic-empty-'))
    await expect(normalizeBackendLayout(empty, 'llama-server')).rejects.toThrow(
      /was not found at expected path/
    )
  })
})
