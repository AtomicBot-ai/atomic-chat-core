/**
 * Live checks against a real `llama-server` and a real GGUF (PLAN.md §5.1 "Live"). Everything else
 * in the suite runs against the fake backend, which proves the core's own logic but cannot prove the
 * argv we emit is accepted by llama.cpp, or that a real model loads and answers.
 *
 * Opt in with:
 *   ATOMIC_LIVE=1
 *   ATOMIC_LIVE_UPSTREAM_BIN=/path/to/llama-server
 *   ATOMIC_LIVE_UPSTREAM_MODEL=/path/to/tiny-model.gguf   (a few MB is enough)
 *
 * On Windows this is the *only* coverage of the spawn-a-backend path, because a shell-script fake
 * cannot be named `llama-server.exe`; CI therefore runs it there with a small GGUF.
 */
import { cp, mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTmpDataFolder } from '../helpers/tmp-data-folder.js'
import type { TmpDataFolder } from '../helpers/tmp-data-folder.js'
import { AtomicCore } from '../../src/core/index.js'
import { llamaServerExeName } from '../../src/config/index.js'

const BIN = process.env['ATOMIC_LIVE_UPSTREAM_BIN'] ?? ''
const MODEL = process.env['ATOMIC_LIVE_UPSTREAM_MODEL'] ?? ''
const ENABLED = process.env['ATOMIC_LIVE'] === '1' && BIN !== '' && MODEL !== ''

let data: TmpDataFolder
let core: AtomicCore

describe.skipIf(!ENABLED)('a real llama.cpp backend', () => {
  beforeAll(async () => {
    data = await makeTmpDataFolder('atomic-core-live-')
    // Install the real build as a backend pack, so resolution, argv and env are the production path.
    // The whole directory comes along: llama-server links against the ggml shared libraries beside
    // it, and a lone executable dies in the dynamic loader before it prints anything.
    const packDir = join(
      data.layout.provider('llamacpp-upstream').backendsDir,
      'b6325',
      'live',
      'build',
      'bin'
    )
    await mkdir(packDir, { recursive: true })
    await cp(dirname(BIN), packDir, { recursive: true })
    const packBin = join(packDir, llamaServerExeName(process.platform))
    if (process.platform !== 'win32') {
      const { chmod } = await import('node:fs/promises')
      await chmod(packBin, 0o755)
    }
    const modelDir = join(data.layout.provider('llamacpp-upstream').modelsDir, 'live')
    await mkdir(modelDir, { recursive: true })
    const size = (await stat(MODEL)).size
    await writeFile(
      join(modelDir, 'model.yml'),
      `model_path: ${MODEL.split('\\').join('/')}\nname: live\nsize_bytes: ${size}\nmodel_size_bytes: ${size}\n`
    )
    core = await AtomicCore.create({ dataFolder: data.root, controlPort: 0 })
  }, 120_000)

  afterAll(async () => {
    await core?.shutdown()
    await data?.cleanup()
  })

  it('loads the model, answers a completion and unloads', async () => {
    const session = await core.load('llamacpp-upstream', 'live', { overrides: { ctx_size: 512 } })
    expect(session.pid).toBeGreaterThan(0)
    expect(session.port).toBeGreaterThan(0)

    const health = await fetch(`http://127.0.0.1:${session.port}/health`)
    expect(health.ok).toBe(true)

    const state = await core.startPublicServer({ port: 0 })
    const answer = await fetch(`http://127.0.0.1:${state.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'live',
        max_tokens: 8,
        messages: [{ role: 'user', content: 'Say hi.' }],
      }),
    })
    expect(answer.status).toBe(200)
    const body = (await answer.json()) as { choices: Array<{ message: { content: string } }> }
    expect(typeof body.choices[0]?.message.content).toBe('string')

    const device = core.llamacpp().getRuntimeDeviceInfo('live')
    expect(device, 'the device log lines must parse against a real backend').toBeDefined()

    expect(await core.unload('llamacpp-upstream', 'live')).toEqual({ success: true })
  }, 300_000)

  it('reports the devices the real backend sees', async () => {
    const exe = join(
      data.layout.provider('llamacpp-upstream').backendsDir,
      'b6325',
      'live',
      'build',
      'bin',
      llamaServerExeName(process.platform)
    )
    const devices = await core.llamacpp().getDevices(exe)
    expect(Array.isArray(devices)).toBe(true)
    for (const device of devices) {
      expect(device.id.length).toBeGreaterThan(0)
      expect(device.mem).toBeGreaterThanOrEqual(0)
    }
  }, 60_000)
})
