import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { Downloader } from '../../../downloads/index.js'
import { CUDA_ARCHIVES } from './pins.js'
import type { CudaArchive } from './pins.js'

const fileMatches = async (path: string, size: number): Promise<boolean> => {
  const info = await lstat(path).catch(() => undefined)
  return info?.isFile() === true && info.size === size
}

function extractPinnedZip(path: string, archive: CudaArchive, output: string): Promise<void> {
  const remaining = new Map(archive.files.map((file) => [file.entry, file]))
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) return reject(error ?? new Error('Failed to open NVIDIA archive.'))
      const fail = (error: Error) => {
        zip.close()
        reject(error)
      }
      zip.on('error', fail)
      zip.on('end', () => {
        if (remaining.size)
          reject(new Error(`NVIDIA archive is missing ${[...remaining.keys()].join(', ')}.`))
        else resolve()
      })
      zip.on('entry', (entry) => {
        const file = remaining.get(entry.fileName)
        if (!file) return zip.readEntry()
        const kind = (entry.externalFileAttributes >>> 16) & 0o170000
        if (entry.uncompressedSize !== file.size || (kind !== 0 && kind !== 0o100000))
          return fail(new Error(`Invalid NVIDIA archive member: ${entry.fileName}.`))
        zip.openReadStream(entry, (error, stream) => {
          if (error || !stream) return fail(error ?? new Error(`Failed to read ${entry.fileName}.`))
          pipeline(stream, createWriteStream(join(output, file.name), { flags: 'wx' })).then(() => {
            remaining.delete(file.entry)
            zip.readEntry()
          }, fail)
        })
      })
      zip.readEntry()
    })
  })
}

export class CudaRuntimeStore {
  constructor(
    private readonly options: {
      runtimeDir: string
      platform: NodeJS.Platform
      fetch: typeof fetch
      archives?: readonly CudaArchive[]
    }
  ) {}

  private archives(build: string): readonly CudaArchive[] | undefined {
    const target = basename(build)
    const os = this.options.platform === 'win32' ? 'win' : this.options.platform
    if (basename(dirname(build)) !== 'v2.4.0' || !target.startsWith(`${os}-`)) return undefined
    const pins = CUDA_ARCHIVES[target]
    return pins && (this.options.archives ?? pins)
  }

  supports(build: string): boolean {
    return this.archives(build) !== undefined
  }

  private directory(build: string, archives: readonly CudaArchive[]): string {
    const revision = createHash('sha256').update(JSON.stringify(archives)).digest('hex').slice(0, 16)
    return join(this.options.runtimeDir, basename(dirname(build)), basename(build), 'cuda', revision)
  }

  /** Offline lookup. The complete directory is only published after archive verification and extraction. */
  async cached(build: string): Promise<string | undefined> {
    const archives = this.archives(build)
    if (!archives) return undefined
    const dir = this.directory(build, archives)
    const info = await lstat(dir).catch(() => undefined)
    if (!info?.isDirectory()) return undefined
    const files = archives.flatMap((archive) => archive.files)
    return (await Promise.all(files.map((file) => fileMatches(join(dir, file.name), file.size)))).every(
      Boolean
    )
      ? dir
      : undefined
  }

  async prepare(build: string, onProgress: (fraction: number) => void): Promise<string | undefined> {
    const archives = this.archives(build)
    if (!archives) return undefined
    const cached = await this.cached(build)
    if (cached) return cached
    const dir = this.directory(build, archives)
    await mkdir(dirname(dir), { recursive: true })
    const staging = await mkdtemp(join(dirname(dir), '.incoming-'))
    try {
      const output = join(staging, 'runtime')
      await mkdir(output)
      const downloader = new Downloader({
        dataFolder: staging,
        platform: this.options.platform,
        fetch: this.options.fetch,
        emit: (event, payload) => {
          if (event === 'download:progress' && 'percent' in payload) onProgress(payload.percent / 100)
        },
      })
      await downloader.download(
        'foundry-cuda-runtime',
        archives.map((archive, index) => ({
          url: archive.url,
          save_path: `${index}.zip`,
          size: archive.size,
          sha256: archive.sha256,
        })),
        { resume: true }
      )
      for (const [index, archive] of archives.entries()) {
        const path = join(staging, `${index}.zip`)
        await extractPinnedZip(path, archive, output)
        await rm(path)
      }
      await rm(dir, { recursive: true, force: true })
      await rename(output, dir)
      return dir
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
}
