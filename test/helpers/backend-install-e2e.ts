/** An isolated HTTPS mirror behind a CONNECT proxy for compiled-binary backend-install tests. */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { c as tarCreate } from 'tar'
import { tlsFixture } from './proxy-servers.js'

export interface InstallFixture {
  backend: string
  archiveName: string
  proxy: { url: string; ignore_ssl: boolean }
  seen: string[]
  archiveRequested: Promise<void>
  close(): Promise<void>
}

export async function startBackendInstallFixture(
  folder: string,
  options: { badChecksum?: boolean; holdArchive?: boolean; cuda?: boolean } = {}
): Promise<InstallFixture> {
  const tag = 'b99999'
  const backend =
    process.platform === 'win32'
      ? options.cuda
        ? 'win-cuda-13.3-x64'
        : 'win-cpu-x64'
      : process.platform === 'linux'
        ? 'linux-cpu-x64'
        : `macos-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
  const archiveName = `llama-${tag}-bin-${backend === 'linux-cpu-x64' ? 'ubuntu-x64' : backend}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
  const archive =
    process.platform === 'win32'
      ? storedZip(`build/bin/${exe}`, Buffer.from('fixture backend'))
      : await createTar(folder, exe)
  const companionName = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
  const companion = storedZip('build/bin/cudart.dll', Buffer.from('fixture CUDA runtime'))
  const sha256 = createHash('sha256').update(archive).digest('hex')
  const manifest = Buffer.from(
    JSON.stringify({
      tag_name: tag,
      download_base: 'https://mirror.atomic.invalid/releases',
      assets: [
        { name: archiveName, size: archive.length, sha256: options.badChecksum ? '0'.repeat(64) : sha256 },
      ],
    })
  )
  const seen: string[] = []
  let requested!: () => void
  const archiveRequested = new Promise<void>((resolve) => {
    requested = resolve
  })
  const origin = createHttpsServer(
    { key: tlsFixture('server.key'), cert: tlsFixture('server.pem') },
    (req, res) => {
      seen.push(`${req.method} ${req.headers.host}${req.url}`)
      const isManifest = req.url?.endsWith('/backends/manifest.json')
      const isCompanion = options.cuda && req.url?.endsWith(`/${tag}/${companionName}`)
      const content = isManifest ? manifest : isCompanion ? companion : archive
      if (!isManifest && !isCompanion && !req.url?.endsWith(`/${tag}/${archiveName}`)) {
        res.writeHead(404).end()
        return
      }
      res.writeHead(200, {
        'content-length': content.length,
        'content-type': isManifest ? 'application/json' : 'application/octet-stream',
      })
      if (req.method === 'HEAD') return res.end()
      if (!isManifest && !isCompanion) requested()
      if (options.holdArchive && !isManifest && !isCompanion) {
        res.write(content.subarray(0, 64))
        return
      }
      res.end(content)
    }
  )
  const originPort = await listen(origin)
  const proxy = createHttpServer()
  proxy.on('connect', (req, socket: Socket, head: Buffer) => {
    seen.push(`CONNECT ${req.url}`)
    const upstream = netConnect(originPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const proxyPort = await listen(proxy)
  const sockets = new Set<Socket>()
  for (const server of [origin, proxy])
    server.on('connection', (socket: Socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
  return {
    backend,
    archiveName,
    proxy: { url: `http://127.0.0.1:${proxyPort}`, ignore_ssl: true },
    seen,
    archiveRequested,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all(
        [origin, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
      )
    },
  }
}

async function createTar(folder: string, exe: string): Promise<Buffer> {
  const dir = join(folder, 'archive-source')
  await mkdir(join(dir, 'build', 'bin'), { recursive: true })
  await writeFile(join(dir, 'build', 'bin', exe), 'fixture backend')
  const archive = join(folder, 'fixture-backend.tar.gz')
  await tarCreate({ gzip: true, cwd: dir, file: archive }, ['build'])
  return readFile(archive)
}

/** Minimal stored zip: one file, enough to exercise the Windows extraction path. */
function storedZip(filename: string, content: Buffer): Buffer {
  const name = Buffer.from(filename)
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  let crc = 0xffffffff
  for (const byte of content) crc = (table[(crc ^ byte) & 255] as number) ^ (crc >>> 8)
  crc = (crc ^ 0xffffffff) >>> 0
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(content.length, 18)
  local.writeUInt32LE(content.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(3 << 8, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(content.length, 20)
  central.writeUInt32LE(content.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE(0o755 << 16, 38)
  central.writeUInt32LE(0, 42)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12)
  end.writeUInt32LE(local.length + name.length + content.length, 16)
  return Buffer.concat([local, name, content, central, name, end])
}

function listen(server: ReturnType<typeof createHttpServer> | ReturnType<typeof createHttpsServer>) {
  return new Promise<number>((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve(typeof addr === 'object' && addr ? addr.port : 0)
    })
  )
}
