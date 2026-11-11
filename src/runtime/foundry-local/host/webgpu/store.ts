import { lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  diskErrToString,
  Downloader,
  extractArchive,
  verifyDownloadedFile,
} from '../../../../downloads/index.js'

interface MacWebGpuPin {
  version: string
  fileName: string
  url: string
  archiveSize: number
  archiveSha256: string
  librarySize: number
  librarySha256: string
}

/** The unmodified Microsoft CDN bundle requested by Foundry 2.4.0 itself. */
export const MAC_WEBGPU: Readonly<MacWebGpuPin> = Object.freeze({
  version: '0.2.1',
  fileName: 'libonnxruntime_providers_webgpu.dylib',
  url: 'https://foundrypackages-ffhrdhbxb7gpdreh.b02.azurefd.net/webgpu_ep_0.2.1_macos-arm64.zip',
  archiveSize: 3447797,
  archiveSha256: '5f0f8378172f53efa281328f33d1ebc793e44197ffb4cc605d02c593b891c0ea',
  librarySize: 10432384,
  librarySha256: '8fac874a60f32f0127c74cb7def915807fcc8a6c30b77629e45f8cee60272eae',
})

function diskFailure(error: unknown): never {
  throw new Error(diskErrToString(error))
}

/** Validate on every host start; a model load must never repair or fetch a missing provider. */
export async function ensureMacWebGpu(options: {
  runtimeDir: string
  allowDownload: boolean
  fetch: typeof fetch
  onProgress?: (percent: number) => void
  /** Test seam: small fixture archives, with the same two integrity boundaries. */
  pin?: Readonly<MacWebGpuPin>
}): Promise<string> {
  const pin = options.pin ?? MAC_WEBGPU
  const dir = join(options.runtimeDir, 'v2.4.0', 'macos-arm64', 'webgpu-ep', pin.version)
  const library = join(dir, pin.fileName)
  const verifyLibrary = async (file: string) => {
    if (!(await lstat(file)).isFile()) throw new Error('WebGPU EP must be a regular file')
    await verifyDownloadedFile({ size: pin.librarySize, sha256: pin.librarySha256 }, file)
  }
  try {
    await verifyLibrary(library)
    return library
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code && code !== 'ENOENT') diskFailure(error)
    if (!options.allowDownload)
      throw new Error('Prepare the WebGPU accelerator again: its verified library is missing or has changed.')
  }
  await mkdir(dir, { recursive: true }).catch(diskFailure)
  const staging = await mkdtemp(join(dir, '.incoming-')).catch(diskFailure)
  try {
    const archive = join(staging, 'webgpu.zip')
    const downloader = new Downloader({
      dataFolder: staging,
      platform: 'darwin',
      fetch: options.fetch,
      emit: (name, payload) => {
        if (name === 'download:progress' && 'percent' in payload) options.onProgress?.(payload.percent)
      },
    })
    await downloader.download('foundry-mac-webgpu', [
      {
        url: pin.url,
        save_path: archive,
        sha256: pin.archiveSha256,
        size: pin.archiveSize,
      },
    ])
    const extracted = join(staging, 'extracted')
    await extractArchive(archive, extracted, true)
    const incoming = join(extracted, pin.fileName)
    await verifyLibrary(incoming)
    await rename(incoming, library).catch(diskFailure)
    return library
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(diskFailure)
  }
}
