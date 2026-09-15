import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../test/helpers/tmp-data-folder.js'
import { AtomicCore } from '../core.js'
import {
  apiUrl,
  baseUrl,
  daemonCommand,
  formatBytes,
  modelsCommand,
  serveCommand,
  serverCommand,
  shutdownCommand,
} from './commands.js'
import { recordingIo } from './io.js'

let data: TmpDataFolder
const cores: AtomicCore[] = []

beforeEach(async () => {
  data = await makeTmpDataFolder('atomic-core-cli-')
})
afterEach(async () => {
  await Promise.all(cores.splice(0).map((c) => c.shutdown()))
  await data.cleanup()
})

const io = () => recordingIo()
const folder = () => ['--data-folder', data.root]

describe('models list', () => {
  it('prints a table of chat models with sizes and capabilities', async () => {
    await data.writeModel('Owner/Repo-GGUF', {
      size_bytes: 3_221_225_472,
      capabilities: ['tools', 'vision'],
    })
    await data.writeModel('small', { size_bytes: 512 })
    const out = io()
    expect(await modelsCommand(['list', ...folder()], out)).toBe(0)
    const text = out.out.join('')
    expect(text).toContain('MODEL ID')
    expect(text).toContain('Owner/Repo-GGUF')
    expect(text).toContain('3.0 GB')
    expect(text).toContain('tools, vision')
    expect(text).toContain('512 B')
    expect(text).toContain('-') // no capabilities on the small one
  })

  it('hides embedding models, as the Rust CLI does', async () => {
    await data.writeModel('chat')
    await data.writeModel('embed', { embedding: true })
    const out = io()
    await modelsCommand(['list', ...folder()], out)
    expect(out.out.join('')).toContain('chat')
    expect(out.out.join('')).not.toContain('embed')
  })

  it('prints the documented JSON fields with --json', async () => {
    await data.writeModel('m', { name: 'Model', size_bytes: 10, capabilities: ['tools'] })
    const out = io()
    expect(await modelsCommand(['list', '--json', ...folder()], out)).toBe(0)
    expect(JSON.parse(out.out.join(''))).toEqual([
      {
        id: 'm',
        name: 'Model',
        model_path: 'llamacpp/models/m/model.gguf',
        size_bytes: 10,
        capabilities: ['tools'],
        mmproj_path: null,
      },
    ])
  })

  it('explains an empty folder on stderr and still exits 0', async () => {
    const out = io()
    expect(await modelsCommand(['list', ...folder()], out)).toBe(0)
    expect(out.err.join('')).toContain('No chat models installed')
    expect(out.out.join('')).toBe('')
    expect(JSON.parse((await runJson()) || '[]')).toEqual([])
  })

  it('rejects an unknown subcommand', async () => {
    const out = io()
    expect(await modelsCommand(['delete', ...folder()], out)).toBe(2)
    expect(out.err.join('')).toContain('Unknown models subcommand')
  })

  async function runJson(): Promise<string> {
    const out = io()
    await modelsCommand(['list', '--json', ...folder()], out)
    return out.out.join('')
  }
})

describe('server status', () => {
  it('reports a running core server and lists its models', async () => {
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    cores.push(core)
    const state = await core.startPublicServer({ port: 0 })
    const out = io()
    expect(await serverCommand(['status', ...folder()], out)).toBe(0)
    const text = out.out.join('')
    expect(text).toContain('Local API Server is running')
    expect(text).toContain(`127.0.0.1:${state.port}/v1`)
    expect(text).toContain('none loaded')
  })

  it('exits 1 when nothing answers, and says where it looked', async () => {
    const out = io()
    expect(await serverCommand(['status', ...folder(), '--port', '1'], out)).toBe(1)
    expect(out.out.join('')).toContain('No Local API Server at http://127.0.0.1:1/v1')
  })

  it('falls back to the app state file when no core is running', async () => {
    await writeFile(
      data.layout.serverStateFile,
      JSON.stringify({
        running: true,
        host: '0.0.0.0',
        port: 4321,
        prefix: '/v1',
        requires_api_key: true,
        pid: 5,
      })
    )
    const out = io()
    expect(await serverCommand(['status', '--json', ...folder()], out)).toBe(1)
    expect(JSON.parse(out.out.join(''))).toMatchObject({
      running: false,
      url: 'http://127.0.0.1:4321/v1',
      requires_api_key: true,
      models: null,
      models_error: 'server not reachable',
    })
  })

  it('rejects an unknown subcommand', async () => {
    const out = io()
    expect(await serverCommand(['restart', ...folder()], out)).toBe(2)
  })
})

