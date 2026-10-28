import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { describe, expect, it } from 'vitest'
import { makeZip } from '../../test/helpers/make-zip.js'
import { extractArchive, normalizeBackendLayout, UNSUPPORTED_ARCHIVE_MESSAGE } from './archive.js'

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false
  )

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

  it('extracts a .whl as the zip it is, zip-slip refused as for any zip', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-whl-'))
    await writeFile(
      join(dir, 'litert_lm_api-0.18.1-py3-none-manylinux_2_27_x86_64.whl'),
      makeZip([{ name: 'litert_lm/liblitert-lm.so', data: Buffer.from('so') }])
    )
    await extractArchive(
      join(dir, 'litert_lm_api-0.18.1-py3-none-manylinux_2_27_x86_64.whl'),
      join(dir, 'out')
    )
    expect(await readFile(join(dir, 'out/litert_lm/liblitert-lm.so'), 'utf8')).toBe('so')
    await writeFile(join(dir, 'slip.whl'), makeZip([{ name: '../evil', data: Buffer.from('x') }]))
    await expect(extractArchive(join(dir, 'slip.whl'), join(dir, 'out2'))).rejects.toThrow(
      'Invalid zip entry path'
    )
  })

  it('extracts .tgz, the name Microsoft gives its gzipped tarballs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-tgz-'))
    await mkdir(join(dir, 'src', 'lib'), { recursive: true })
    await writeFile(join(dir, 'src', 'lib', 'libfoundry_local.so'), 'so')
    await tarCreate({ gzip: true, file: join(dir, 'foundry-local-linux-x64.tgz'), cwd: join(dir, 'src') }, [
      'lib',
    ])
    await extractArchive(join(dir, 'foundry-local-linux-x64.tgz'), join(dir, 'out'))
    expect(await readFile(join(dir, 'out/lib/libfoundry_local.so'), 'utf8')).toBe('so')
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
  it('moves a flat layout into build/bin, keeping build/version.txt/backend.txt and caller-kept entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'atomic-flat-'))
    await writeFile(join(dir, 'llama-server'), 'x')
    await writeFile(join(dir, 'lib.so'), 'l')
    await writeFile(join(dir, 'version.txt'), 'b1')
    await writeFile(join(dir, 'cudart.zip'), 'c')
    await normalizeBackendLayout(dir, 'llama-server', new Set(['cudart.zip']))
    expect(await exists(join(dir, 'build/bin/llama-server'))).toBe(true)
    expect(await exists(join(dir, 'build/bin/lib.so'))).toBe(true)
    expect(await exists(join(dir, 'version.txt'))).toBe(true)
    expect(await exists(join(dir, 'cudart.zip'))).toBe(true)
    expect(await exists(join(dir, 'build/bin/cudart.zip'))).toBe(false)
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
