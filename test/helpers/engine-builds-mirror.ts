/**
 * Releases for the compiled core's engine-builds install: an HTTPS origin behind a CONNECT proxy, the
 * shape `backend-install-e2e.ts` uses for llama.cpp packs. The manifests name `https://` sources (the
 * conf mirror for sd.cpp, `github.com/<repo>/releases/download/…` for MLX); the install request
 * carries `proxy: {url, ignore_ssl: true}`, so every host lands on this origin, which serves by path.
 */
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect as netConnect } from 'node:net'
import type { Server, Socket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { c as tarCreate } from 'tar'
import { tlsFixture } from './proxy-servers.js'

export interface ReleaseMirror {
  proxy: { url: string; ignore_ssl: boolean }
  /** Serve `body` at `path` (`/releases/<tag>/<name>`, `/<owner>/<repo>/releases/download/<tag>/<name>`). */
  serve(path: string, body: Buffer): void
  /** `GET <path>` requests seen, in order. */
  seen: string[]
  close(): Promise<void>
}

export async function startReleaseMirror(): Promise<ReleaseMirror> {
  const files = new Map<string, Buffer>()
  const seen: string[] = []
  const origin = createHttpsServer(
    { key: tlsFixture('server.key'), cert: tlsFixture('server.pem') },
    (req, res) => {
      const path = req.url ?? '/'
      const body = files.get(path)
      if (!body) return res.writeHead(404).end('not found')
      if (req.method === 'GET') seen.push(path)
      res.writeHead(200, { 'content-length': body.length, 'content-type': 'application/octet-stream' })
      return req.method === 'HEAD' ? res.end() : res.end(body)
    }
  )
  const proxy = createHttpServer()
  proxy.on('connect', (_req, socket: Socket, head: Buffer) => {
    const upstream = netConnect(port(origin), '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  await Promise.all([listen(origin), listen(proxy)])
  const sockets = new Set<Socket>()
  for (const server of [origin, proxy])
    server.on('connection', (socket: Socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
  return {
    proxy: { url: `http://127.0.0.1:${port(proxy)}`, ignore_ssl: true },
    serve: (path, body) => files.set(path, body),
    seen,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([origin, proxy].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))))
    },
  }
}

/** A `.tar.gz` of executable `#!/bin/sh` launchers, and what a manifest pins it by. */
export async function launcherArchive(
  workDir: string,
  name: string,
  launchers: Record<string, string>
): Promise<{ body: Buffer; sha256: string; size: number }> {
  const src = join(workDir, `${name}.src`)
  await mkdir(src, { recursive: true })
  for (const [file, script] of Object.entries(launchers)) {
    await writeFile(join(src, file), `#!/bin/sh\n${script}\n`)
    await chmod(join(src, file), 0o755)
  }
  const out = join(workDir, name)
  await tarCreate({ gzip: true, cwd: src, file: out }, Object.keys(launchers))
  const body = await readFile(out)
  return { body, sha256: createHash('sha256').update(body).digest('hex'), size: body.length }
}

/** `exec node <script> "$@"` with `env` exported first. */
export function nodeLauncher(script: string, env: Record<string, string>): string {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join('\n')
  return `${exports}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"`
}

/** What `audiocpp_server` v0.9.3 printed on an Apple M4 Pro (`test/fixtures/audiocpp/v0.9.3/`). */
const AUDIOCPP_FIXTURES = fileURLToPath(new URL('../fixtures/audiocpp/v0.9.3/', import.meta.url))

/**
 * A `#!/bin/sh` body for `audiocpp_server` that answers the core's install probe with v0.9.3's own
 * output: `--version` (`backends: cpu,metal`) and `--list-devices` (one Metal GPU). A CPU build passes
 * on any host; a Vulkan or CUDA build fails its probe, which sends the install down the ladder.
 */
export function fakeAudiocppServer(): string {
  const fixture = (name: string) => JSON.stringify(join(AUDIOCPP_FIXTURES, name))
  return [
    'case "$1" in',
    `  --version) cat ${fixture('version-macos-arm64.txt')} ;;`,
    `  --list-devices) cat ${fixture('list-devices-macos-arm64.txt')} ;;`,
    `  *) cat ${fixture('no-config.txt')} >&2; exit 1 ;;`,
    'esac',
  ].join('\n')
}

/**
 * An archive laid out as upstream `0xShug0/audio.cpp` packs its `.tar.gz` releases: `./`-prefixed
 * entries, `audiocpp_server` (the fake) and `audiocpp_cli` at the root beside `LICENSE`, `tools/` and
 * `model_specs/`; and what a manifest pins it by.
 */
export async function audiocppUpstreamArchive(
  workDir: string,
  name: string
): Promise<{ body: Buffer; sha256: string; size: number }> {
  const src = join(workDir, `${name}.src`)
  await mkdir(join(src, 'tools', 'models'), { recursive: true })
  await mkdir(join(src, 'model_specs'), { recursive: true })
  await writeFile(join(src, 'audiocpp_server'), `#!/bin/sh\n${fakeAudiocppServer()}\n`, { mode: 0o755 })
  await writeFile(join(src, 'audiocpp_cli'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await writeFile(join(src, 'LICENSE'), 'MIT License\n')
  await writeFile(join(src, 'tools', 'models', 'prepare_kokoro_gguf.py'), '# upstream tool\n')
  await writeFile(join(src, 'model_specs', 'kokoro_tts.json'), '{}\n')
  const out = join(workDir, name)
  await tarCreate({ gzip: true, cwd: src, file: out }, ['.'])
  const body = await readFile(out)
  return { body, sha256: createHash('sha256').update(body).digest('hex'), size: body.length }
}

const port = (server: Server): number => {
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

const listen = (server: Server): Promise<void> =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