describe('shutdown', () => {
  it('stops a running core and is a no-op when none is running', async () => {
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    const out = io()
    expect(await shutdownCommand(folder(), out)).toBe(0)
    expect(out.out.join('')).toContain('Core is stopping')
    await waitFor(async () =>
      (await import('../lock/index.js')).inspectLock(data.layout).then((s) => s.kind === 'free')
    )
    void core

    const second = io()
    expect(await shutdownCommand(folder(), second)).toBe(0)
    expect(second.out.join('')).toContain('No core is running')
  })
})

describe('daemon and serve compatibility', () => {
  it('starts an optional public listener from daemon flags before shutting down cleanly', async () => {
    const out = io()
    expect(
      await daemonCommand(
        [
          ...folder(),
          '--control-host',
          '127.0.0.1',
          '--control-port',
          '0',
          '--public-host',
          '127.0.0.1',
          '--public-port',
          '0',
          '--api-key',
          'k',
          '--verbose',
        ],
        out
      )
    ).toBe(0)
    expect(JSON.parse(out.out[0] as string)).toMatchObject({ event: 'core:ready' })
    expect(out.err.join('')).toContain('public API')
  })

  it('downloads an HF GGUF before asking the owner to load it', async () => {
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    cores.push(core)
    const bytes = Buffer.from('downloaded gguf')
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const out = recordingIo({
      env: { HF_TOKEN: 'token' },
      select: async () => 1,
      fetch: async (input, init) => {
        const request = new Request(input, init)
        if (request.url.includes('/api/models/')) {
          expect(request.headers.get('authorization')).toBe('Bearer token')
          return Response.json({
            siblings: [
              { rfilename: 'tiny.Q2.gguf', lfs: { size: bytes.length - 1 } },
              { rfilename: 'chosen.Q4_K_XL.gguf', lfs: { size: bytes.length, sha256 } },
            ],
          })
        }
        return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
      },
    })
    await expect(serveCommand(['owner/repo', '--select', ...folder()], out)).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
    expect(await core.registry().find('owner/repo')).toMatchObject({
      yml: { model_path: 'llamacpp/models/owner/repo/chosen.Q4_K_XL.gguf' },
    })
    expect(out.err.join('')).toContain('Downloaded owner/repo')
  })

  it('selects an installed model and validates numeric serve flags before owner mutation', async () => {
    await data.writeModel('a')
    await data.writeModel('b')
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    cores.push(core)
    const selected = recordingIo({ select: async () => 1 })
    await expect(serveCommand([...folder()], selected)).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
    await core.registry().remove('b')
    const only = io()
    await expect(serveCommand([...folder()], only)).rejects.toMatchObject({ code: 'BINARY_NOT_FOUND' })
    expect(only.err.join('')).toContain('Using model a')
    await writeFile(`${data.root}/direct.gguf`, Buffer.alloc(16, 0x47))
    await writeFile(`${data.root}/mmproj.gguf`, Buffer.alloc(16, 0x47))
    await expect(
      serveCommand(
        [
          '--model-path',
          'direct.gguf',
          '--mmproj',
          'mmproj.gguf',
          '--bin',
          'missing-llama-server',
          '--embedding',
          ...folder(),
        ],
        recordingIo({ cwd: data.root })
      )
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
    await expect(serveCommand(['a', '--timeout', '0', ...folder()], io())).rejects.toThrow(/--timeout/)
    await expect(serveCommand(['a', '--port', '70000', ...folder()], io())).rejects.toThrow(/--port/)
  })
})

describe('url helpers', () => {
  it('dials loopback for a server bound to every interface', () => {
    const state = {
      running: true,
      host: '0.0.0.0',
      port: 1337,
      prefix: '/v1',
      requires_api_key: false,
      pid: 1,
    }
    expect(baseUrl(state)).toBe('http://127.0.0.1:1337')
    expect(apiUrl(state)).toBe('http://127.0.0.1:1337/v1')
    expect(apiUrl({ ...state, host: '192.168.1.5', prefix: '' })).toBe('http://192.168.1.5:1337')
  })

  it('formats sizes the way the table expects', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(3_221_225_472)).toBe('3.0 GB')
  })
})

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((r) => setTimeout(r, 25))
  }
}
