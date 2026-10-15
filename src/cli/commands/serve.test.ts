import { mkdir, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeFakeSidecarBinary } from '../../../test/helpers/fake-sidecar-server.js'
import { makeTmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../../../test/helpers/tmp-data-folder.js'
import { AtomicCore } from '../../core/index.js'
import { inspectLock } from '../../lock/index.js'
import { ModelRegistry } from '../../models/index.js'
import { recordingIo } from '../io.js'
import { runCli } from '../main.js'
import { serveAttachOptions, serveCommand } from './serve.js'

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

describe('daemon and serve compatibility', () => {
  it('refuses a Hub repository that is not on disk, without a network request or an owner', async () => {
    const ioFetch = vi.fn(async () => new Response('unexpected', { status: 500 }))
    const globalFetch = vi.spyOn(globalThis, 'fetch')
    try {
      const out = recordingIo({ env: { HF_TOKEN: 'token' }, fetch: ioFetch as unknown as typeof fetch })
      // `--select` chose what to download; an old script that still passes it gets the same answer.
      expect(await runCli(['serve', 'owner/repo', '--select', '--port', '0', ...folder()], out)).not.toBe(0)
      const stderr = out.err.join('')
      expect(stderr).toContain('owner/repo is not on disk')
      expect(stderr).toContain('Download the model first')
      expect(stderr).toContain('[MODEL_NOT_FOUND]')
      expect(ioFetch).not.toHaveBeenCalled()
      expect(globalFetch).not.toHaveBeenCalled()
      // Refused before an owner was started for it.
      expect(await inspectLock(data.layout)).toEqual({ kind: 'free' })
      expect(await new ModelRegistry(data.layout, 'llamacpp-upstream').find('owner/repo')).toBeUndefined()
    } finally {
      globalFetch.mockRestore()
    }
  })

  it('selects an installed model and validates numeric serve flags before owner mutation', async () => {
    await data.writeModel('a')
    await data.writeModel('b')
    const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
    cores.push(core)
    const selected = recordingIo({ select: async () => 1 })
    await expect(serveCommand(['--port', '0', ...folder()], selected)).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
    await core.registry().remove('b')
    const only = io()
    await expect(serveCommand(['--port', '0', ...folder()], only)).rejects.toMatchObject({
      code: 'BINARY_NOT_FOUND',
    })
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
          '--port',
          '0',
          ...folder(),
        ],
        recordingIo({ cwd: data.root })
      )
    ).rejects.toMatchObject({ code: 'IO_ERROR' })
    await expect(serveCommand(['a', '--timeout', '0', ...folder()], io())).rejects.toThrow(/--timeout/)
    await expect(serveCommand(['a', '--port', '70000', ...folder()], io())).rejects.toThrow(/--port/)
  })
})

describe('serve --provider mlx|foundation-models', () => {
  it('refuses an unknown provider and a Foundation Models serve without its server', async () => {
    await expect(serveCommand(['--provider', 'ollama', ...folder()], io())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: '--provider must be one of: llamacpp-upstream, mlx, foundation-models.',
    })
    await expect(serveCommand(['--provider', 'foundation-models', ...folder()], io())).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('--resources-dir'),
    })
  })

  it.skipIf(process.platform === 'win32')(
    'serves an installed MLX model from the resources folder with a pinned context',
    async () => {
      const resources = `${data.root}/resources`
      await writeFakeSidecarBinary(resources, 'mlx-server', { kind: 'mlx' })
      await mkdir(`${data.root}/mlx/models/qwen`, { recursive: true })
      await writeFile(`${data.root}/mlx/models/qwen/model.safetensors`, 'w')
      const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, platform: 'darwin' })
      cores.push(core)
      await core
        .registry('mlx')
        .write('qwen', { model_path: 'mlx/models/qwen/model.safetensors', name: 'qwen', size_bytes: 1 })
      await expect(serveCommand(['--provider', 'mlx', ...folder()], io())).rejects.toMatchObject({
        message: expect.stringContaining('MLX needs --resources-dir'),
      })
      const out = io()
      expect(
        await serveCommand(
          [
            '--provider',
            'mlx',
            '--resources-dir',
            resources,
            '--ctx-size',
            '2048',
            '--port',
            '0',
            ...folder(),
          ],
          out
        )
      ).toBe(0)
      expect(out.err.join('')).toContain('Using model qwen')
      expect(out.out.join('')).toContain('qwen is serving at http://127.0.0.1:')
      expect(
        (core.runtime('mlx') as unknown as { getCtxSize: (id: string) => number }).getCtxSize('qwen')
      ).toBe(2048)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'starts the on-device model from the resources folder and prints where it runs',
    async () => {
      const resources = `${data.root}/resources`
      await writeFakeSidecarBinary(resources, 'foundation-models-server', { kind: 'fm' })
      const core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0, platform: 'darwin' })
      cores.push(core)
      const out = io()
      expect(
        await serveCommand(
          [
            '--provider',
            'foundation-models',
            '--resources-dir',
            resources,
            '--port',
            '0',
            '--json',
            ...folder(),
          ],
          out
        )
      ).toBe(0)
      const printed = JSON.parse(out.out.join('')) as { session: { model_id: string; port: number } }
      expect(printed.session.model_id).toBe('apple/on-device')
      expect(core.sessions()).toMatchObject([{ provider: 'foundation-models', model_id: 'apple/on-device' }])
      const text = io()
      expect(
        await serveCommand(
          ['--provider', 'foundation-models', '--resources-dir', resources, '--port', '0', ...folder()],
          text
        )
      ).toBe(0)
      expect(text.out.join('')).toContain(`apple/on-device is running on port ${printed.session.port}`)
    }
  )
})

describe('serve attach options', () => {
  it('launches an owner when none runs and reports owner trouble on stderr', () => {
    const out = io()
    const options = serveAttachOptions(data.layout, out)
    expect(options).toMatchObject({ layout: data.layout, clientName: 'atomic-chat-core serve', launch: true })
    options.log('client heartbeat failed')
    expect(out.err).toEqual(['client heartbeat failed\n'])
  })
})
