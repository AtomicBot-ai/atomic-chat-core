/**
 * Archive extraction and backend-pack layout normalisation. Port of `decompress` and
 * `normalize_backend_layout` in `src-tauri/src/core/filesystem/commands.rs`.
 *
 * Only `.tar.gz` and `.zip` are supported (same error text as the app). Zip entries are guarded
 * against zip-slip, directory entries are created, and the unix mode bits are applied.
 */

import { createWriteStream } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, normalize, relative, isAbsolute } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { x as tarExtract } from 'tar'
import yauzl from 'yauzl'

export const UNSUPPORTED_ARCHIVE_MESSAGE = 'Unsupported file format. Only .tar.gz and .zip are supported.'

export async function extractArchive(archivePath: string, outputDir: string): Promise<void> {
  await mkdir(outputDir, { recursive: true })
  if (archivePath.endsWith('.tar.gz')) {
    await tarExtract({ file: archivePath, cwd: outputDir })
    return
  }
  if (archivePath.endsWith('.zip')) {
    await extractZip(archivePath, outputDir)
    return
  }
  throw new Error(UNSUPPORTED_ARCHIVE_MESSAGE)
}

function enclosedName(entryName: string): string | undefined {
  const normalized = normalize(entryName.replaceAll('\\', '/'))
  if (isAbsolute(normalized) || normalized.split(/[\\/]/).includes('..')) return undefined
  return normalized
}

function extractZip(archivePath: string, outputDir: string): Promise<void> {
  return new Promise((resolveDone, reject) => {
    yauzl.open(archivePath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('failed to open zip'))
      // yauzl rejects `..` segments itself; keep the app's wording for that case.
      zip.on('error', (e: Error) =>
        reject(e.message.startsWith('invalid relative path') ? new Error('Invalid zip entry path') : e)
      )
      zip.on('end', resolveDone)
      zip.on('entry', (entry) => {
        const rel = enclosedName(entry.fileName)
        if (rel === undefined) return reject(new Error('Invalid zip entry path'))
        const outPath = join(outputDir, rel)
        if (!isInside(outPath, outputDir)) return reject(new Error('Invalid zip entry path'))
        if (entry.fileName.endsWith('/')) {
          mkdir(outPath, { recursive: true }).then(() => zip.readEntry(), reject)
          return
        }
        zip.openReadStream(entry, (streamErr, stream) => {
          if (streamErr || !stream) return reject(streamErr ?? new Error('failed to read zip entry'))
          mkdir(dirname(outPath), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(outPath)))
            .then(async () => {
              const mode = entry.externalFileAttributes >>> 16
              if (process.platform !== 'win32' && mode !== 0)
                await chmod(outPath, mode & 0o7777).catch(() => {})
              zip.readEntry()
            })
            .catch(reject)
        })
      })
      zip.readEntry()
    })
  })
}

const isInside = (child: string, parent: string) => {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false
  )

async function moveEntry(src: string, dstDir: string): Promise<void> {
  const dst = join(dstDir, src.split(/[\\/]/).pop() as string)
  await rm(dst, { recursive: true, force: true })
  try {
    await rename(src, dst)
  } catch (e) {
    throw new Error(`Failed to move backend entry ${src} -> ${dst}: ${(e as Error).message}`)
  }
}

/**
 * Ensure `<outputDir>/build/bin/<exe>` exists after extraction: a flat archive (exe at the root) is
 * moved into `build/bin/` (except `build`, `version.txt`, `backend.txt`); a single nested `llama-*`
 * directory holding the exe is unpacked into `build/bin/` and removed.
 */
export async function normalizeBackendLayout(outputDir: string, exeName: string): Promise<void> {
  if (outputDir === '' || exeName === '') throw new Error('normalize_backend_layout error: Invalid argument')
  const buildBin = join(outputDir, 'build', 'bin')
  const expected = join(buildBin, exeName)
  if (await exists(expected)) return

  if (await exists(join(outputDir, exeName))) {
    await mkdir(buildBin, { recursive: true })
    for (const name of await readdir(outputDir)) {
      if (name === 'build' || name === 'version.txt' || name === 'backend.txt') continue
      await moveEntry(join(outputDir, name), buildBin)
    }
    return
  }

  for (const name of await readdir(outputDir)) {
    const p = join(outputDir, name)
    const isDir = await stat(p).then(
      (s) => s.isDirectory(),
      () => false
    )
    if (!isDir || !name.startsWith('llama-') || !(await exists(join(p, exeName)))) continue
    await mkdir(buildBin, { recursive: true })
    for (const inner of await readdir(p)) await moveEntry(join(p, inner), buildBin)
    await rm(p, { recursive: true, force: true })
    break
  }

  if (!(await exists(expected))) {
    throw new Error(`Backend extracted but ${exeName} was not found at expected path ${expected}`)
  }
}
